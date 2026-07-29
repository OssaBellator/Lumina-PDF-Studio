#!/usr/bin/env python3
"""Lumina server with transactional edit previews, grouped mathematics, and text overflow recovery."""
from __future__ import annotations

import argparse
import mimetypes
import re
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from typing import Any

import server as core
import server_v3 as rich
import server_v4 as transport

ENGINE_VERSION = "0.4.0"
_BASE_EXTRACT_PAGE_LAYOUT = rich.extract_page_layout
_BASE_ADD_TEXT_BOX = rich._add_text_box

_FRAGMENT_MATH_CHARS = set("=+-−×÷∑∏∫√∞≈≠≤≥∂∇∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔^_{}[]()|±∓,:;")
_SHORT_VARIABLES = set("xyzuvwabcdefghijklmnopqrstXYZUVWABCDEFGHIJKLMNOPQRST")


def _object_rect(item: dict[str, Any]) -> list[float]:
    values = item.get("rect") or [0, 0, 0, 0]
    return [float(values[0]), float(values[1]), float(values[2]), float(values[3])]


def _rect_gap(first: list[float], second: list[float]) -> tuple[float, float]:
    horizontal = max(0.0, max(first[0], second[0]) - min(first[2], second[2]))
    vertical = max(0.0, max(first[1], second[1]) - min(first[3], second[3]))
    return horizontal, vertical


def _looks_like_math_fragment(item: dict[str, Any]) -> bool:
    if item.get("kind") == "math":
        return True
    if item.get("kind") != "text":
        return False
    text = str(item.get("text") or "").strip()
    compact = "".join(text.split())
    if not compact or len(compact) > 24:
        return False
    if re.fullmatch(r"(?:question|part)\s*\d+[.):]?", text, re.IGNORECASE):
        return False
    if re.fullmatch(r"[A-Za-z][.)]", compact):
        return False
    letters = [character for character in compact if character.isalpha()]
    if len(letters) > 3 and not all(character in _SHORT_VARIABLES for character in letters):
        return False
    has_numeric = any(character.isdigit() for character in compact)
    has_symbol = any(character in _FRAGMENT_MATH_CHARS or 0x2200 <= ord(character) <= 0x22FF for character in compact)
    return has_numeric or has_symbol or (letters and len(compact) <= 4)


def _objects_are_neighbours(first: dict[str, Any], second: dict[str, Any]) -> bool:
    first_rect = _object_rect(first)
    second_rect = _object_rect(second)
    horizontal, vertical = _rect_gap(first_rect, second_rect)
    scale = max(6.0, first_rect[3] - first_rect[1], second_rect[3] - second_rect[1])
    vertical_overlap = min(first_rect[3], second_rect[3]) - max(first_rect[1], second_rect[1])
    horizontal_overlap = min(first_rect[2], second_rect[2]) - max(first_rect[0], second_rect[0])
    same_row = vertical_overlap >= -scale * 0.35 and horizontal <= max(24.0, scale * 2.2)
    same_column = horizontal_overlap >= -scale * 1.2 and vertical <= max(18.0, scale * 1.35)
    return same_row or same_column


def _component_qualifies(component: list[dict[str, Any]], page_width: float) -> bool:
    if len(component) < 2:
        return False
    compact = "".join(str(item.get("text") or "") for item in component).replace(" ", "")
    explicit_math = any(item.get("kind") == "math" for item in component)
    bracketed = any(character in compact for character in "()[]{}")
    numeric_fragments = sum(any(character.isdigit() for character in str(item.get("text") or "")) for item in component)
    rects = [_object_rect(item) for item in component]
    width = max(rect[2] for rect in rects) - min(rect[0] for rect in rects)
    centres = sorted((rect[1] + rect[3]) / 2 for rect in rects)
    row_count = 1
    for previous, current in zip(centres, centres[1:]):
        if current - previous > 4:
            row_count += 1
    matrix_like = numeric_fragments >= 2 and row_count >= 2
    return width <= page_width * 0.62 and (explicit_math or bracketed or matrix_like)


def _merge_math_component(component: list[dict[str, Any]], group_index: int) -> dict[str, Any]:
    rects = [_object_rect(item) for item in component]
    ordered = sorted(component, key=lambda item: ((_object_rect(item)[1] + _object_rect(item)[3]) / 2, _object_rect(item)[0]))
    median_height = sorted(max(1.0, rect[3] - rect[1]) for rect in rects)[len(rects) // 2]
    rows: list[list[dict[str, Any]]] = []
    for item in ordered:
        centre = (_object_rect(item)[1] + _object_rect(item)[3]) / 2
        if not rows:
            rows.append([item])
            continue
        last_centres = [(_object_rect(entry)[1] + _object_rect(entry)[3]) / 2 for entry in rows[-1]]
        if abs(centre - sum(last_centres) / len(last_centres)) <= max(3.0, median_height * 0.55):
            rows[-1].append(item)
        else:
            rows.append([item])
    text = "\n".join(
        " ".join(str(item.get("text") or "").strip() for item in sorted(row, key=lambda entry: _object_rect(entry)[0])).strip()
        for row in rows
    ).strip()
    dominant = max(component, key=lambda item: max(1, len(str(item.get("text") or ""))))
    spans: list[dict[str, Any]] = []
    for item in component:
        spans.extend(item.get("spans") or [])
    return {
        "id": f"math-group-{group_index}",
        "kind": "math",
        "text": text,
        "rect": [
            min(rect[0] for rect in rects), min(rect[1] for rect in rects),
            max(rect[2] for rect in rects), max(rect[3] for rect in rects),
        ],
        "sourceRects": rects,
        "members": [str(item.get("id") or "") for item in component],
        "style": dominant.get("style") or {},
        "direction": dominant.get("direction") or [1, 0],
        "rotation": int(dominant.get("rotation") or 0),
        "spans": spans,
        "editable": True,
        "grouped": True,
    }


def group_math_objects(objects: list[dict[str, Any]], page_width: float) -> list[dict[str, Any]]:
    candidates = [item for item in objects if _looks_like_math_fragment(item)]
    unvisited = {id(item): item for item in candidates}
    components: list[list[dict[str, Any]]] = []
    while unvisited:
        _key, seed = unvisited.popitem()
        component = [seed]
        queue = [seed]
        while queue:
            current = queue.pop()
            neighbours = [key for key, item in unvisited.items() if _objects_are_neighbours(current, item)]
            for key in neighbours:
                item = unvisited.pop(key)
                component.append(item)
                queue.append(item)
        components.append(component)

    replacements: dict[int, dict[str, Any]] = {}
    consumed: set[int] = set()
    for index, component in enumerate(components):
        if not _component_qualifies(component, page_width):
            continue
        merged = _merge_math_component(component, index)
        first_position = min(objects.index(item) for item in component)
        replacements[first_position] = merged
        consumed.update(id(item) for item in component)

    grouped: list[dict[str, Any]] = []
    for position, item in enumerate(objects):
        if position in replacements:
            grouped.append(replacements[position])
        if id(item) not in consumed:
            grouped.append(item)
    return grouped


def extract_page_layout(pdf_bytes: bytes, page_number: int) -> dict[str, Any]:
    layout = _BASE_EXTRACT_PAGE_LAYOUT(pdf_bytes, page_number)
    layout["objects"] = group_math_objects(list(layout.get("objects") or []), float(layout.get("width") or 612))
    layout["engineVersion"] = ENGINE_VERSION
    return layout


def _add_text_box_with_overflow(document: Any, operation: dict[str, Any]) -> dict[str, Any]:
    try:
        return _BASE_ADD_TEXT_BOX(document, operation)
    except core.EngineError as error:
        overflow_policy = str(operation.get("overflowPolicy") or "auto").lower()
        fit_mode = str(operation.get("fitMode") or "shrink").lower()
        may_append = overflow_policy in {"auto", "append", "append_page", "new_page", "paginate"} and fit_mode in {"expand", "reflow", "auto"}
        if error.code != "replacement_does_not_fit" or not may_append:
            raise
        page_number = int(operation.get("page", 0))
        reference = document.load_page(page_number)
        appended = rich._append_text_page(document, {
            "title": operation.get("overflowTitle") or operation.get("title") or "Continued",
            "text": str(operation.get("text") or ""),
            "fontFamily": operation.get("fontFamily") or "Helvetica",
            "fontSize": float(operation.get("fontSize") or 11),
            "color": operation.get("color") or "#111318",
            "lineHeight": float(operation.get("lineHeight") or 1.25),
            "minimumFontSize": min(float(operation.get("minimumFontSize") or 6), 6.0),
            "width": reference.rect.width,
            "height": reference.rect.height,
        })
        return {
            "type": "add_text_box",
            "page": page_number,
            "overflow": "appended_page",
            "overflowPage": appended["page"],
            "message": "The text did not fit safely, so Lumina added a continuation page.",
        }


class LuminaTransactionalHandler(transport.QuietLuminaHandler):
    server_version = f"LuminaPDF/{ENGINE_VERSION}"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": core.pymupdf is not None,
                "engineVersion": ENGINE_VERSION,
                "pymupdfVersion": getattr(core.pymupdf, "VersionBind", None) if core.pymupdf else None,
                "capabilities": [
                    "analyze", "layout", "grouped_math", "replace_text", "replace_text_region", "add_text_box",
                    "text_overflow", "place_asset", "delete_region", "append_text_page", "set_form_field", "set_metadata",
                ] if core.pymupdf else [],
                "maxUploadBytes": self.max_upload,
            })
            return
        super().do_GET()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lumina PDF Studio with transactional rich editing.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Defaults to loopback only.")
    parser.add_argument("--port", type=int, default=4173, help="HTTP port.")
    parser.add_argument("--max-upload-mb", type=int, default=64, help="Maximum request body size in MiB.")
    args = parser.parse_args()

    rich.extract_page_layout = extract_page_layout
    rich._add_text_box = _add_text_box_with_overflow
    rich.ENGINE_VERSION = ENGINE_VERSION
    core.edit_pdf = rich.edit_pdf
    core.ENGINE_VERSION = ENGINE_VERSION
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(
        (args.host, args.port),
        lambda *handler_args, **handler_kwargs: LuminaTransactionalHandler(
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
