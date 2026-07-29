#!/usr/bin/env python3
"""Generated-PDF tests for Lumina's structured rich edit engine."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server_v3


def find_font() -> str | None:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
    ]
    return next((path for path in candidates if Path(path).exists()), None)


def make_fixture() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    font_path = find_font()
    if font_path:
        page.insert_font(fontname="FixtureFont", fontfile=font_path)
        page.insert_text((72, 100), "Solve x² + y² = 1", fontname="FixtureFont", fontsize=14)
    else:
        page.insert_text((72, 100), "Solve x2 + y2 = 1", fontname="tiro", fontsize=14)
    page.insert_text((72, 135), "Question 1", fontname="hebo", fontsize=12)
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 30, 18), 0)
    pixmap.clear_with(0x6E55E7FF)
    page.insert_image(pymupdf.Rect(72, 170, 192, 242), pixmap=pixmap)
    return document.tobytes(garbage=4, deflate=True)


def main() -> None:
    source = make_fixture()
    layout = server_v3.extract_page_layout(source, 0)
    assert layout["width"] == 612
    assert any(item["kind"] in ("text", "math") for item in layout["objects"])
    assert any(item["kind"] == "image" and item["dataUrl"] for item in layout["objects"])

    text_object = next(item for item in layout["objects"] if item.get("text", "").startswith("Solve"))
    image_object = next(item for item in layout["objects"] if item["kind"] == "image")
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80"><text x="8" y="55" font-size="34">x + y = 2</text></svg>'
    svg_url = "data:image/svg+xml;base64," + base64.b64encode(svg).decode("ascii")

    operations = [
        {
            "type": "replace_text_region",
            "page": 0,
            "sourceRect": text_object["rect"],
            "targetRect": text_object["rect"],
            "originalText": text_object["text"],
            "replacement": "Solve",
            "fontXref": text_object["style"]["fontXref"],
            "fontSize": text_object["style"]["fontSize"],
            "fitMode": "shrink",
            "preserveOriginalFont": True,
        },
        {
            "type": "place_asset",
            "page": 0,
            "sourceRect": image_object["rect"],
            "targetRect": [250, 170, 490, 314],
            "dataUrl": image_object["dataUrl"],
            "mime": image_object["mime"],
            "removeImages": True,
            "keepProportion": False,
        },
        {
            "type": "add_text_box",
            "page": 0,
            "rect": [72, 350, 540, 455],
            "text": "This answer is inserted into available space and wraps without replacing the original question.",
            "fontFamily": "Helvetica",
            "fontSize": 12,
            "lineHeight": 1.25,
        },
        {
            "type": "place_asset",
            "page": 0,
            "targetRect": [72, 480, 292, 560],
            "dataUrl": svg_url,
            "mime": "image/svg+xml",
        },
        {
            "type": "append_text_page",
            "title": "Continued solution",
            "text": "Long AI answers can continue on a new page when the source page has no safe blank area.",
        },
    ]

    output, report = server_v3.edit_pdf(source, operations)
    assert len(report["operations"]) == len(operations)
    replacement_report = report["operations"][0]
    assert replacement_report["fontSize"] >= 13.5, replacement_report

    result = pymupdf.open(stream=output, filetype="pdf")
    assert result.page_count == 2
    first_text = result[0].get_text()
    second_text = result[1].get_text()
    assert "Solve" in first_text
    assert "This answer is inserted" in first_text
    assert "Continued solution" in second_text
    assert len(result[0].get_images(full=True)) >= 1
    result.close()
    print("Lumina rich edit tests passed.")


if __name__ == "__main__":
    main()
