#!/usr/bin/env python3
"""Lumina server with equation-fidelity snapshots and render recovery."""
from __future__ import annotations

import argparse
import base64
import mimetypes
from http import HTTPStatus
from http.server import ThreadingHTTPServer

import document_reflow as legacy_reflow
import document_reflow_safe as safe_reflow
import server as core
import server_v3 as rich
import server_v5 as transactions
import server_v6 as reflow_server

ENGINE_VERSION = "0.5.1"


class LuminaSafeReflowHandler(reflow_server.LuminaReflowHandler):
    """Overrides document conversion endpoints with validation and recovery."""

    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            office = legacy_reflow.find_office_executable()
            self._json(HTTPStatus.OK, {
                "ok": core.pymupdf is not None,
                "engineVersion": ENGINE_VERSION,
                "pymupdfVersion": getattr(core.pymupdf, "VersionBind", None) if core.pymupdf else None,
                "docxAvailable": True,
                "officeConverter": office,
                "capabilities": [
                    "analyze", "layout", "grouped_math", "replace_text", "replace_text_region",
                    "add_text_box", "text_overflow", "place_asset", "delete_region", "append_text_page",
                    "set_form_field", "set_metadata", "reflow_document", "docx_export", "markdown_export",
                    "document_ai_tools", "equation_snapshot_fidelity", "model_sanitization", "render_recovery",
                    "office_pdf_conversion" if office else "pymupdf_reflow_pdf",
                ] if core.pymupdf else [],
                "maxUploadBytes": self.max_upload,
            })
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/document/import":
            try:
                parts = self._multipart()
                pdf_part = parts.get("file")
                if not pdf_part:
                    raise core.EngineError('Multipart field "file" is required.', code="missing_file")
                title_part = parts.get("title")
                title = (title_part or {}).get("data", b"Document").decode("utf-8", errors="replace") or "Document"
                model = safe_reflow.pdf_to_document_model(pdf_part["data"], title=title)
                self._json(HTTPStatus.OK, {
                    "model": model,
                    "markdown": legacy_reflow.model_to_markdown(model),
                    "warnings": model.get("warnings") or [],
                    "engineVersion": ENGINE_VERSION,
                })
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled safe document import error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                    "error": {
                        "code": "document_import_failed",
                        "message": f"The PDF could not be converted into a safe editable document: {exc}",
                    }
                })
            return

        if self.path == "/api/document/render":
            try:
                payload = self._request_json()
                model = payload.get("model")
                if not isinstance(model, dict):
                    raise core.EngineError('JSON field "model" is required.', code="missing_model")
                result = safe_reflow.render_document_model(model, prefer_office=bool(payload.get("preferOffice", True)))
                self._json(HTTPStatus.OK, {
                    "pdfBase64": base64.b64encode(result["pdf"]).decode("ascii"),
                    "docxBase64": base64.b64encode(result["docx"]).decode("ascii"),
                    "markdown": result["markdown"],
                    "model": result["model"],
                    "converter": result["converter"],
                    "warnings": result["warnings"],
                    "recovered": result["recovered"],
                    "engineVersion": ENGINE_VERSION,
                })
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled safe document render error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                    "error": {
                        "code": "document_render_failed",
                        "message": f"The editable document could not be rendered back to PDF: {exc}",
                    }
                })
            return

        super().do_POST()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina with safe DOCX-backed reflow editing.")
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
    mimetypes.add_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx")
    server = ThreadingHTTPServer(
        (args.host, args.port),
        lambda *handler_args, **handler_kwargs: LuminaSafeReflowHandler(
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
