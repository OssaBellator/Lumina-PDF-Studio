#!/usr/bin/env python3
"""Generated-PDF test for Lumina's inline document editing operation."""
from __future__ import annotations

import pymupdf

import server_v2


def make_pdf() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 110), "Editable source sentence", fontsize=14, fontname="helv")
    return document.tobytes()


def main() -> None:
    source = make_pdf()
    opened = pymupdf.open(stream=source, filetype="pdf")
    target = opened[0].search_for("Editable source sentence")[0]
    opened.close()

    output, report = server_v2.edit_pdf(source, [{
        "type": "replace_text_region",
        "page": 0,
        "rect": [target.x0, target.y0, target.x1, target.y1],
        "originalText": "Editable source sentence",
        "replacement": "Edited directly on page",
        "fontSize": 14,
        "minimumFontSize": 5,
    }])

    result = pymupdf.open(stream=output, filetype="pdf")
    text = result[0].get_text()
    result.close()
    assert "Edited directly on page" in text, text
    assert "Editable source sentence" not in text, text
    operation = report["operations"][0]
    assert operation["type"] == "replace_text_region"
    assert operation["page"] == 0
    print("Lumina document edit test passed.")


if __name__ == "__main__":
    main()
