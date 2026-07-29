#!/usr/bin/env python3
"""Source-preserving structured PDF import and edit helpers for Lumina v4.

The model deliberately separates semantic understanding from visual fidelity:
- every source element keeps a page/bounding-box provenance pointer;
- the original PDF page remains the visual source of truth in the editor;
- only approved changed regions are redacted and rewritten on save;
- optional Docling support supplies richer item types, reading order, tables,
  formula recognition, OCR, and provenance without making it a hard runtime
  dependency.
"""
from __future__ import annotations

import base64
import math
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, Iterable

try:
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf

MODEL_VERSION = 4
ENGINE_VERSION = "0.8.0"
MATH_CHARS = set("=+-−×÷∑∏∫√∞≈≠≤≥∂∇∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔λμσαβγδθφψωΓΔΘΛΞΠΣΦΨΩ^_{}[]()|±∓")
TEXT_KINDS = {"text", "heading", "list", "caption"}
SOURCE_KINDS = TEXT_KINDS | {"formula", "table", "picture", "complex"}


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _finite(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _rect(values: Any, *, width: float = 612, height: float = 792) -> list[float]:
    source = list(values or [0, 0, width, height])[:4]
    while len(source) < 4:
        source.append(0)
    x0, y0, x1, y1 = (_finite(value, 0) for value in source)
    x0, x1 = sorted((max(0.0, min(width, x0)), max(0.0, min(width, x1))))
    y0, y1 = sorted((max(0.0, min(height, y0)), max(0.0, min(height, y1))))
    if x1 - x0 < 1:
        x1 = min(width, x0 + 1)
    if y1 - y0 < 1:
        y1 = min(height, y0 + 1)
    return [x0, y0, x1, y1]


def _union(rects: Iterable[list[float]], padding: float = 0) -> list[float]:
    values = list(rects)
    if not values:
        return [0, 0, 1, 1]
    return [
        min(value[0] for value in values) - padding,
        min(value[1] for value in values) - padding,
        max(value[2] for value in values) + padding,
        max(value[3] for value in values) + padding,
    ]


def _intersects(first: list[float], second: list[float], ratio: float = 0.2) -> bool:
    x0, y0 = max(first[0], second[0]), max(first[1], second[1])
    x1, y1 = min(first[2], second[2]), min(first[3], second[3])
    if x1 <= x0 or y1 <= y0:
        return False
    overlap = (x1 - x0) * (y1 - y0)
    smaller = min((first[2] - first[0]) * (first[3] - first[1]), (second[2] - second[0]) * (second[3] - second[1]))
    return bool(smaller and overlap / smaller >= ratio)


def _contains_bad_unicode(text: str) -> bool:
    return "\ufffd" in text or any(0xE000 <= ord(char) <= 0xF8FF for char in text)


def _math_score(text: str, fonts: Iterable[str] = ()) -> float:
    compact = "".join(str(text or "").split())
    if not compact:
        return 0.0
    font_marker = any(token in " ".join(fonts).lower() for token in ("math", "symbol", "cmmi", "cmsy", "cmex", "stix"))
    symbols = sum(char in MATH_CHARS or 0x2200 <= ord(char) <= 0x22FF for char in compact)
    digits = sum(char.isdigit() for char in compact)
    letters = sum(char.isalpha() for char in compact)
    brackets = sum(char in "()[]{}" for char in compact)
    bad = _contains_bad_unicode(compact)
    score = 0.0
    if font_marker:
        score += 0.55
    if bad:
        score += 0.75
    score += min(0.55, symbols / max(2, len(compact)) * 2.4)
    if brackets >= 2 and digits >= 1:
        score += 0.28
    if digits >= 2 and len(compact) <= 24:
        score += 0.18
    if letters > 8 and symbols < 2 and not font_marker:
        score -= 0.45
    if re.search(r"\b(question|semester|problem|find|solve|eigenvalues?|matrices?)\b", text, re.I):
        score -= 0.55
    return max(0.0, min(1.0, score))


def _color_hex(value: Any) -> str:
    try:
        red, green, blue = pymupdf.sRGB_to_pdf(int(value or 0))
        return "#" + "".join(f"{max(0, min(255, round(component * 255))):02x}" for component in (red, green, blue))
    except Exception:
        return "#111318"


def _style_from_spans(spans: list[dict[str, Any]]) -> dict[str, Any]:
    dominant = max(spans, key=lambda span: len(str(span.get("text") or "")), default={})
    flags = int(dominant.get("flags") or 0)
    return {
        "fontFamily": str(dominant.get("font") or "Arial"),
        "fontSize": max(5.0, min(96.0, _finite(dominant.get("size"), 11.0))),
        "bold": bool(flags & getattr(pymupdf, "TEXT_FONT_BOLD", 16)),
        "italic": bool(flags & getattr(pymupdf, "TEXT_FONT_ITALIC", 2)),
        "color": _color_hex(dominant.get("color", 0)),
        "align": "left",
        "lineHeight": 1.15,
    }


def _block_text(block: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    lines: list[str] = []
    spans: list[dict[str, Any]] = []
    for line in block.get("lines") or []:
        line_spans = list(line.get("spans") or [])
        spans.extend(line_spans)
        value = "".join(str(span.get("text") or "") for span in line_spans).strip()
        if value:
            lines.append(value)
    return "\n".join(lines).strip(), spans


def _table_regions(page: Any, page_index: int) -> list[dict[str, Any]]:
    finder = getattr(page, "find_tables", None)
    if finder is None:
        return []
    output: list[dict[str, Any]] = []
    try:
        tables = getattr(finder(), "tables", []) or []
        for index, table in enumerate(tables):
            rows = [[str(cell or "") for cell in row] for row in (table.extract() or [])]
            if not rows or not any(any(cell.strip() for cell in row) for row in rows):
                continue
            output.append({
                "id": _id("table"), "page": page_index, "kind": "table",
                "bbox": [float(value) for value in table.bbox], "text": "\n".join(" | ".join(row) for row in rows),
                "rows": rows, "editable": False, "confidence": 0.82, "sourceMode": "background",
                "source": {"backend": "pymupdf", "tableIndex": index},
            })
    except Exception:
        return []
    return output


def _neighbour(first: dict[str, Any], second: dict[str, Any], page_width: float) -> bool:
    a, b = first["bbox"], second["bbox"]
    ah, bh = max(1.0, a[3] - a[1]), max(1.0, b[3] - b[1])
    scale = max(ah, bh, 7.0)
    vertical_overlap = min(a[3], b[3]) - max(a[1], b[1])
    horizontal_overlap = min(a[2], b[2]) - max(a[0], b[0])
    horizontal_gap = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    vertical_gap = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    same_row = vertical_overlap >= -scale * 0.55 and horizontal_gap <= min(page_width * 0.30, max(72.0, scale * 8))
    same_column = horizontal_overlap >= -scale * 2.0 and vertical_gap <= max(28.0, scale * 2.8)
    return same_row or same_column


def _group_formula_candidates(blocks: list[dict[str, Any]], page_width: float, page_height: float) -> tuple[list[dict[str, Any]], set[str]]:
    candidates = [block for block in blocks if block.get("mathScore", 0) >= 0.42]
    parent = {block["id"]: block["id"] for block in candidates}

    def find(value: str) -> str:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(left: str, right: str) -> None:
        a, b = find(left), find(right)
        if a != b:
            parent[b] = a

    for index, first in enumerate(candidates):
        for second in candidates[index + 1:]:
            if _neighbour(first, second, page_width):
                union(first["id"], second["id"])

    components: dict[str, list[dict[str, Any]]] = {}
    for block in candidates:
        components.setdefault(find(block["id"]), []).append(block)

    formulas: list[dict[str, Any]] = []
    consumed: set[str] = set()
    for members in components.values():
        combined = "\n".join(member["text"] for member in sorted(members, key=lambda item: (item["bbox"][1], item["bbox"][0])))
        aggregate_score = max(member.get("mathScore", 0) for member in members)
        has_structure = len(members) > 1 or any(char in combined for char in "()[]{}=") or _contains_bad_unicode(combined)
        if aggregate_score < 0.56 and not has_structure:
            continue
        bbox = _rect(_union([member["bbox"] for member in members], 2), width=page_width, height=page_height)
        formulas.append({
            "id": _id("formula"), "page": members[0]["page"], "kind": "formula", "bbox": bbox,
            "text": combined, "latex": "", "editable": False, "confidence": round(max(0.48, min(0.78, aggregate_score)), 3),
            "sourceMode": "background", "recognition": "required", "style": members[0].get("style") or {},
            "members": [member["id"] for member in members], "source": {"backend": "pymupdf", "kind": "formula_group"},
        })
        consumed.update(member["id"] for member in members)
    return formulas, consumed


def _fast_import(pdf_bytes: bytes, title: str) -> dict[str, Any]:
    document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    pages: list[dict[str, Any]] = []
    all_text: list[str] = []
    warnings: list[str] = []
    try:
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            width, height = float(page.rect.width), float(page.rect.height)
            tables = _table_regions(page, page_index)
            table_boxes = [item["bbox"] for item in tables]
            raw = page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT | pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_IMAGES)
            text_blocks: list[dict[str, Any]] = []
            pictures: list[dict[str, Any]] = []
            for block_index, block in enumerate(raw.get("blocks", [])):
                block_type = int(block.get("type", -1))
                bbox = _rect(block.get("bbox"), width=width, height=height)
                if any(_intersects(bbox, table_box, 0.45) for table_box in table_boxes):
                    continue
                if block_type == 0:
                    text, spans = _block_text(block)
                    if not text:
                        continue
                    fonts = [str(span.get("font") or "") for span in spans]
                    style = _style_from_spans(spans)
                    score = _math_score(text, fonts)
                    text_blocks.append({
                        "id": f"p{page_index}-block-{block_index}", "page": page_index, "kind": "text", "bbox": bbox,
                        "text": text, "editable": not _contains_bad_unicode(text), "confidence": 0.84 if not _contains_bad_unicode(text) else 0.45,
                        "sourceMode": "background", "style": style, "mathScore": score,
                        "source": {"backend": "pymupdf", "blockIndex": block_index},
                    })
                elif block_type == 1:
                    pictures.append({
                        "id": f"p{page_index}-picture-{block_index}", "page": page_index, "kind": "picture", "bbox": bbox,
                        "text": f"Picture on page {page_index + 1}", "editable": False, "confidence": 0.94,
                        "sourceMode": "background", "source": {"backend": "pymupdf", "blockIndex": block_index},
                    })
            formulas, consumed = _group_formula_candidates(text_blocks, width, height)
            kept_text: list[dict[str, Any]] = []
            for block in text_blocks:
                if block["id"] in consumed:
                    continue
                text = block["text"]
                size = _finite(block.get("style", {}).get("fontSize"), 11)
                if len(text) <= 120 and (size >= 15 or (block.get("style", {}).get("bold") and size >= 11.5)):
                    block["kind"] = "heading"
                block.pop("mathScore", None)
                kept_text.append(block)
                all_text.append(text)
            elements = sorted([*tables, *kept_text, *formulas, *pictures], key=lambda item: (item["bbox"][1], item["bbox"][0]))
            if not elements:
                warnings.append(f"Page {page_index + 1} has no confidently editable regions. The original page remains intact.")
            pages.append({"id": f"page-{page_index + 1}", "index": page_index, "width": width, "height": height, "elements": elements})
    finally:
        document.close()
    return {
        "version": MODEL_VERSION, "engineVersion": ENGINE_VERSION, "backend": "pymupdf-fast", "title": title,
        "pages": pages, "text": "\n\n".join(all_text), "warnings": warnings,
        "capabilities": {"docling": False, "formulaRecognition": False, "ocr": False},
    }


def _docling_available() -> bool:
    try:
        import docling  # noqa: F401
        return True
    except Exception:
        return False


def _docling_import(pdf_bytes: bytes, title: str) -> dict[str, Any]:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = True
    options.do_table_structure = True
    options.do_formula_enrichment = True
    options.generate_page_images = False
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    with tempfile.TemporaryDirectory(prefix="lumina-docling-") as directory:
        source = Path(directory) / "source.pdf"
        source.write_bytes(pdf_bytes)
        result = converter.convert(source)
    doc = result.document
    page_map: dict[int, dict[str, Any]] = {}
    for page_no, page in doc.pages.items():
        page_map[int(page_no)] = {
            "id": f"page-{page_no}", "index": int(page_no) - 1,
            "width": float(page.size.width), "height": float(page.size.height), "elements": [],
        }
    all_text: list[str] = []
    for item, _level in doc.iterate_items(traverse_pictures=True):
        provs = list(getattr(item, "prov", []) or [])
        if not provs:
            continue
        prov = provs[0]
        page_no = int(prov.page_no)
        target = page_map.get(page_no)
        if not target:
            continue
        bbox = prov.bbox
        if hasattr(bbox, "to_top_left_origin"):
            bbox = bbox.to_top_left_origin(page_height=target["height"])
        rect = _rect([bbox.l, bbox.t, bbox.r, bbox.b], width=target["width"], height=target["height"])
        label = str(getattr(item, "label", "text")).split(".")[-1].lower()
        text = str(getattr(item, "text", None) or getattr(item, "orig", None) or "").strip()
        if label in {"formula"}:
            kind = "formula"
        elif label in {"table"}:
            kind = "table"
        elif label in {"picture", "chart"}:
            kind = "picture"
        elif label in {"title", "section_header", "page_header"}:
            kind = "heading"
        elif label in {"list_item"}:
            kind = "list"
        elif label in {"caption"}:
            kind = "caption"
        elif label in {"text", "paragraph", "footnote", "reference"}:
            kind = "text"
        else:
            kind = "complex"
        editable = kind in TEXT_KINDS and bool(text) and not _contains_bad_unicode(text)
        latex = text if kind == "formula" and text and not _contains_bad_unicode(text) else ""
        if kind == "formula" and latex:
            editable = True
        confidence = 0.94 if kind in TEXT_KINDS else 0.9 if kind in {"formula", "table", "picture"} else 0.72
        element = {
            "id": _id(kind), "page": page_no - 1, "kind": kind, "bbox": rect, "text": text,
            "latex": latex, "editable": editable, "confidence": confidence, "sourceMode": "background",
            "source": {"backend": "docling", "label": label, "selfRef": str(getattr(item, "self_ref", ""))},
        }
        if kind in TEXT_KINDS:
            element["style"] = {"fontFamily": "Arial", "fontSize": 11, "color": "#111318", "align": "left", "lineHeight": 1.15}
        target["elements"].append(element)
        if text:
            all_text.append(text)
    pages = [page_map[key] for key in sorted(page_map)]
    for page in pages:
        page["elements"].sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
    return {
        "version": MODEL_VERSION, "engineVersion": ENGINE_VERSION, "backend": "docling-accurate", "title": title,
        "pages": pages, "text": "\n\n".join(all_text), "warnings": [],
        "capabilities": {"docling": True, "formulaRecognition": True, "ocr": True},
    }


def import_pdf_model(pdf_bytes: bytes, title: str = "Document", mode: str = "auto") -> dict[str, Any]:
    requested = str(mode or "auto").lower()
    if requested in {"auto", "accurate", "docling"} and _docling_available():
        try:
            return _docling_import(pdf_bytes, title)
        except Exception as exc:
            model = _fast_import(pdf_bytes, title)
            model["warnings"].insert(0, f"Accurate import was unavailable for this file; Fast import was used instead ({type(exc).__name__}).")
            return model
    model = _fast_import(pdf_bytes, title)
    if requested in {"accurate", "docling"} and not _docling_available():
        model["warnings"].insert(0, "Accurate import requires the optional Docling dependencies.")
    return model


def _element_index(model: dict[str, Any]) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for page in model.get("pages") or []:
        for element in page.get("elements") or []:
            if element.get("id"):
                output[str(element["id"])] = element
    return output


def _rgb(value: Any) -> tuple[float, float, float]:
    text = str(value or "#111318")
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return tuple(int(text[index:index + 2], 16) / 255 for index in (1, 3, 5))  # type: ignore[return-value]
    return (0.07, 0.075, 0.095)


def _font_alias(style: dict[str, Any]) -> str:
    family = str(style.get("fontFamily") or "Helvetica").lower()
    bold, italic = bool(style.get("bold")), bool(style.get("italic"))
    if "cour" in family or "mono" in family:
        return "cobi" if bold and italic else "cobo" if bold else "coit" if italic else "cour"
    if "times" in family or "serif" in family or "cambria" in family:
        return "tibi" if bold and italic else "tibo" if bold else "tiit" if italic else "tiro"
    return "hebi" if bold and italic else "hebo" if bold else "heit" if italic else "helv"


def _insert_text(page: Any, rect: pymupdf.Rect, text: str, style: dict[str, Any], warnings: list[str]) -> None:
    size = max(5.0, min(96.0, _finite(style.get("fontSize"), 11.0)))
    minimum = max(4.5, min(size, _finite(style.get("minimumFontSize"), 6.0)))
    font = _font_alias(style)
    align = {"center": 1, "right": 2, "justify": 3}.get(str(style.get("align") or "left"), 0)
    line_height = max(1.0, min(2.5, _finite(style.get("lineHeight"), 1.15)))
    while size >= minimum - 0.01:
        result = page.insert_textbox(rect, str(text or ""), fontname=font, fontsize=size, color=_rgb(style.get("color")), align=align, lineheight=line_height)
        if result >= 0:
            return
        size -= 0.5
    fallback = str(text or "")[:800]
    page.insert_textbox(rect, fallback, fontname="helv", fontsize=minimum, color=_rgb(style.get("color")), align=align, lineheight=1.0)
    warnings.append("One replacement was reduced to the minimum font size to remain inside its source region.")


def _decode_data_url(value: str) -> tuple[str, bytes]:
    match = re.match(r"^data:([^;,]+)(;base64)?,(.*)$", str(value or ""), re.S)
    if not match:
        raise ValueError("Invalid embedded asset")
    mime, encoded, payload = match.groups()
    raw = base64.b64decode(payload) if encoded else payload.encode("utf-8")
    return mime.lower(), raw


def _insert_asset(page: Any, rect: pymupdf.Rect, data_url: str) -> None:
    mime, raw = _decode_data_url(data_url)
    if "svg" in mime:
        svg = pymupdf.open(stream=raw, filetype="svg")
        try:
            converted = svg.convert_to_pdf()
        finally:
            svg.close()
        source = pymupdf.open(stream=converted, filetype="pdf")
        try:
            page.show_pdf_page(rect, source, 0, keep_proportion=True, overlay=True)
        finally:
            source.close()
    else:
        page.insert_image(rect, stream=raw, keep_proportion=True, overlay=True)


def apply_model_changes(pdf_bytes: bytes, model: dict[str, Any], changes: list[dict[str, Any]]) -> dict[str, Any]:
    document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    index = _element_index(model)
    warnings: list[str] = []
    try:
        redactions: dict[int, list[pymupdf.Rect]] = {}
        insertions: dict[int, list[tuple[str, pymupdf.Rect, dict[str, Any]]]] = {}
        append_pages: list[dict[str, Any]] = []
        for change in changes or []:
            kind = str(change.get("type") or "")
            element = index.get(str(change.get("elementId") or ""))
            page_index = int(change.get("page", element.get("page", 0) if element else 0))
            if kind in {"replace_text", "replace_formula", "delete"} and element:
                page_index = int(element.get("page", page_index))
                rect = pymupdf.Rect(*element["bbox"])
                redactions.setdefault(page_index, []).append(rect)
                if kind == "replace_text":
                    insertions.setdefault(page_index, []).append(("text", rect, {"text": change.get("text", ""), "style": {**(element.get("style") or {}), **(change.get("style") or {})}}))
                elif kind == "replace_formula":
                    insertions.setdefault(page_index, []).append(("asset" if change.get("assetDataUrl") else "text", rect, {
                        "dataUrl": change.get("assetDataUrl"), "text": change.get("latex") or change.get("text") or "",
                        "style": {"fontFamily": "Times", "fontSize": 12, "align": "center", "color": "#111318"},
                    }))
            elif kind == "add_text":
                rect = pymupdf.Rect(*_rect(change.get("bbox"), width=document[page_index].rect.width, height=document[page_index].rect.height))
                insertions.setdefault(page_index, []).append(("text", rect, {"text": change.get("text", ""), "style": change.get("style") or {}}))
            elif kind == "add_image" and change.get("dataUrl"):
                rect = pymupdf.Rect(*_rect(change.get("bbox"), width=document[page_index].rect.width, height=document[page_index].rect.height))
                insertions.setdefault(page_index, []).append(("asset", rect, {"dataUrl": change.get("dataUrl")}))
            elif kind == "append_page":
                append_pages.append(change)

        for page_index, rects in redactions.items():
            if page_index < 0 or page_index >= document.page_count:
                continue
            page = document.load_page(page_index)
            for rect in rects:
                page.add_redact_annot(rect, fill=(1, 1, 1))
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)

        for page_index, entries in insertions.items():
            if page_index < 0 or page_index >= document.page_count:
                warnings.append("An edit targeted a page that no longer exists and was skipped.")
                continue
            page = document.load_page(page_index)
            for mode, rect, payload in entries:
                try:
                    if mode == "asset" and payload.get("dataUrl"):
                        _insert_asset(page, rect, payload["dataUrl"])
                    else:
                        _insert_text(page, rect, str(payload.get("text") or ""), dict(payload.get("style") or {}), warnings)
                except Exception as exc:
                    warnings.append(f"One inserted object could not be rendered ({type(exc).__name__}).")

        for append in append_pages:
            width = max(300.0, _finite(append.get("width"), 612.0))
            height = max(400.0, _finite(append.get("height"), 792.0))
            page = document.new_page(width=width, height=height)
            margin = 54.0
            title = str(append.get("title") or "Continued")
            text = str(append.get("text") or "")
            page.insert_textbox(pymupdf.Rect(margin, margin, width - margin, margin + 48), title, fontname="hebo", fontsize=18, color=(0.07, 0.075, 0.095))
            _insert_text(page, pymupdf.Rect(margin, margin + 60, width - margin, height - margin), text, {
                "fontFamily": "Helvetica", "fontSize": 11, "lineHeight": 1.25, "color": "#111318",
            }, warnings)

        output = document.tobytes(garbage=4, deflate=True, clean=True)
        return {"pdf": output, "warnings": warnings, "pageCount": document.page_count}
    finally:
        document.close()


__all__ = [
    "MODEL_VERSION", "ENGINE_VERSION", "import_pdf_model", "apply_model_changes", "_docling_available",
]
