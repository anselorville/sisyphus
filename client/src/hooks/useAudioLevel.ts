import { useEffect, useState } from "react";

// Unmeasured placeholder -- tune against a real microphone (RMS values from
// typical speech are quiet relative to the 0-1 byte range AnalyserNode uses).
const GAIN = 4;

// Levels are rounded to this step before being stored, so a steady signal
// doesn't re-render the consumer on every animation frame.
const LEVEL_STEP = 0.02;

/**
 * Live 0-1 loudness of an audio stream: the local mic, or the agent's
 * remote track (which must also be playing through a media element for the
 * browser to deliver its samples).
 */
export function useAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return;
    }

    const audioContext = new AudioContext();
    // Created outside the click that started the call, so it may begin
    // suspended; the page already has user activation by now.
    void audioContext.resume().catch(() => {});
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let rafId: number;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      setLevel(Math.round(Math.min(1, rms * GAIN) / LEVEL_STEP) * LEVEL_STEP);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close();
    };
  }, [stream]);

  return level;
}
