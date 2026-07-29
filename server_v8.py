#!/usr/bin/env python3
"""Lumina v4 server: source-preserving hybrid structured editing."""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
from http import HTTPStatus
from http.server import ThreadingHTTPServer

import hybrid_document
import server as core
import server_v3 as rich
import server_v5 as transactions
import server_v7 as legacy_server

ENGINE_VERSION = hybrid_document.ENGINE_VERSION


class LuminaHybridHandler(legacy_server.LuminaSafeReflowHandler):
    """Adds conservative page-structure import and region-only PDF saves."""

    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    @staticmethod
    def _part_text(parts: dict, name: str, default: str = "") -> str:
        part = parts.get(name)
        if not part:
            return default
        return part.get("data", b"").decode("utf-8", errors="replace")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": core.pymupdf is not None,
                "engineVersion": ENGINE_VERSION,
                "pymupdfVersion": getattr(core.pymupdf, "VersionBind", None) if core.pymupdf else None,
                "doclingAvailable": hybrid_document._docling_available(),
                "capabilities": [
                    "analyze", "layout", "replace_text", "replace_text_region", "place_asset", "delete_region",
                    "append_text_page", "hybrid_edit", "source_preserving_edit", "typed_document_model",
                    "block_id_ai_tools", "fast_import",
                    "docling_accurate_import" if hybrid_document._docling_available() else "optional_docling_import",
                ] if core.pymupdf else [],
                "maxUploadBytes": self.max_upload,
            })
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/hybrid/import":
            try:
                parts = self._multipart()
                pdf_part = parts.get("file")
                if not pdf_part:
                    raise core.EngineError('Multipart field "file" is required.', code="missing_file")
                title = self._part_text(parts, "title", "Document") or "Document"
                mode = self._part_text(parts, "mode", "auto") or "auto"
                model = hybrid_document.import_pdf_model(pdf_part["data"], title=title, mode=mode)
                self._json(HTTPStatus.OK, {
                    "model": model,
                    "warnings": model.get("warnings") or [],
                    "engineVersion": ENGINE_VERSION,
                })
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled hybrid import error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                    "error": {"code": "hybrid_import_failed", "message": f"The PDF structure could not be analysed: {exc}"}
                })
            return

        if self.path == "/api/hybrid/save":
            try:
                parts = self._multipart()
                pdf_part = parts.get("file")
                if not pdf_part:
                    raise core.EngineError('Multipart field "file" is required.', code="missing_file")
                try:
                    model = json.loads(self._part_text(parts, "model", "{}"))
                    changes = json.loads(self._part_text(parts, "changes", "[]"))
                except json.JSONDecodeError as exc:
                    raise core.EngineError("The hybrid edit transaction is not valid JSON.", code="invalid_transaction") from exc
                if not isinstance(model, dict) or not isinstance(changes, list):
                    raise core.EngineError("The hybrid edit transaction is invalid.", code="invalid_transaction")
                result = hybrid_document.apply_model_changes(pdf_part["data"], model, changes)
                self._json(HTTPStatus.OK, {
                    "pdfBase64": base64.b64encode(result["pdf"]).decode("ascii"),
                    "warnings": result["warnings"],
                    "pageCount": result["pageCount"],
                    "engineVersion": ENGINE_VERSION,
                })
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled hybrid save error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                    "error": {"code": "hybrid_save_failed", "message": f"The approved page edits could not be written: {exc}"}
                })
            return

        super().do_POST()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina with source-preserving hybrid structured editing.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=128, help="Maximum request body size in MiB.")
    args = parser.parse_args()

    rich.extract_page_layout = transactions.extract_page_layout
    rich._add_text_box = transactions._add_text_box_with_overflow
    rich.ENGINE_VERSION = ENGINE_VERSION
    core.edit_pdf = rich.edit_pdf
    core.ENGINE_VERSION = ENGINE_VERSION
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(
        (args.host, args.port),
        lambda *handler_args, **handler_kwargs: LuminaHybridHandler(
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
