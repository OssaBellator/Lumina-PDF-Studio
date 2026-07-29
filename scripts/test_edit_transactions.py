#!/usr/bin/env python3
"""Regression tests for grouped mathematics and safe text overflow."""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server_v5


def matrix_fixture() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 72), "Question 1", fontsize=13)
    fragments = [
        (100, 120, "("), (112, 120, "-3"), (145, 120, "1"), (160, 120, ")"),
        (100, 139, "("), (112, 139, "2"), (145, 139, "-2"), (160, 139, ")"),
    ]
    for x, y, text in fragments:
        page.insert_text((x, y), text, fontsize=12)
    return document.tobytes(garbage=4, deflate=True)


def test_grouped_matrix() -> None:
    layout = server_v5.extract_page_layout(matrix_fixture(), 0)
    groups = [item for item in layout["objects"] if item.get("kind") == "math" and item.get("grouped")]
    assert groups, layout["objects"]
    matrix = max(groups, key=lambda item: len(item.get("members") or []))
    assert len(matrix["members"]) >= 2, matrix
    assert "-3" in matrix["text"] and "-2" in matrix["text"], matrix
    assert matrix["rect"][2] - matrix["rect"][0] >= 45, matrix
    assert matrix["rect"][3] - matrix["rect"][1] >= 18, matrix


def test_text_overflow_appends_page() -> None:
    document = pymupdf.open()
    document.new_page(width=612, height=792)
    long_text = " ".join(["This answer must flow safely without failing the whole AI edit."] * 35)
    report = server_v5._add_text_box_with_overflow(document, {
        "type": "add_text_box",
        "page": 0,
        "rect": [72, 100, 190, 126],
        "text": long_text,
        "fontFamily": "Helvetica",
        "fontSize": 11,
        "lineHeight": 1.25,
        "minimumFontSize": 6,
        "fitMode": "reflow",
        "overflowPolicy": "append_page",
        "overflowTitle": "Continued answer",
    })
    assert document.page_count == 2, document.page_count
    assert report["overflow"] == "appended_page", report
    assert "Continued answer" in document[1].get_text(), document[1].get_text()
    document.close()


def main() -> None:
    test_grouped_matrix()
    test_text_overflow_appends_page()
    print("Lumina edit transaction tests passed.")


if __name__ == "__main__":
    main()
