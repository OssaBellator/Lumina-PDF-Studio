#!/usr/bin/env python3
"""Regression tests for expected HTTP client disconnect handling."""
from __future__ import annotations

import errno
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server_v4


class WindowsSocketError(OSError):
    def __init__(self, winerror: int) -> None:
        super().__init__(winerror, "simulated Windows socket error")
        self.winerror = winerror


def main() -> None:
    expected = [
        BrokenPipeError(),
        ConnectionResetError(),
        ConnectionAbortedError(),
        OSError(errno.EPIPE, "broken pipe"),
        OSError(errno.ECONNRESET, "reset"),
        OSError(errno.ECONNABORTED, "aborted"),
        WindowsSocketError(10053),
        WindowsSocketError(10054),
        WindowsSocketError(10058),
    ]
    for error in expected:
        assert server_v4.is_client_disconnect_error(error), repr(error)

    unexpected = [
        ValueError("not a socket error"),
        OSError(errno.EACCES, "permission denied"),
        WindowsSocketError(10061),
    ]
    for error in unexpected:
        assert not server_v4.is_client_disconnect_error(error), repr(error)

    print("Lumina client disconnect tests passed.")


if __name__ == "__main__":
    main()
