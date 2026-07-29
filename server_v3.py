#!/usr/bin/env python3
"""Lumina PDF Studio server with structured edit-mode layout and rich native operations."""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import math
import mimetypes
import re
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from typing import Any

import server as core
import server_v2 as v2

ENGINE_VERSION = "0.3.0"
MAX_LAYOUT_IMAGE_BYTES = 8 * 1024 * 1024

_MATH_FONT_MARKERS = (
    "math", "symbol", "cmmi", "cmsy", "cmex", "msam", "msbm", "euclid",
    "mathtime", "mt extra", "stix", "asana", "latinmodernmath",
)
_MATH_CHARS = set("=+-−×÷∑∏∫√∞≈≠≤≥∂∇∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔λμσαβγδθφψωΓΔΘΛΞΠΣΦΨΩ^_{}[]|±∓∴∵")


def _rect(value: Any, page: Any | None = None) -> Any:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise core.EngineError("A rectangle must be [x0, y0, x1, y1].", code="invalid_rect")
    result = core.pymupdf.Rect(*[float(component) for component in value])
    if page is not None:
        result &= page.rect
    if result.is_empty or result.width < 0.5 or result.height < 0.5:
        raise core.EngineError("The rectangle is outside the page or too small.", code="invalid_rect")
    return result


def _normal_font_key(value: Any) -> str:
    text = str(value or "").split("+")[-1].lower()
    return re.sub(r"[^a-z0-9]", "", text)


def _page_fonts(page: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in page.get_fonts(full=True):
        xref, extension, font_type, basefont, resource, encoding, *_rest = item
        result.append({
            "xref": int(xref),
            "extension": extension,
            "type": font_type,
            "basefont": basefont,
            "resource": resource,
            "encoding": encoding,
            "keys": {_normal_font_key(basefont), _normal_font_key(resource)},
        })
    return result


def _match_font(span_font: Any, page_fonts: list[dict[str, Any]]) -> dict[str, Any] | None:
    target = _normal_font_key(span_font)
    best: tuple[int, dict[str, Any]] | None = None
    for item in page_fonts:
        for key in item["keys"]:
            if not key:
                continue
            score = 100 if target == key else 80 if target in key or key in target else 0
            if score and (best is None or score > best[0]):
                best = (score, item)
    return best[1] if best else None


def _color_to_hex(value: Any) -> str:
    red, green, blue = core.pymupdf.sRGB_to_pdf(int(value or 0))
    return "#" + "".join(f"{max(0, min(255, round(component * 255))):02x}" for component in (red, green, blue))


def _hex_to_rgb(value: Any, fallback: tuple[float, float, float] = (0, 0, 0)) -> tuple[float, float, float]:
    return core._normalize_color(value, fallback)


def _is_math_line(text: str, font_name: str, spans: list[dict[str, Any]]) -> bool:
    compact = "".join(text.split())
    if not compact:
        return False
    symbol_count = sum(
        character in _MATH_CHARS or 0x2200 <= ord(character) <= 0x22FF or 0x1D400 <= ord(character) <= 0x1D7FF
        for character in compact
    )
    font_key = font_name.lower()
    if any(marker in font_key for marker in _MATH_FONT_MARKERS):
        return True
    ratio = symbol_count / max(1, len(compact))
    superscript_like = any(character in "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼₀₁₂₃₄₅₆₇₈₉" for character in compact)
    many_offsets = len({round(float(span.get("origin", (0, 0))[1]), 1) for span in spans}) >= 3
    return ratio >= 0.30 or (symbol_count >= 3 and len(compact) <= 48) or (superscript_like and symbol_count >= 1) or (many_offsets and symbol_count >= 1)


def _dominant_span(spans: list[dict[str, Any]]) -> dict[str, Any]:
    return max(spans, key=lambda span: len(str(span.get("text") or "")), default={})


def _direction_rotation(direction: Any) -> int:
    try:
        dx, dy = float(direction[0]), float(direction[1])
        return int(round(math.degrees(math.atan2(-dy, dx)) / 90.0) * 90) % 360
    except (TypeError, ValueError, IndexError):
        return 0


def extract_page_layout(pdf_bytes: bytes, page_number: int) -> dict[str, Any]:
    document = core._open_pdf(pdf_bytes)
    try:
        if page_number < 0 or page_number >= document.page_count:
            raise core.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
        page = document.load_page(page_number)
        page_fonts = _page_fonts(page)
        flags = core.pymupdf.TEXTFLAGS_DICT | core.pymupdf.TEXT_PRESERVE_LIGATURES | core.pymupdf.TEXT_PRESERVE_WHITESPACE | core.pymupdf.TEXT_PRESERVE_IMAGES
        content = page.get_text("dict", flags=flags)
        objects: list[dict[str, Any]] = []
        warnings: list[str] = []

        for block_index, block in enumerate(content.get("blocks", [])):
            block_type = int(block.get("type", -1))
            if block_type == 0:
                for line_index, line in enumerate(block.get("lines", [])):
                    spans = list(line.get("spans") or [])
                    text = "".join(str(span.get("text") or "") for span in spans)
                    if not text.strip():
                        continue
                    bbox = core.pymupdf.Rect(line.get("bbox") or block.get("bbox")) & page.rect
                    if bbox.is_empty:
                        continue
                    dominant = _dominant_span(spans)
                    font_match = _match_font(dominant.get("font"), page_fonts)
                    flags_value = int(dominant.get("flags") or 0)
                    style = {
                        "fontName": str(dominant.get("font") or "Helvetica"),
                        "fontXref": font_match["xref"] if font_match else None,
                        "fontSize": float(dominant.get("size") or max(5, bbox.height * 0.8)),
                        "color": _color_to_hex(dominant.get("color", 0)),
                        "bold": bool(flags_value & core.pymupdf.TEXT_FONT_BOLD),
                        "italic": bool(flags_value & core.pymupdf.TEXT_FONT_ITALIC),
                        "align": "left",
                        "lineHeight": 1.15,
                        "rotation": _direction_rotation(line.get("dir") or (1, 0)),
                    }
                    span_payload = []
                    for span_index, span in enumerate(spans):
                        span_rect = core.pymupdf.Rect(span.get("bbox") or bbox) & page.rect
                        matched = _match_font(span.get("font"), page_fonts)
                        span_flags = int(span.get("flags") or 0)
                        span_payload.append({
                            "id": f"span-{block_index}-{line_index}-{span_index}",
                            "text": str(span.get("text") or ""),
                            "rect": [span_rect.x0, span_rect.y0, span_rect.x1, span_rect.y1],
                            "origin": list(span.get("origin") or (span_rect.x0, span_rect.y1)),
                            "fontName": str(span.get("font") or "Helvetica"),
                            "fontXref": matched["xref"] if matched else None,
                            "fontSize": float(span.get("size") or style["fontSize"]),
                            "color": _color_to_hex(span.get("color", 0)),
                            "bold": bool(span_flags & core.pymupdf.TEXT_FONT_BOLD),
                            "italic": bool(span_flags & core.pymupdf.TEXT_FONT_ITALIC),
                        })
                    objects.append({
                        "id": f"text-{block_index}-{line_index}",
                        "kind": "math" if _is_math_line(text, style["fontName"], spans) else "text",
                        "text": text,
                        "rect": [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
                        "style": style,
                        "direction": list(line.get("dir") or (1, 0)),
                        "rotation": style["rotation"],
                        "spans": span_payload,
                    })
            elif block_type == 1:
                bbox = core.pymupdf.Rect(block.get("bbox")) & page.rect
                if bbox.is_empty:
                    continue
                image = bytes(block.get("image") or b"")
                extension = str(block.get("ext") or "png").lower()
                mime_extension = "jpeg" if extension in ("jpg", "jpeg") else extension
                data_url = None
                if image and len(image) <= MAX_LAYOUT_IMAGE_BYTES:
                    data_url = f"data:image/{mime_extension};base64,{base64.b64encode(image).decode('ascii')}"
                elif image:
                    warnings.append(f"Image block {block_index} is too large for interactive editing.")
                objects.append({
                    "id": f"image-{block_index}",
                    "kind": "image",
                    "rect": [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
                    "dataUrl": data_url,
                    "mime": f"image/{mime_extension}",
                    "pixelWidth": int(block.get("width") or 0),
                    "pixelHeight": int(block.get("height") or 0),
                    "editable": bool(data_url),
                })

        return {
            "engineVersion": ENGINE_VERSION,
            "page": page_number,
            "width": float(page.rect.width),
            "height": float(page.rect.height),
            "rotation": int(page.rotation),
            "objects": objects,
            "warnings": warnings,
        }
    finally:
        document.close()


def _style_for_rect(document: Any, page: Any, target: Any) -> dict[str, Any]:
    page_fonts = _page_fonts(page)
    best: tuple[float, dict[str, Any]] | None = None
    content = page.get_text("dict", flags=core.pymupdf.TEXTFLAGS_TEXT)
    for block in content.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                span_rect = core.pymupdf.Rect(span.get("bbox", (0, 0, 0, 0)))
                overlap = span_rect & target
                area = max(0.0, overlap.get_area())
                if area and (best is None or area > best[0]):
                    best = (area, span)
    if not best:
        return {
            "fontName": "Helvetica", "fontXref": None,
            "fontSize": max(8.0, min(18.0, target.height * 0.75)),
            "color": "#000000", "bold": False, "italic": False,
            "align": "left", "lineHeight": 1.15, "rotation": 0,
        }
    span = best[1]
    match = _match_font(span.get("font"), page_fonts)
    flags_value = int(span.get("flags") or 0)
    return {
        "fontName": str(span.get("font") or "Helvetica"),
        "fontXref": match["xref"] if match else None,
        "fontSize": float(span.get("size") or 11),
        "color": _color_to_hex(span.get("color", 0)),
        "bold": bool(flags_value & core.pymupdf.TEXT_FONT_BOLD),
        "italic": bool(flags_value & core.pymupdf.TEXT_FONT_ITALIC),
        "align": "left",
        "lineHeight": 1.15,
        "rotation": 0,
    }


def _base_font_alias(family: Any, bold: bool, italic: bool) -> str:
    name = str(family or "").lower()
    if "cour" in name or "mono" in name:
        return "cobi" if bold and italic else "cobo" if bold else "coit" if italic else "cour"
    if "times" in name or "serif" in name or "roman" in name:
        return "tibi" if bold and italic else "tibo" if bold else "tiit" if italic else "tiro"
    return "hebi" if bold and italic else "hebo" if bold else "heit" if italic else "helv"


def _resolve_font(document: Any, page: Any, style: dict[str, Any], operation: dict[str, Any], text: str) -> tuple[str, bool]:
    bold = bool(operation.get("bold", style.get("bold", False)))
    italic = bool(operation.get("italic", style.get("italic", False)))
    explicit_family = operation.get("fontFamily") or operation.get("font")
    font_xref = operation.get("fontXref", style.get("fontXref"))
    preserve_original = bool(operation.get("preserveOriginalFont", True)) and not explicit_family and "bold" not in operation and "italic" not in operation
    if font_xref and preserve_original:
        try:
            _name, _extension, _font_type, font_buffer = document.extract_font(int(font_xref))
            if font_buffer:
                font = core.pymupdf.Font(fontbuffer=font_buffer)
                supported = all(character.isspace() or font.has_glyph(ord(character)) for character in text)
                if supported:
                    alias = f"LMF{int(font_xref)}"
                    page.insert_font(fontname=alias, fontbuffer=font_buffer)
                    return alias, True
        except Exception:
            pass
    family = explicit_family or style.get("fontName") or "Helvetica"
    return _base_font_alias(family, bold, italic), False


def _draw_box_background(page: Any, rect: Any, operation: dict[str, Any]) -> None:
    background = operation.get("backgroundColor")
    border = operation.get("borderColor")
    border_width = max(0.0, float(operation.get("borderWidth") or 0))
    if background or border_width:
        page.draw_rect(
            rect,
            color=_hex_to_rgb(border, (0, 0, 0)) if border_width else None,
            fill=_hex_to_rgb(background, (1, 1, 1)) if background else None,
            width=border_width,
            overlay=True,
        )


def _candidate_rectangles(page: Any, source: Any, requested: Any, style: dict[str, Any], operation: dict[str, Any], text: str) -> list[Any]:
    font_size = float(operation.get("fontSize") or style.get("fontSize") or 11)
    padding = max(2.0, font_size * 0.16)
    first = core.pymupdf.Rect(requested.x0, requested.y0 - padding, requested.x1, requested.y1 + padding) & page.rect
    candidates = [first]
    fit_mode = str(operation.get("fitMode") or "shrink").lower()
    if fit_mode in ("expand", "reflow", "auto"):
        page_margin = max(18.0, float(operation.get("pageMargin") or 36))
        available_right = max(first.x1, page.rect.x1 - page_margin)
        text_ratio = max(1.0, len(text) / max(1, len(str(operation.get("originalText") or ""))))
        line_count = max(1, text.count("\n") + math.ceil(text_ratio / 2.5))
        desired_height = max(first.height, font_size * 1.35 * line_count + padding * 2)
        desired_width = max(first.width, min(available_right - first.x0, first.width * min(4.5, max(1.4, text_ratio))))
        expanded = core.pymupdf.Rect(
            first.x0,
            first.y0,
            min(page.rect.x1 - page_margin, first.x0 + desired_width),
            min(page.rect.y1 - page_margin, first.y0 + desired_height),
        ) & page.rect
        if not expanded.is_empty:
            candidates.append(expanded)
        full_line = core.pymupdf.Rect(
            first.x0,
            first.y0,
            page.rect.x1 - page_margin,
            min(page.rect.y1 - page_margin, first.y0 + max(desired_height, font_size * 5.5)),
        ) & page.rect
        if not full_line.is_empty:
            candidates.append(full_line)
    unique: list[Any] = []
    seen: set[tuple[float, float, float, float]] = set()
    for candidate in candidates:
        key = tuple(round(value, 2) for value in candidate)
        if key not in seen:
            unique.append(candidate)
            seen.add(key)
    return unique


def _insert_text_fitting(document: Any, page: Any, rectangles: list[Any], text: str, style: dict[str, Any], operation: dict[str, Any]) -> tuple[float, str, Any]:
    start_size = max(4.0, float(operation.get("fontSize") or style.get("fontSize") or 11))
    minimum = max(3.5, float(operation.get("minimumFontSize") or 5))
    color = _hex_to_rgb(operation.get("color"), _hex_to_rgb(style.get("color"), (0, 0, 0)))
    align_map = {
        "left": core.pymupdf.TEXT_ALIGN_LEFT,
        "center": core.pymupdf.TEXT_ALIGN_CENTER,
        "right": core.pymupdf.TEXT_ALIGN_RIGHT,
        "justify": core.pymupdf.TEXT_ALIGN_JUSTIFY,
    }
    align = align_map.get(str(operation.get("align") or style.get("align") or "left").lower(), core.pymupdf.TEXT_ALIGN_LEFT)
    line_height = max(0.7, min(3.0, float(operation.get("lineHeight") or style.get("lineHeight") or 1.15)))
    font_name, embedded = _resolve_font(document, page, style, operation, text)
    fallback_name = _base_font_alias(operation.get("fontFamily") or style.get("fontName"), bool(operation.get("bold", style.get("bold", False))), bool(operation.get("italic", style.get("italic", False))))
    font_candidates = [font_name] + ([fallback_name] if embedded and fallback_name != font_name else [])

    last_error: Exception | None = None
    for rectangle in rectangles:
        for candidate_font in font_candidates:
            size = start_size
            while size >= minimum:
                try:
                    remaining = page.insert_textbox(
                        rectangle,
                        text,
                        fontname=candidate_font,
                        fontsize=size,
                        color=color,
                        align=align,
                        lineheight=line_height,
                        rotate=int(operation.get("rotation", style.get("rotation", 0))) % 360,
                        overlay=True,
                    )
                except Exception as exc:
                    last_error = exc
                    break
                if remaining >= 0:
                    if operation.get("underline") and text.strip():
                        underline_y = min(rectangle.y1 - 1, rectangle.y0 + size * 1.13)
                        page.draw_line(
                            core.pymupdf.Point(rectangle.x0, underline_y),
                            core.pymupdf.Point(rectangle.x1, underline_y),
                            color=color,
                            width=max(0.5, size / 18),
                            overlay=True,
                        )
                    return size, candidate_font, rectangle
                size -= 0.5
    detail = f" ({last_error})" if last_error else ""
    raise core.EngineError(
        f"Replacement text does not fit in the available area{detail}.",
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "replacement_does_not_fit",
    )


def _apply_text_region(document: Any, page: Any, source: Any | None, target: Any, text: str, style: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
    if source is not None:
        redaction_color = operation.get("redactionColor", "transparent")
        fill = None if redaction_color in (None, "", "transparent") else _hex_to_rgb(redaction_color, (1, 1, 1))
        page.add_redact_annot(source, fill=fill)
        page.apply_redactions(
            images=core.pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=core.pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=core.pymupdf.PDF_REDACT_TEXT_REMOVE,
        )
    candidates = _candidate_rectangles(page, source or target, target, style, operation, text)
    _draw_box_background(page, candidates[0], operation)
    size, font_name, used_rect = _insert_text_fitting(document, page, candidates, text, style, operation)
    return {
        "fontSize": size,
        "font": font_name,
        "targetRect": [used_rect.x0, used_rect.y0, used_rect.x1, used_rect.y1],
    }


def _replace_text_region(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    page_number = int(operation.get("page", 0))
    if page_number < 0 or page_number >= document.page_count:
        raise core.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
    page = document.load_page(page_number)
    source = _rect(operation.get("sourceRect") or operation.get("rect"), page)
    target = _rect(operation.get("targetRect") or operation.get("rect") or operation.get("sourceRect"), page)
    original_text = str(operation.get("originalText") or "")
    replacement = str(operation.get("replacement") or "")
    detected_text = page.get_textbox(source).strip()
    style = _style_for_rect(document, page, source)
    result = _apply_text_region(document, page, source, target, replacement, style, operation)
    return {
        "type": "replace_text_region",
        "page": page_number,
        "sourceRect": [source.x0, source.y0, source.x1, source.y1],
        "originalText": original_text,
        "detectedText": detected_text,
        "replacement": replacement,
        **result,
    }


def _replace_text(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    search = str(operation.get("search") or "")
    replacement = str(operation.get("replacement") or "")
    if not search:
        raise core.EngineError("replace_text requires a non-empty search value.", code="invalid_operation")
    page_numbers = operation.get("pages")
    if page_numbers is None:
        page_numbers = [operation.get("page", 0)]
    if page_numbers == "all":
        page_numbers = list(range(document.page_count))
    if not isinstance(page_numbers, list):
        page_numbers = [page_numbers]
    occurrence = operation.get("occurrence", "first")
    total = 0
    reports = []
    for raw_page_number in page_numbers:
        page_number = int(raw_page_number)
        if page_number < 0 or page_number >= document.page_count:
            raise core.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
        page = document.load_page(page_number)
        matches = list(page.search_for(search))
        if occurrence == "first":
            matches = matches[:1]
        elif isinstance(occurrence, int):
            matches = matches[occurrence:occurrence + 1]
        elif occurrence != "all":
            matches = matches[:1]
        page_reports = []
        for match in matches:
            style = _style_for_rect(document, page, match)
            per_operation = {
                **operation,
                "originalText": search,
                "fitMode": operation.get("fitMode", "expand"),
                "redactionColor": operation.get("redactionColor", "transparent"),
            }
            result = _apply_text_region(document, page, match, match, replacement, style, per_operation)
            page_reports.append({"rect": list(match), **result})
            total += 1
        reports.append({"page": page_number, "matches": len(matches), "items": page_reports})
    if total == 0 and bool(operation.get("requireMatch", True)):
        raise core.EngineError(f'Text "{search}" was not found.', HTTPStatus.NOT_FOUND, "text_not_found")
    return {"type": "replace_text", "search": search, "replacement": replacement, "matches": total, "pages": reports}


def _add_text_box(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    page_number = int(operation.get("page", 0))
    if page_number < 0 or page_number >= document.page_count:
        raise core.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
    page = document.load_page(page_number)
    target = _rect(operation.get("targetRect") or operation.get("rect"), page)
    style = {
        "fontName": operation.get("fontFamily") or operation.get("font") or "Helvetica",
        "fontXref": operation.get("fontXref"),
        "fontSize": float(operation.get("fontSize") or 11),
        "color": operation.get("color") or "#111318",
        "bold": bool(operation.get("bold", False)),
        "italic": bool(operation.get("italic", False)),
        "align": operation.get("align") or "left",
        "lineHeight": float(operation.get("lineHeight") or 1.15),
        "rotation": int(operation.get("rotation") or 0),
    }
    _draw_box_background(page, target, operation)
    candidates = _candidate_rectangles(page, target, target, style, operation, str(operation.get("text") or ""))
    size, font_name, used_rect = _insert_text_fitting(document, page, candidates, str(operation.get("text") or ""), style, operation)
    return {
        "type": "add_text_box", "page": page_number,
        "targetRect": [used_rect.x0, used_rect.y0, used_rect.x1, used_rect.y1],
        "fontSize": size, "font": font_name,
    }


def _decode_asset(operation: dict[str, Any]) -> tuple[bytes, str]:
    data_url = operation.get("dataUrl")
    mime = str(operation.get("mime") or "")
    if isinstance(data_url, str) and data_url.startswith("data:"):
        header, encoded = data_url.split(",", 1)
        mime = header[5:].split(";", 1)[0] or mime
        try:
            return base64.b64decode(encoded, validate=False), mime
        except (binascii.Error, ValueError) as exc:
            raise core.EngineError("The embedded image data is invalid.", code="invalid_asset") from exc
    raw = operation.get("base64")
    if isinstance(raw, str):
        try:
            return base64.b64decode(raw, validate=False), mime
        except (binascii.Error, ValueError) as exc:
            raise core.EngineError("The embedded image data is invalid.", code="invalid_asset") from exc
    raise core.EngineError("place_asset requires dataUrl or base64.", code="missing_asset")


def _place_asset(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    page_number = int(operation.get("page", 0))
    if page_number < 0 or page_number >= document.page_count:
        raise core.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
    page = document.load_page(page_number)
    target = _rect(operation.get("targetRect") or operation.get("rect"), page)
    source_value = operation.get("sourceRect")
    if source_value is not None:
        source = _rect(source_value, page)
        page.add_redact_annot(source, fill=None)
        page.apply_redactions(
            images=core.pymupdf.PDF_REDACT_IMAGE_REMOVE if operation.get("removeImages", True) else core.pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=core.pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED if operation.get("removeGraphics", False) else core.pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=core.pymupdf.PDF_REDACT_TEXT_REMOVE if operation.get("removeText", False) else core.pymupdf.PDF_REDACT_TEXT_NONE,
        )
    asset_bytes, mime = _decode_asset(operation)
    keep_proportion = bool(operation.get("keepProportion", True))
    rotation = int(operation.get("rotation") or 0) % 360
    if "svg" in mime.lower() or asset_bytes.lstrip().startswith(b"<svg"):
        source_svg = core.pymupdf.open(stream=asset_bytes, filetype="svg")
        try:
            converted = source_svg.convert_to_pdf()
        finally:
            source_svg.close()
        source_pdf = core.pymupdf.open(stream=converted, filetype="pdf")
        try:
            page.show_pdf_page(target, source_pdf, 0, keep_proportion=keep_proportion, overlay=True, rotate=rotation)
        finally:
            source_pdf.close()
    else:
        page.insert_image(target, stream=asset_bytes, keep_proportion=keep_proportion, overlay=True, rotate=rotation)
    return {
        "type": "place_asset", "page": page_number,
        "targetRect": [target.x0, target.y0, target.x1, target.y1],
        "mime": mime,
    }


def _delete_region(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    page_number = int(operation.get("page", 0))
    if page_number < 0 or page_number >= document.page_count:
        raise core.EngineError(f"Page index {page_number} is outside the document.", code="invalid_page")
    page = document.load_page(page_number)
    target = _rect(operation.get("sourceRect") or operation.get("rect"), page)
    fill_value = operation.get("fill", "transparent")
    fill = None if fill_value in (None, "", "transparent") else _hex_to_rgb(fill_value, (1, 1, 1))
    page.add_redact_annot(target, fill=fill)
    page.apply_redactions(
        images=core.pymupdf.PDF_REDACT_IMAGE_REMOVE if operation.get("removeImages", True) else core.pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=core.pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED if operation.get("removeGraphics", False) else core.pymupdf.PDF_REDACT_LINE_ART_NONE,
        text=core.pymupdf.PDF_REDACT_TEXT_REMOVE if operation.get("removeText", True) else core.pymupdf.PDF_REDACT_TEXT_NONE,
    )
    return {"type": "delete_region", "page": page_number, "rect": list(target)}


def _add_text_box_to_page(document: Any, page: Any, target: Any, text: str, operation: dict[str, Any]) -> None:
    style = {
        "fontName": operation.get("fontFamily") or "Helvetica",
        "fontXref": None,
        "fontSize": float(operation.get("fontSize") or 11),
        "color": operation.get("color") or "#111318",
        "bold": bool(operation.get("bold", False)),
        "italic": bool(operation.get("italic", False)),
        "align": operation.get("align") or "left",
        "lineHeight": float(operation.get("lineHeight") or 1.15),
        "rotation": int(operation.get("rotation") or 0),
    }
    _insert_text_fitting(document, page, [target], text, style, operation)


def _append_text_page(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    reference = document.load_page(max(0, document.page_count - 1)) if document.page_count else None
    width = float(operation.get("width") or (reference.rect.width if reference else 612))
    height = float(operation.get("height") or (reference.rect.height if reference else 792))
    page = document.new_page(width=width, height=height)
    margin = max(24.0, float(operation.get("margin") or 54))
    title = str(operation.get("title") or "")
    text = str(operation.get("text") or "")
    y = margin
    if title:
        title_rect = core.pymupdf.Rect(margin, y, width - margin, y + 54)
        title_operation = {
            "fontFamily": operation.get("titleFontFamily") or "Helvetica",
            "fontSize": float(operation.get("titleFontSize") or 18),
            "bold": True,
            "color": operation.get("titleColor") or "#111318",
            "minimumFontSize": 10,
            "fitMode": "shrink",
        }
        _add_text_box_to_page(document, page, title_rect, title, title_operation)
        y = title_rect.y1 + 12
    body_rect = core.pymupdf.Rect(margin, y, width - margin, height - margin)
    body_operation = {
        "fontFamily": operation.get("fontFamily") or "Helvetica",
        "fontSize": float(operation.get("fontSize") or 11),
        "color": operation.get("color") or "#111318",
        "align": operation.get("align") or "left",
        "lineHeight": float(operation.get("lineHeight") or 1.25),
        "minimumFontSize": float(operation.get("minimumFontSize") or 7),
        "fitMode": "shrink",
    }
    _add_text_box_to_page(document, page, body_rect, text, body_operation)
    return {"type": "append_text_page", "page": document.page_count - 1}


def _signed_state(document: Any) -> tuple[bool, int]:
    signature_flags = document.get_sigflags()
    signature_fields: list[bool] = []
    for page_index in range(document.page_count):
        page = document.load_page(page_index)
        widget = page.first_widget
        while widget:
            if widget.field_type == core.pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
                signature_fields.append(bool(widget.is_signed))
            widget = widget.next
    return any(signature_fields), signature_flags


def edit_pdf(pdf_bytes: bytes, operations: list[dict[str, Any]], allow_signed_mutation: bool = False) -> tuple[bytes, dict[str, Any]]:
    if not isinstance(operations, list) or not operations:
        raise core.EngineError("At least one operation is required.", code="missing_operations")
    if len(operations) > 150:
        raise core.EngineError("A maximum of 150 operations is allowed per request.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_many_operations")
    document = core._open_pdf(pdf_bytes)
    try:
        signed, signature_flags = _signed_state(document)
        if (signed or signature_flags == 3) and not allow_signed_mutation:
            raise core.EngineError(
                "This PDF contains a signature that would be invalidated by editing.",
                HTTPStatus.CONFLICT,
                "signed_pdf_mutation_blocked",
            )
        handlers = {
            "replace_text": _replace_text,
            "replace_text_region": _replace_text_region,
            "add_text": core._add_text,
            "add_text_box": _add_text_box,
            "place_asset": _place_asset,
            "delete_region": _delete_region,
            "append_text_page": _append_text_page,
            "set_form_field": core._set_form_field,
            "set_metadata": core._set_metadata,
        }
        report: list[dict[str, Any]] = []
        for operation in operations:
            if not isinstance(operation, dict):
                raise core.EngineError("Each operation must be an object.", code="invalid_operation")
            operation_type = str(operation.get("type") or "")
            handler = handlers.get(operation_type)
            if handler is None:
                raise core.EngineError(f'Unsupported operation type "{operation_type}".', code="unsupported_operation")
            report.append(handler(document, operation))
        output = document.tobytes(garbage=4, deflate=True, clean=True)
        return output, {
            "engineVersion": ENGINE_VERSION,
            "operations": report,
            "signatureInvalidated": bool((signed or signature_flags == 3) and allow_signed_mutation),
        }
    finally:
        document.close()


class LuminaRichEditHandler(v2.LuminaDocumentEditHandler):
    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": core.pymupdf is not None,
                "engineVersion": ENGINE_VERSION,
                "pymupdfVersion": getattr(core.pymupdf, "VersionBind", None) if core.pymupdf else None,
                "capabilities": [
                    "analyze", "layout", "replace_text", "replace_text_region", "add_text_box",
                    "place_asset", "delete_region", "append_text_page", "set_form_field", "set_metadata",
                ] if core.pymupdf else [],
                "maxUploadBytes": self.max_upload,
            })
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/pdf/layout":
            try:
                parts = self._multipart()
                pdf_part = parts.get("file")
                if not pdf_part:
                    raise core.EngineError('Multipart field "file" is required.', code="missing_file")
                page_part = parts.get("page")
                page_number = int((page_part or {}).get("data", b"0").decode("utf-8") or "0")
                self._json(HTTPStatus.OK, extract_page_layout(pdf_part["data"], page_number))
            except core.EngineError as exc:
                self._json(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:  # pragma: no cover
                self.log_error("Unhandled layout error: %s", exc)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": {"code": "internal_error", "message": "The PDF layout engine encountered an unexpected error."}})
            return
        super().do_POST()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina PDF Studio with rich document editing.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=64, help="Maximum request body size in MiB.")
    args = parser.parse_args()

    core.edit_pdf = edit_pdf
    core.ENGINE_VERSION = ENGINE_VERSION
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(
        (args.host, args.port),
        lambda *handler_args, **handler_kwargs: LuminaRichEditHandler(
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
