#!/usr/bin/env python3
"""Lumina server entry point with quiet client-disconnect handling.

Browsers, antivirus scanners, and development proxies may close a static-file
connection before Python finishes writing it. On Windows this commonly appears
as WinError 10053 or 10054. These are expected transport disconnects, not PDF
engine failures, so the handler closes the connection without printing a full
thread traceback.
"""
from __future__ import annotations

import argparse
import errno
import mimetypes
from http.server import ThreadingHTTPServer
from typing import Any

import server as core
import server_v3 as rich

ENGINE_VERSION = "0.3.1"
_CLIENT_DISCONNECT_ERRNOS = {
    errno.EPIPE,
    errno.ECONNRESET,
    errno.ECONNABORTED,
}
_CLIENT_DISCONNECT_WINERRORS = {
    10053,  # WSAECONNABORTED: software caused connection abort
    10054,  # WSAECONNRESET: connection reset by peer
    10058,  # WSAESHUTDOWN: socket already shut down
}


def is_client_disconnect_error(error: BaseException) -> bool:
    """Return True only for expected socket disconnect errors."""
    if isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
        return True
    if not isinstance(error, OSError):
        return False
    return (
        getattr(error, "errno", None) in _CLIENT_DISCONNECT_ERRNOS
        or getattr(error, "winerror", None) in _CLIENT_DISCONNECT_WINERRORS
    )


class QuietLuminaHandler(rich.LuminaRichEditHandler):
    """Rich Lumina handler that suppresses expected client-abort tracebacks."""

    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def handle(self) -> None:
        try:
            super().handle()
        except OSError as error:
            if not is_client_disconnect_error(error):
                raise
            self.close_connection = True


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina PDF Studio with rich document editing.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=64, help="Maximum request body size in MiB.")
    args = parser.parse_args()

    core.edit_pdf = rich.edit_pdf
    core.ENGINE_VERSION = ENGINE_VERSION
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(
        (args.host, args.port),
        lambda *handler_args, **handler_kwargs: QuietLuminaHandler(
            *handler_args, directory=str(core.ROOT), **handler_kwargs
        ),
    )
    server.max_upload = max(1, args.max_upload_mb) * 1024 * 1024  # type: ignore[attr-defined]
    print(f"Lumina PDF Studio: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Lumina PDF Studio.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
