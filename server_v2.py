#!/usr/bin/env python3
"""Lumina server extension for exact-region document editing."""
from __future__ import annotations

import argparse
import mimetypes
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from typing import Any

import server as base

ENGINE_VERSION = "0.2.0"


def _replace_text_region(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    page_number = int(operation.get("page", 0))
    if page_number < 0 or page_number >= document.page_count:
        raise base.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
    rect_values = operation.get("rect")
    if not isinstance(rect_values, list) or len(rect_values) != 4:
        raise base.EngineError("replace_text_region requires rect: [x0, y0, x1, y1].", code="invalid_operation")

    page = document.load_page(page_number)
    rect = base.pymupdf.Rect(*[float(value) for value in rect_values])
    rect = rect & page.rect
    if rect.is_empty or rect.width < 1 or rect.height < 1:
        raise base.EngineError("The editable text rectangle is outside the page.", code="invalid_rect")

    original_text = str(operation.get("originalText") or "")
    replacement = str(operation.get("replacement") or "")
    actual_text = page.get_textbox(rect).strip()
    if original_text and actual_text and original_text.strip() not in actual_text:
        expanded = base.pymupdf.Rect(rect.x0 - 2, rect.y0 - 2, rect.x1 + 2, rect.y1 + 2)
        expanded &= page.rect
        expanded_text = page.get_textbox(expanded).strip()
        if original_text.strip() in expanded_text:
            rect = expanded
            actual_text = expanded_text

    style = base._span_style(page, rect)
    redaction_color = operation.get("redactionColor", "#ffffff")
    fill = None if redaction_color in (None, "", "transparent") else base._normalize_color(redaction_color, (1, 1, 1))
    page.add_redact_annot(rect, fill=fill)
    page.apply_redactions(
        images=base.pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=base.pymupdf.PDF_REDACT_LINE_ART_NONE,
        text=base.pymupdf.PDF_REDACT_TEXT_REMOVE,
    )
    used_size = base._insert_text_fitting(page, rect, replacement, style, operation)
    return {
        "type": "replace_text_region",
        "page": page_number,
        "rect": [rect.x0, rect.y0, rect.x1, rect.y1],
        "originalText": original_text,
        "detectedText": actual_text,
        "replacement": replacement,
        "fontSize": used_size,
    }


def edit_pdf(pdf_bytes: bytes, operations: list[dict[str, Any]], allow_signed_mutation: bool = False) -> tuple[bytes, dict[str, Any]]:
    if not isinstance(operations, list) or not operations:
        raise base.EngineError("At least one operation is required.", code="missing_operations")
    if len(operations) > 100:
        raise base.EngineError("A maximum of 100 operations is allowed per request.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_many_operations")

    document = base._open_pdf(pdf_bytes)
    try:
        signature_flags = document.get_sigflags()
        signature_fields: list[bool] = []
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            widget = page.first_widget
            while widget:
                if widget.field_type == base.pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
                    signature_fields.append(bool(widget.is_signed))
                widget = widget.next
        signed = any(signature_fields)
        if (signed or signature_flags == 3) and not allow_signed_mutation:
            raise base.EngineError(
                "This PDF contains a signature that would be invalidated by editing. Export an unsigned copy or explicitly allow signature invalidation.",
                HTTPStatus.CONFLICT,
                "signed_pdf_mutation_blocked",
            )

        handlers = {
            "replace_text": base._replace_text,
            "replace_text_region": _replace_text_region,
            "set_form_field": base._set_form_field,
            "set_metadata": base._set_metadata,
            "add_text": base._add_text,
        }
        report: list[dict[str, Any]] = []
        for operation in operations:
            if not isinstance(operation, dict):
                raise base.EngineError("Each operation must be an object.", code="invalid_operation")
            operation_type = str(operation.get("type") or "")
            handler = handlers.get(operation_type)
            if handler is None:
                raise base.EngineError(f'Unsupported operation type "{operation_type}".', code="unsupported_operation")
            report.append(handler(document, operation))

        output = document.tobytes(garbage=4, deflate=True, clean=True)
        return output, {
            "engineVersion": ENGINE_VERSION,
            "operations": report,
            "signatureInvalidated": bool((signed or signature_flags == 3) and allow_signed_mutation),
        }
    finally:
        document.close()


class LuminaDocumentEditHandler(base.LuminaHandler):
    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": base.pymupdf is not None,
                "engineVersion": ENGINE_VERSION,
                "pymupdfVersion": getattr(base.pymupdf, "VersionBind", None) if base.pymupdf else None,
                "capabilities": [
                    "analyze", "replace_text", "replace_text_region", "set_form_field", "set_metadata", "add_text",
                ] if base.pymupdf else [],
                "maxUploadBytes": self.max_upload,
            })
            return
        super().do_GET()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina PDF Studio with document edit mode.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=64, help="Maximum request body size in MiB.")
    args = parser.parse_args()

    base.edit_pdf = edit_pdf
    base.ENGINE_VERSION = ENGINE_VERSION
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(
        (args.host, args.port),
        lambda *handler_args, **handler_kwargs: LuminaDocumentEditHandler(
            *handler_args, directory=str(base.ROOT), **handler_kwargs
        ),
    )
    server.max_upload = max(1, args.max_upload_mb) * 1024 * 1024  # type: ignore[attr-defined]
    print(f"Lumina PDF Studio: http://{args.host}:{args.port}")
    if base.pymupdf is None:
        print("Warning: PyMuPDF is unavailable; native PDF endpoints will report unavailable.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Lumina PDF Studio.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
