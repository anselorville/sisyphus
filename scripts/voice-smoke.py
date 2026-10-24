#!/usr/bin/env python3
"""Full-stack voice smoke test: a scripted WebRTC "user" talks to Marcus.

Connects to the running backend exactly the way the browser client does
(POST /api/offer, a mic track, the "transcript" data channel), plays one
spoken utterance into the microphone track, then listens. It exercises the
real chain end to end -- VAD -> STT -> sidecar -> LLM -> TTS -> audio back --
with real providers, so it spends a little API quota.

It cannot judge how the conversation *feels*; use it to prove the chain is
alive and to put real turns into the HCI event log
(scripts/query-hci-events.sh --latency).

    scripts/start.sh                       # bring the stack up first
    uv run python scripts/voice-smoke.py   # default: say a Chinese greeting
    uv run python scripts/voice-smoke.py --text "今天几号?" --voice Tingting
    uv run python scripts/voice-smoke.py --wav my-question.wav
    uv run python scripts/voice-smoke.py --barge-in   # interrupt the reply

Exit status is 0 only when the user's speech was transcribed, the agent
answered with a task result, and audio came back.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from fractions import Fraction
from pathlib import Path

import av
import httpx
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame

SAMPLE_RATE = 48_000
FRAME_SAMPLES = 960  # 20 ms
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
# Below this RMS (int16 scale) a received frame counts as silence.
AUDIO_RMS_THRESHOLD = 300.0
DEFAULT_TEXT = "你好，请用一句话介绍你自己。"


def load_pcm(path: Path) -> np.ndarray:
    """Decode any audio file to mono int16 at 48 kHz."""
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise SystemExit(f"no audio decoded from {path}")
    return np.concatenate(chunks).astype(np.int16)


def synthesize(text: str, voice: str, out_dir: Path) -> Path:
    if sys.platform != "darwin" or shutil.which("say") is None:
        raise SystemExit("--text needs macOS `say`; pass --wav with a recording instead.")
    target = out_dir / "utterance.wav"
    subprocess.run(
        ["say", "-v", voice, "-o", str(target), "--file-format=WAVE", f"--data-format=LEI16@{SAMPLE_RATE}", text],
        check=True,
    )
    return target


class ScriptedMic(MediaStreamTrack):
    """A microphone that plays queued PCM in real time and is silent otherwise."""

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        self._queue: list[np.ndarray] = []
        self._cursor = 0
        self._pts = 0
        self._started_at: float | None = None
        self.speech_started_at: float | None = None
        self.speech_ended_at: float | None = None

    def say(self, pcm: np.ndarray) -> None:
        self._queue.append(pcm)

    @property
    def speaking(self) -> bool:
        return bool(self._queue)

    async def recv(self) -> AudioFrame:
        if self._started_at is None:
            self._started_at = time.monotonic()
        # Pace frames in real time so the server's VAD sees realistic audio.
        target = self._started_at + self._pts / SAMPLE_RATE
        delay = target - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

        samples = np.zeros(FRAME_SAMPLES, dtype=np.int16)
        if self._queue:
            current = self._queue[0]
            chunk = current[self._cursor : self._cursor + FRAME_SAMPLES]
            samples[: len(chunk)] = chunk
            if self.speech_started_at is None or self.speech_ended_at is not None:
                self.speech_started_at = time.monotonic()
                self.speech_ended_at = None
            self._cursor += FRAME_SAMPLES
            if self._cursor >= len(current):
                self._queue.pop(0)
                self._cursor = 0
                if not self._queue:
                    self.speech_ended_at = time.monotonic()

        frame = AudioFrame.from_ndarray(samples.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = Fraction(1, SAMPLE_RATE)
        self._pts += FRAME_SAMPLES
        return frame


class Session:
    def __init__(self, args: argparse.Namespace, pcm: np.ndarray) -> None:
        self.args = args
        self.pcm = pcm
        self.mic = ScriptedMic()
        self.pc = RTCPeerConnection()
        self.t0 = time.monotonic()
        self.messages: list[tuple[float, dict]] = []
        self.audio_active_at: list[float] = []  # times at which loud bot audio was seen
        self.frames_received = 0
        self.peak_rms = 0.0
        self.audio_error: str | None = None
        self.channel = None

    def now(self) -> float:
        return time.monotonic() - self.t0

    async def _consume_audio(self, track: MediaStreamTrack) -> None:
        try:
            while True:
                frame = await track.recv()
                self.frames_received += 1
                samples = frame.to_ndarray().astype(np.float64)
                rms = math.sqrt(float(np.mean(samples**2))) if samples.size else 0.0
                self.peak_rms = max(self.peak_rms, rms)
                if rms >= AUDIO_RMS_THRESHOLD:
                    self.audio_active_at.append(self.now())
        except Exception as exc:  # the track ending is normal at teardown
            self.audio_error = f"{type(exc).__name__}: {exc}"

    async def connect(self) -> None:
        pc = self.pc
        pc.addTrack(self.mic)
        self.channel = pc.createDataChannel("transcript")

        @self.channel.on("message")
        def _on_message(raw: object) -> None:
            if not isinstance(raw, str):
                return
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return
            if isinstance(parsed, dict):
                self.messages.append((self.now(), parsed))

        @pc.on("track")
        def _on_track(track: MediaStreamTrack) -> None:
            if track.kind == "audio":
                asyncio.ensure_future(self._consume_audio(track))

        await pc.setLocalDescription(await pc.createOffer())
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.args.server}/api/offer",
                json={"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
            )
            response.raise_for_status()
            answer = response.json()
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))

    def _send_mic(self, open_: bool) -> None:
        if self.channel is not None and self.channel.readyState == "open":
            self.channel.send(json.dumps({"type": "mic", "open": open_}))

    def reply_audio_finished(self, since: float) -> bool:
        heard = [t for t in self.audio_active_at if t > since]
        return bool(heard) and self.now() - heard[-1] >= self.args.tail

    def of_type(self, event_type: str) -> list[tuple[float, dict]]:
        return [(t, m) for t, m in self.messages if m.get("type") == event_type]

    async def wait_for(self, predicate, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.05)
        return predicate()

    async def run(self, manual_turns: bool) -> dict:
        await self.connect()
        if not await self.wait_for(lambda: self.channel is not None and self.channel.readyState == "open", 15):
            raise SystemExit("data channel never opened -- is the backend up (scripts/start.sh)?")
        await asyncio.sleep(self.args.settle)  # let the pipeline come up

        if manual_turns:
            self._send_mic(True)
        self.mic.say(self.pcm)
        await self.wait_for(lambda: not self.mic.speaking, 60)
        spoke_until = self.now()
        if manual_turns:
            await asyncio.sleep(0.4)
            self._send_mic(False)

        barged_at: float | None = None
        if self.args.barge_in:
            # Wait for the reply to start, then talk over it.
            started = await self.wait_for(lambda: any(t > spoke_until for t in self.audio_active_at), self.args.timeout)
            if started:
                await asyncio.sleep(0.8)
                barged_at = self.now()
                if manual_turns:
                    self._send_mic(True)
                self.mic.say(self.pcm)
                await self.wait_for(lambda: not self.mic.speaking, 60)
                if manual_turns:
                    await asyncio.sleep(0.4)
                    self._send_mic(False)

        wanted = 2 if barged_at is not None else 1
        done = await self.wait_for(
            lambda: len(self.of_type("task.completed")) + len(self.of_type("task.failed")) >= wanted,
            self.args.timeout,
        )
        # Synthesis lags the text (a sentence can take several seconds), so the
        # spoken answer keeps arriving well after the task is done: wait until
        # reply audio has been heard and then gone quiet for `--tail` seconds.
        await self.wait_for(lambda: self.reply_audio_finished(spoke_until), self.args.audio_timeout)
        await self.pc.close()
        return self.report(spoke_until, barged_at, done)

    def audio_segments(self, since: float, gap: float = 0.6) -> list[list[float]]:
        """Bursts of reply audio as [start, end] seconds after the user stopped talking."""
        segments: list[list[float]] = []
        for t in (t for t in self.audio_active_at if t > since):
            if segments and t - segments[-1][1] <= gap:
                segments[-1][1] = t
            else:
                segments.append([t, t])
        return [[round(a - since, 1), round(b - since, 1)] for a, b in segments]

    def report(self, spoke_until: float, barged_at: float | None, done: bool) -> dict:
        transcripts = [m.get("text", "") for _t, m in self.of_type("user.transcript")]
        agent_lines = [m.get("text", "") for _t, m in self.of_type("agent.transcript")]
        completed = self.of_type("task.completed")
        failed = self.of_type("task.failed")
        first_reply_audio = next((t for t in self.audio_active_at if t > spoke_until), None)
        first_agent_text = next((t for t, _m in self.of_type("agent.transcript")), None)
        total_audio = len(self.audio_active_at) * FRAME_SECONDS
        return {
            "user_transcripts": transcripts,
            "agent_transcript_lines": agent_lines,
            "task_completed": len(completed),
            "task_failed": len(failed),
            "reply_audio_seconds": round(total_audio, 2),
            "audio_frames_received": self.frames_received,
            "audio_peak_rms": round(self.peak_rms, 1),
            "audio_track_error": self.audio_error,
            "speech_end_to_first_agent_text_s": None if first_agent_text is None else round(first_agent_text - spoke_until, 2),
            "speech_end_to_first_reply_audio_s": None if first_reply_audio is None else round(first_reply_audio - spoke_until, 2),
            "reply_audio_segments_s": self.audio_segments(spoke_until),
            "barge_in_sent_at_s": None if barged_at is None else round(barged_at - spoke_until, 2),
            "completed_before_timeout": done,
            "ok": bool(transcripts and completed and total_audio > 0.3),
        }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default="http://localhost:7860", help="backend base URL")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="what the scripted user says (needs macOS `say`)")
    parser.add_argument("--voice", default="Tingting", help="macOS voice for --text")
    parser.add_argument("--wav", type=Path, help="use this recording instead of synthesizing --text")
    parser.add_argument("--timeout", type=float, default=60.0, help="seconds to wait for the agent to finish")
    parser.add_argument("--settle", type=float, default=1.5, help="seconds to wait after connecting before speaking")
    parser.add_argument("--tail", type=float, default=3.0, help="seconds of quiet after the reply audio that end the call")
    parser.add_argument("--audio-timeout", type=float, default=40.0, help="max seconds to wait for the spoken reply to finish")
    parser.add_argument("--barge-in", action="store_true", help="talk over the reply once it starts")
    args = parser.parse_args()

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            status = (await client.get(f"{args.server}/api/status")).json()
        except Exception as exc:
            print(f"backend not reachable at {args.server}: {exc}\nStart it with scripts/start.sh", file=sys.stderr)
            return 2
    manual_turns = status.get("turn_mode") == "manual"
    print(f"backend: stt={status.get('stt_provider')} tts={status.get('tts_provider')} turn_mode={status.get('turn_mode')}")

    with tempfile.TemporaryDirectory() as tmp:
        wav = args.wav or synthesize(args.text, args.voice, Path(tmp))
        pcm = load_pcm(wav)
        print(f"utterance: {len(pcm) / SAMPLE_RATE:.1f}s of audio")
        result = await Session(args, pcm).run(manual_turns)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
