#!/usr/bin/env python3
"""Setup check for Marcus: is this machine ready to run the stack?

    uv run python scripts/doctor.py          # offline checks only
    uv run python scripts/doctor.py --live   # also probe providers over the network

It reads the same configuration the app does (`.env`, `model_providers.json`),
so it checks the providers you have actually selected, not a fixed list. It
never prints a key's value. Exit status is 1 when something Marcus cannot run
without is missing, 0 otherwise (warnings do not fail it).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

OK, WARN, FAIL = "ok", "warn", "FAIL"
ICON = {OK: "✓", WARN: "!", FAIL: "✗"}

# provider id -> (human label, env var that must be set). None = needs no key.
ASR_KEYS = {
    "zhipu": ("Zhipu GLM ASR", "GLM_API_KEY"),
    "assemblyai": ("AssemblyAI", "ASSEMBLYAI_API_KEY"),
    "deepgram": ("Deepgram", "DEEPGRAM_API_KEY"),
    "openrouter": ("OpenRouter ASR", "OPENROUTER_API_KEY"),
}
TTS_KEYS = {
    "minimax": ("MiniMax TTS", "MINIMAX_API_KEY"),
    "cartesia": ("Cartesia TTS", "CARTESIA_API_KEY"),
    "openrouter": ("OpenRouter TTS", "OPENROUTER_API_KEY"),
    "edge_tts": ("Edge TTS", None),
    "VoxCPM2-CUDA": ("VoxCPM2-CUDA TTS", "VOXCPM2_CUDA_BASE_URL"),
}
LLM_KEYS = {
    "deepseek": ("DeepSeek", "DEEPSEEK_API_KEY"),
    "anthropic": ("Anthropic", "ANTHROPIC_API_KEY"),
    "openrouter": ("OpenRouter", "OPENROUTER_API_KEY"),
    "openai": ("OpenAI", "OPENAI_API_KEY"),
}
PORTS = {"sidecar": 8765, "backend": 7860, "frontend": 1420}


@dataclass
class Check:
    status: str
    name: str
    detail: str = ""


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    return values


def required_keys(asr: str | None, tts: str | None, llm: str | None) -> list[tuple[str, str | None, str]]:
    """(label, env var or None, role in the product) for the selected providers."""
    needs: list[tuple[str, str | None, str]] = []
    for table, provider, role in ((ASR_KEYS, asr, "speech recognition"), (TTS_KEYS, tts, "speech output"), (LLM_KEYS, llm, "reasoning")):
        if provider is None:
            continue
        label, env = table.get(provider, (provider, None))
        needs.append((label, env, role))
    return needs


def selected_providers(env: dict[str, str]) -> tuple[str, str, str]:
    """ASR / TTS / LLM provider ids, defaulting exactly as the app does."""
    asr, tts = "zhipu", "minimax"
    path = Path(os.environ.get("MODEL_PROVIDERS_PATH", REPO_ROOT / "model_providers.json"))
    if path.is_file():
        cloud = json.loads(path.read_text()).get("cloud", {})
        asr = (cloud.get("transcription") or {}).get("provider") or asr
        tts = (cloud.get("speech") or {}).get("provider") or tts
    fast = env.get("AGENT_RUNTIME_MODEL_FAST", "deepseek:deepseek-flash")
    return asr, tts, fast.split(":", 1)[0]


def check_tooling() -> list[Check]:
    checks: list[Check] = []
    for tool, required in (("uv", True), ("node", True), ("npm", True), ("sqlite3", False)):
        found = shutil.which(tool)
        checks.append(Check(OK if found else (FAIL if required else WARN), f"{tool} installed", found or "not on PATH"))
    node = shutil.which("node")
    if node:
        try:
            wanted = json.loads((REPO_ROOT / "agent-runtime/package.json").read_text())["engines"]["node"].lstrip(">=")
            have = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v")
            ok = tuple(int(x) for x in have.split(".")[:3]) >= tuple(int(x) for x in wanted.split(".")[:3])
            checks.append(Check(OK if ok else FAIL, "node version", f"{have} (needs >= {wanted})"))
        except Exception as exc:  # unreadable engines field is not fatal
            checks.append(Check(WARN, "node version", f"could not verify: {exc}"))
    return checks


def check_build() -> Check:
    dist = REPO_ROOT / "agent-runtime/dist/index.js"
    if not dist.is_file():
        return Check(WARN, "sidecar build", "missing -- scripts/start.sh builds it on first run")
    built = dist.stat().st_mtime
    sources = [*(REPO_ROOT / "agent-runtime/src").rglob("*.ts"), REPO_ROOT / "agent-runtime/package.json"]
    stale = [p for p in sources if p.stat().st_mtime > built]
    if stale:
        return Check(WARN, "sidecar build", f"older than {len(stale)} source file(s) -- scripts/start.sh rebuilds it")
    return Check(OK, "sidecar build", "up to date")


def check_env_file(env: dict[str, str]) -> list[Check]:
    if not (REPO_ROOT / ".env").is_file():
        return [Check(FAIL, ".env present", "copy .env.example to .env and fill in your keys")]
    asr, tts, llm = selected_providers(env)
    checks = [Check(OK, ".env present", f"speech in: {asr}, speech out: {tts}, reasoning: {llm}")]
    for label, var, role in required_keys(asr, tts, llm):
        if var is None:
            checks.append(Check(OK, f"{label} ({role})", "no key needed"))
        elif env.get(var) or os.environ.get(var):
            checks.append(Check(OK, f"{label} ({role})", f"{var} is set"))
        else:
            checks.append(Check(FAIL, f"{label} ({role})", f"{var} is empty in .env"))
    # Web search: any provider with a key counts; more than one makes the chain a real fallback.
    search_keys = {
        "deepseek": "DEEPSEEK_API_KEY",
        "brave": "BRAVE_SEARCH_API_KEY",
        "tavily": "TAVILY_API_KEY",
        "glm": "GLM_API_KEY",
    }
    have = [name for name, var in search_keys.items() if env.get(var) or os.environ.get(var)]
    if not have:
        checks.append(Check(WARN, "web search", "no search key set (DEEPSEEK/BRAVE_SEARCH/TAVILY/GLM) -- Marcus cannot search the web"))
    elif len(have) == 1:
        checks.append(Check(WARN, "web search", f"only {have[0]} configured -- no fallback if it fails"))
    else:
        checks.append(Check(OK, "web search", f"{len(have)} providers with a key: {', '.join(have)}"))
    return checks


def port_in_use(port: int) -> bool:
    """Whether anything listens on `port`, on IPv4 or IPv6 loopback (Vite binds ::1 only)."""
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family) as sock:
                sock.settimeout(0.3)
                if sock.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            continue
    return False


def check_ports() -> list[Check]:
    return [
        Check(OK, f"port {port} ({name})", "in use -- the stack may already be running" if port_in_use(port) else "free")
        for name, port in PORTS.items()
    ]


async def live_checks(env: dict[str, str]) -> list[Check]:
    import httpx

    checks: list[Check] = []
    key = env.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    wanted = env.get("AGENT_RUNTIME_MODEL_FAST", "deepseek:deepseek-flash").split(":", 1)[-1]
    if key:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.get("https://api.deepseek.com/models", headers={"Authorization": f"Bearer {key}"})
            if response.status_code != 200:
                checks.append(Check(FAIL, "DeepSeek key", f"HTTP {response.status_code}"))
            else:
                models = [m["id"] for m in response.json().get("data", [])]
                checks.append(Check(OK if wanted in models else WARN, f"DeepSeek model {wanted}", "listed" if wanted in models else f"not in {models}"))
        except Exception as exc:
            checks.append(Check(WARN, "DeepSeek reachable", str(exc)))
    key = env.get("MINIMAX_API_KEY") or os.environ.get("MINIMAX_API_KEY")
    if key:
        try:
            import websockets

            async with websockets.connect("wss://api.minimaxi.com/ws/v1/t2a_v2", additional_headers={"Authorization": f"Bearer {key}"}, open_timeout=15) as ws:
                first = json.loads(await asyncio.wait_for(ws.recv(), 15))
            checks.append(Check(OK if first.get("event") == "connected_success" else FAIL, "MiniMax key", first.get("event", "no event")))
        except Exception as exc:
            checks.append(Check(FAIL, "MiniMax key", f"{type(exc).__name__}: {exc}"))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="also probe providers over the network (free calls)")
    args = parser.parse_args()
    env = load_env(REPO_ROOT / ".env")

    checks = [*check_tooling(), check_build(), *check_env_file(env), *check_ports()]
    if args.live:
        checks.extend(asyncio.run(live_checks(env)))
    for check in checks:
        print(f"  {ICON[check.status]} {check.name}" + (f" -- {check.detail}" if check.detail else ""))
    failed = [c for c in checks if c.status == FAIL]
    print(f"\n{len(failed)} blocking problem(s)." if failed else "\nReady: scripts/start.sh, then open http://localhost:1420.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
