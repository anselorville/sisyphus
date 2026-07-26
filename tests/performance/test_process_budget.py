import os

import psutil


def process_rss_bytes(pid: int) -> int:
    return psutil.Process(pid).memory_info().rss


def test_current_process_rss_probe_returns_positive_value() -> None:
    assert process_rss_bytes(os.getpid()) > 0
