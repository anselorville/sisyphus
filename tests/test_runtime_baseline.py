import sys


def test_python_runtime_is_supported() -> None:
    assert sys.version_info >= (3, 11)
