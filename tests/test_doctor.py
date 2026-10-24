import importlib.util
import socket
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "doctor.py"
spec = importlib.util.spec_from_file_location("doctor", SCRIPT)
doctor = importlib.util.module_from_spec(spec)
sys.modules["doctor"] = doctor
spec.loader.exec_module(doctor)


def test_required_keys_follow_the_selected_providers() -> None:
    needs = doctor.required_keys("zhipu", "minimax", "deepseek")

    assert [(label, env) for label, env, _role in needs] == [
        ("Zhipu GLM ASR", "GLM_API_KEY"),
        ("MiniMax TTS", "MINIMAX_API_KEY"),
        ("DeepSeek", "DEEPSEEK_API_KEY"),
    ]


def test_a_keyless_provider_needs_no_env_var() -> None:
    needs = doctor.required_keys("zhipu", "edge_tts", "deepseek")

    assert ("Edge TTS", None, "speech output") in needs


def test_parses_env_files_without_exposing_comments() -> None:
    parsed = doctor.load_env(Path(__file__).parent / "nonexistent.env")
    assert parsed == {}


def test_port_probe_sees_ipv4_and_ipv6_listeners() -> None:
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            server = socket.socket(family)
            server.bind((host, 0))
        except OSError:
            continue  # this machine has no such loopback
        with server:
            server.listen()
            assert doctor.port_in_use(server.getsockname()[1])
