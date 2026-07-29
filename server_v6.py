#!/usr/bin/env python3
"""Lumina server with DOCX-backed reflow editing and AI document operations."""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from typing import Any

import document_reflow as reflow
import server as core
import server_v3 as rich
import server_v5 as transactions

ENGINE_VERSION = "0.5.0"
_LIST_PREFIX = re.compile(r"^\s*(?:[-*•]|\d+[.)]|[A-Za-z][.)])\s+")


def normalize_document_model(model: dict[str, Any]) -> dict[str, Any]:
    """Remove source list markers when the document model already stores list semantics."""
    normalized = json.loads(json.dumps(model))
    for block in normalized.get("blocks") or []:
        if block.get("type") != "list_item":
            continue
        text = str(block.get("text") or "")
        match = _LIST_PREFIX.match(text)
        if not match:
            continue
        original_html = str(block.get("html") or "")
        if original_html and original_html != reflow._escape_text(text):
            continue
        clean = text[match.end():].strip()
        block["text"] = clean
        block["html"] = reflow._escape_text(clean)
    return normalized


class LuminaReflowHandler(transactions.LuminaTransactionalHandler):
    """Adds PDF -> editable document model -> DOCX/PDF round-trip endpoints."""

    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def _request_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError as exc:
            raise core.EngineError("The request length is invalid.", code="invalid_request") from exc
        if length <= 0:
            raise core.EngineError("A JSON request body is required.", code="missing_body")
        if length > self.max_upload:
            raise core.EngineError("The document request is too large.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise core.EngineError("The request body is not valid JSON.", code="invalid_json") from exc
        if not isinstance(value, dict):
            raise core.EngineError("The request body must be a JSON object.", code="invalid_json")
        return value

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            office = reflow.find_office_executable()
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
                    "document_ai_tools", "office_pdf_conversion" if office else "pymupdf_reflow_pdf",
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
                model = normalize_document_model(reflow.pdf_to_document_model(pdf_part["data"], title=title))
                self._json(HTTPStatus.OK, {
                    "model": model,
                    "markdown": reflow.model_to_markdown(model),
                    "engineVersion": ENGINE_VERSION,
                })
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled document import error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": {"code": "document_import_failed", "message": "The PDF could not be converted into an editable document."}})
            return

        if self.path == "/api/document/render":
            try:
                payload = self._request_json()
                model = payload.get("model")
                if not isinstance(model, dict):
                    raise core.EngineError('JSON field "model" is required.', code="missing_model")
                model = normalize_document_model(model)
                result = reflow.render_document_model(model, prefer_office=bool(payload.get("preferOffice", True)))
                self._json(HTTPStatus.OK, {
                    "pdfBase64": base64.b64encode(result["pdf"]).decode("ascii"),
                    "docxBase64": base64.b64encode(result["docx"]).decode("ascii"),
                    "markdown": result["markdown"],
                    "converter": result["converter"],
                    "engineVersion": ENGINE_VERSION,
                })
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled document render error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": {"code": "document_render_failed", "message": "The editable document could not be rendered back to PDF."}})
            return

        super().do_POST()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina PDF Studio with DOCX-backed reflow editing.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=96, help="Maximum request body size in MiB.")
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
        lambda *handler_args, **handler_kwargs: LuminaReflowHandler(
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
