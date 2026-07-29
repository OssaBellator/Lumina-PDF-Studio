#!/usr/bin/env python3
"""Lumina PDF Studio local server and native PDF engine.

The HTTP service is intentionally bound to loopback by default. It serves the
static application and exposes narrowly scoped PDF operations under /api/pdf.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
from email.parser import BytesParser
from email.policy import default as email_policy
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import pymupdf
except ImportError:  # pragma: no cover - handled in health response
    pymupdf = None

ROOT = Path(__file__).resolve().parent
ENGINE_VERSION = "0.1.0"
DEFAULT_MAX_UPLOAD = 64 * 1024 * 1024


class EngineError(Exception):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST, code: str = "engine_error") -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = code


def require_engine() -> None:
    if pymupdf is None:
        raise EngineError(
            "PyMuPDF is not installed. Run: python3 -m pip install -r requirements.txt",
            HTTPStatus.SERVICE_UNAVAILABLE,
            "engine_unavailable",
        )


def _open_pdf(pdf_bytes: bytes):
    require_engine()
    if not pdf_bytes.startswith(b"%PDF-"):
        raise EngineError("The uploaded file is not a PDF.", code="invalid_pdf")
    try:
        document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise EngineError(f"The PDF could not be opened: {exc}", code="invalid_pdf") from exc
    if document.needs_pass:
        document.close()
        raise EngineError("Password-protected PDFs are not supported yet.", HTTPStatus.UNPROCESSABLE_ENTITY, "password_required")
    return document


def _widget_to_dict(widget: Any, page_number: int) -> dict[str, Any]:
    rect = widget.rect
    choices = list(widget.choice_values or []) if hasattr(widget, "choice_values") else []
    return {
        "page": page_number,
        "name": widget.field_name or "",
        "label": widget.field_label or widget.field_name or "",
        "type": widget.field_type_string or "Unknown",
        "typeCode": widget.field_type,
        "value": widget.field_value,
        "choices": choices,
        "readOnly": bool((widget.field_flags or 0) & pymupdf.PDF_FIELD_IS_READ_ONLY),
        "required": bool((widget.field_flags or 0) & pymupdf.PDF_FIELD_IS_REQUIRED),
        "signed": bool(widget.is_signed) if widget.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE else None,
        "rect": [rect.x0, rect.y0, rect.x1, rect.y1],
        "xref": widget.xref,
    }


def analyze_pdf(pdf_bytes: bytes) -> dict[str, Any]:
    document = _open_pdf(pdf_bytes)
    try:
        fields: list[dict[str, Any]] = []
        signature_fields: list[dict[str, Any]] = []
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            widget = page.first_widget
            while widget:
                item = _widget_to_dict(widget, page_index)
                fields.append(item)
                if widget.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
                    signature_fields.append(item)
                widget = widget.next

        signature_flags = document.get_sigflags()
        signed = any(bool(field.get("signed")) for field in signature_fields)
        return {
            "engineVersion": ENGINE_VERSION,
            "pageCount": document.page_count,
            "metadata": dict(document.metadata or {}),
            "isFormPdf": bool(document.is_form_pdf),
            "formFields": fields,
            "signatures": {
                "flags": signature_flags,
                "fields": signature_fields,
                "signed": signed,
                "mutationWarning": signed or signature_flags == 3,
            },
            "permissions": int(document.permissions),
            "canSaveIncrementally": bool(document.can_save_incrementally()),
            "repaired": bool(document.is_repaired),
            "encrypted": bool(document.is_encrypted),
        }
    finally:
        document.close()


def _normalize_color(value: Any, fallback: tuple[float, float, float] = (0, 0, 0)) -> tuple[float, float, float]:
    if isinstance(value, str):
        clean = value.strip().lstrip("#")
        if len(clean) == 3:
            clean = "".join(ch * 2 for ch in clean)
        if len(clean) == 6:
            try:
                return tuple(int(clean[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]
            except ValueError:
                pass
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        try:
            numbers = tuple(float(value[i]) for i in range(3))
            if max(numbers) > 1:
                numbers = tuple(component / 255 for component in numbers)
            return tuple(max(0.0, min(1.0, component)) for component in numbers)  # type: ignore[return-value]
        except (TypeError, ValueError):
            pass
    return fallback


def _span_style(page: Any, target: Any) -> dict[str, Any]:
    best: tuple[float, dict[str, Any]] | None = None
    content = page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)
    for block in content.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                span_rect = pymupdf.Rect(span.get("bbox", (0, 0, 0, 0)))
                overlap = span_rect & target
                area = max(0.0, overlap.get_area())
                if area and (best is None or area > best[0]):
                    best = (area, span)
    if not best:
        return {"size": max(8.0, min(18.0, target.height * 0.8)), "color": (0, 0, 0), "font": "helv"}
    span = best[1]
    color = pymupdf.sRGB_to_pdf(int(span.get("color", 0)))
    font_name = str(span.get("font") or "helv").lower()
    base_font = "cour" if "cour" in font_name else "tiro" if "times" in font_name else "helv"
    return {"size": float(span.get("size") or 11), "color": color, "font": base_font}


def _insert_text_fitting(page: Any, rect: Any, text: str, style: dict[str, Any], operation: dict[str, Any]) -> float:
    size = float(operation.get("fontSize") or style["size"] or 11)
    font_name = str(operation.get("font") or style["font"] or "helv")
    color = _normalize_color(operation.get("color"), tuple(style["color"]))
    align_map = {"left": pymupdf.TEXT_ALIGN_LEFT, "center": pymupdf.TEXT_ALIGN_CENTER, "right": pymupdf.TEXT_ALIGN_RIGHT, "justify": pymupdf.TEXT_ALIGN_JUSTIFY}
    align = align_map.get(str(operation.get("align") or "left").lower(), pymupdf.TEXT_ALIGN_LEFT)
    minimum = max(4.0, float(operation.get("minimumFontSize") or 5))
    while size >= minimum:
        result = page.insert_textbox(rect, text, fontname=font_name, fontsize=size, color=color, align=align, overlay=True)
        if result >= 0:
            return size
        size -= 0.5
    raise EngineError("Replacement text does not fit in the original area.", HTTPStatus.UNPROCESSABLE_ENTITY, "replacement_does_not_fit")


def _replace_text(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    search = str(operation.get("search") or "")
    replacement = str(operation.get("replacement") or "")
    if not search:
        raise EngineError("replace_text requires a non-empty search value.", code="invalid_operation")
    page_numbers = operation.get("pages")
    if page_numbers is None:
        page_numbers = [operation.get("page", 0)]
    if page_numbers == "all":
        page_numbers = list(range(document.page_count))
    if not isinstance(page_numbers, list):
        page_numbers = [page_numbers]

    occurrence = operation.get("occurrence", "all")
    total = 0
    reports = []
    for raw_page_number in page_numbers:
        page_number = int(raw_page_number)
        if page_number < 0 or page_number >= document.page_count:
            raise EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
        page = document.load_page(page_number)
        matches = list(page.search_for(search))
        if occurrence == "first":
            matches = matches[:1]
        elif isinstance(occurrence, int):
            matches = matches[occurrence:occurrence + 1]
        if not matches:
            reports.append({"page": page_number, "matches": 0})
            continue
        styled_targets = [(rect, _span_style(page, rect)) for rect in matches]
        redaction_color = operation.get("redactionColor")
        fill = None if redaction_color in (None, "", "transparent") else _normalize_color(redaction_color, (1, 1, 1))
        for rect, _style in styled_targets:
            page.add_redact_annot(rect, fill=fill)
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )
        used_sizes = []
        for rect, style in styled_targets:
            used_sizes.append(_insert_text_fitting(page, rect, replacement, style, operation))
        total += len(matches)
        reports.append({"page": page_number, "matches": len(matches), "fontSizes": used_sizes})
    if total == 0 and bool(operation.get("requireMatch", True)):
        raise EngineError(f'Text "{search}" was not found.', HTTPStatus.NOT_FOUND, "text_not_found")
    return {"type": "replace_text", "search": search, "replacement": replacement, "matches": total, "pages": reports}


def _set_form_field(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    name = str(operation.get("name") or "")
    if not name:
        raise EngineError("set_form_field requires a field name.", code="invalid_operation")
    changed = 0
    for page_index in range(document.page_count):
        page = document.load_page(page_index)
        widget = page.first_widget
        while widget:
            next_widget = widget.next
            if widget.field_name == name:
                if widget.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
                    raise EngineError("Signature fields are read-only.", HTTPStatus.CONFLICT, "signature_read_only")
                if (widget.field_flags or 0) & pymupdf.PDF_FIELD_IS_READ_ONLY:
                    raise EngineError(f'Form field "{name}" is read-only.', HTTPStatus.CONFLICT, "field_read_only")
                value = operation.get("value")
                if widget.field_type in (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON):
                    widget.field_value = widget.on_state() if bool(value) else False
                else:
                    widget.field_value = "" if value is None else str(value)
                widget.update()
                changed += 1
            widget = next_widget
    if not changed:
        raise EngineError(f'Form field "{name}" was not found.', HTTPStatus.NOT_FOUND, "field_not_found")
    return {"type": "set_form_field", "name": name, "updatedWidgets": changed}


def _set_metadata(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    allowed = {"title", "author", "subject", "keywords", "creator", "producer", "creationDate", "modDate", "trapped"}
    changes = operation.get("values") or {}
    if not isinstance(changes, dict):
        raise EngineError("set_metadata values must be an object.", code="invalid_operation")
    metadata = dict(document.metadata or {})
    applied: dict[str, str] = {}
    for key, value in changes.items():
        if key in allowed:
            metadata[key] = "" if value is None else str(value)
            applied[key] = metadata[key]
    document.set_metadata(metadata)
    return {"type": "set_metadata", "values": applied}


def _add_text(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    page_number = int(operation.get("page", 0))
    if page_number < 0 or page_number >= document.page_count:
        raise EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
    rect_values = operation.get("rect")
    if not isinstance(rect_values, list) or len(rect_values) != 4:
        raise EngineError("add_text requires rect: [x0, y0, x1, y1].", code="invalid_operation")
    page = document.load_page(page_number)
    rect = pymupdf.Rect(*[float(value) for value in rect_values])
    style = {"size": float(operation.get("fontSize") or 12), "color": _normalize_color(operation.get("color")), "font": str(operation.get("font") or "helv")}
    used_size = _insert_text_fitting(page, rect, str(operation.get("text") or ""), style, operation)
    return {"type": "add_text", "page": page_number, "fontSize": used_size}


def edit_pdf(pdf_bytes: bytes, operations: list[dict[str, Any]], allow_signed_mutation: bool = False) -> tuple[bytes, dict[str, Any]]:
    if not isinstance(operations, list) or not operations:
        raise EngineError("At least one operation is required.", code="missing_operations")
    if len(operations) > 100:
        raise EngineError("A maximum of 100 operations is allowed per request.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_many_operations")

    document = _open_pdf(pdf_bytes)
    try:
        signature_flags = document.get_sigflags()
        signature_fields = []
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            widget = page.first_widget
            while widget:
                if widget.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
                    signature_fields.append(bool(widget.is_signed))
                widget = widget.next
        signed = any(signature_fields)
        if (signed or signature_flags == 3) and not allow_signed_mutation:
            raise EngineError(
                "This PDF contains a signature that would be invalidated by editing. Export an unsigned copy or explicitly allow signature invalidation.",
                HTTPStatus.CONFLICT,
                "signed_pdf_mutation_blocked",
            )

        report: list[dict[str, Any]] = []
        handlers = {
            "replace_text": _replace_text,
            "set_form_field": _set_form_field,
            "set_metadata": _set_metadata,
            "add_text": _add_text,
        }
        for operation in operations:
            if not isinstance(operation, dict):
                raise EngineError("Each operation must be an object.", code="invalid_operation")
            operation_type = str(operation.get("type") or "")
            handler = handlers.get(operation_type)
            if handler is None:
                raise EngineError(f'Unsupported operation type "{operation_type}".', code="unsupported_operation")
            report.append(handler(document, operation))

        output = document.tobytes(garbage=4, deflate=True, clean=True)
        return output, {
            "engineVersion": ENGINE_VERSION,
            "operations": report,
            "signatureInvalidated": bool((signed or signature_flags == 3) and allow_signed_mutation),
        }
    finally:
        document.close()


def parse_multipart(content_type: str, body: bytes) -> dict[str, dict[str, Any]]:
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    message = BytesParser(policy=email_policy).parsebytes(header + body)
    if not message.is_multipart():
        raise EngineError("Expected multipart/form-data.", code="invalid_content_type")
    values: dict[str, dict[str, Any]] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        values[str(name)] = {
            "filename": part.get_filename(),
            "contentType": part.get_content_type(),
            "data": part.get_payload(decode=True) or b"",
        }
    return values


class LuminaHandler(SimpleHTTPRequestHandler):
    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def __init__(self, *args: Any, directory: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, directory=directory or str(ROOT), **kwargs)

    @property
    def max_upload(self) -> int:
        return int(getattr(self.server, "max_upload", DEFAULT_MAX_UPLOAD))

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise EngineError("Invalid Content-Length.", code="invalid_length") from exc
        if length <= 0:
            raise EngineError("Request body is empty.", code="empty_request")
        if length > self.max_upload:
            raise EngineError("Upload exceeds the configured size limit.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "upload_too_large")
        return self.rfile.read(length)

    def _multipart(self) -> dict[str, dict[str, Any]]:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            raise EngineError("Expected multipart/form-data.", code="invalid_content_type")
        return parse_multipart(content_type, self._read_body())

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": pymupdf is not None,
                "engineVersion": ENGINE_VERSION,
                "pymupdfVersion": getattr(pymupdf, "VersionBind", None) if pymupdf else None,
                "capabilities": ["analyze", "replace_text", "set_form_field", "set_metadata", "add_text"] if pymupdf else [],
                "maxUploadBytes": self.max_upload,
            })
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/api/pdf/analyze":
                parts = self._multipart()
                pdf_part = parts.get("file")
                if not pdf_part:
                    raise EngineError('Multipart field "file" is required.', code="missing_file")
                self._json(HTTPStatus.OK, analyze_pdf(pdf_part["data"]))
                return

            if self.path == "/api/pdf/edit":
                parts = self._multipart()
                pdf_part = parts.get("file")
                operations_part = parts.get("operations")
                if not pdf_part or not operations_part:
                    raise EngineError('Multipart fields "file" and "operations" are required.', code="missing_fields")
                try:
                    request = json.loads(operations_part["data"].decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise EngineError("Operations JSON is invalid.", code="invalid_json") from exc
                output, report = edit_pdf(
                    pdf_part["data"],
                    request.get("operations"),
                    bool(request.get("allowSignedMutation", False)),
                )
                self._json(HTTPStatus.OK, {
                    "pdfBase64": base64.b64encode(output).decode("ascii"),
                    "report": report,
                })
                return

            self._json(HTTPStatus.NOT_FOUND, {"error": {"code": "not_found", "message": "Unknown API route."}})
        except EngineError as exc:
            self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
        except Exception as exc:  # pragma: no cover - defensive boundary
            self.log_error("Unhandled engine error: %s", exc)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": {"code": "internal_error", "message": "The PDF engine encountered an unexpected error."}})

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina PDF Studio and its local PDF engine.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=64, help="Maximum request body size in MiB.")
    args = parser.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer((args.host, args.port), lambda *handler_args, **handler_kwargs: LuminaHandler(*handler_args, directory=str(ROOT), **handler_kwargs))
    server.max_upload = max(1, args.max_upload_mb) * 1024 * 1024  # type: ignore[attr-defined]
    print(f"Lumina PDF Studio: http://{args.host}:{args.port}")
    if pymupdf is None:
        print("Warning: PyMuPDF is unavailable; native PDF endpoints will report unavailable.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Lumina PDF Studio.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
