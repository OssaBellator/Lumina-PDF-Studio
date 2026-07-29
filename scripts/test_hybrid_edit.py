#!/usr/bin/env python3
"""Regression tests for Lumina's source-preserving structured editor."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hybrid_document


def fixture_pdf() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 55), "MATH2010-MATH2100 Problem Sheet 1, Semester 2, 2022", fontsize=11, fontname="hebo")
    page.insert_text((72, 95), "Question 1 Find the eigenvalues and eigenvectors of the following matrices:", fontsize=11, fontname="hebo")
    # Deliberately fragmented matrix content reproduces the previous number-by-number importer failure.
    for x, text in [(80, "a)"), (110, "("), (125, "-3"), (155, "1"), (172, ")"), (220, "b)"), (250, "("), (265, "3"), (290, "6"), (305, ")")]:
        page.insert_text((x, 135), text, fontsize=11)
    for x, text in [(110, "("), (128, "2"), (155, "-2"), (172, ")"), (250, "("), (265, "1"), (290, "2"), (305, ")")]:
        page.insert_text((x, 154), text, fontsize=11)
    page.insert_text((72, 205), "Question 2 Explain your reasoning.", fontsize=11, fontname="hebo")
    return document.tobytes(garbage=4, deflate=True)


def test_import() -> tuple[bytes, dict, dict, dict]:
    pdf_bytes = fixture_pdf()
    model = hybrid_document.import_pdf_model(pdf_bytes, "Worksheet", "fast")
    page = model["pages"][0]
    formulas = [element for element in page["elements"] if element["kind"] == "formula"]
    assert 1 <= len(formulas) <= 2, formulas
    assert all("Problem Sheet" not in element["text"] for element in formulas)
    assert all("dataUrl" not in element for element in formulas), "Source formula regions must not be duplicated as crops"
    question = next(element for element in page["elements"] if "Question 2" in element.get("text", ""))
    assert question["editable"] is True
    return pdf_bytes, model, question, formulas[0]


def test_save(pdf_bytes: bytes, model: dict, question: dict, formula: dict) -> None:
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="5" y="27" font-size="22">x² + 1</text></svg>'
    asset = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
    result = hybrid_document.apply_model_changes(pdf_bytes, model, [
        {"type": "replace_text", "elementId": question["id"], "text": "Question 2 Solve and justify your answer."},
        {"type": "replace_formula", "elementId": formula["id"], "latex": "x^2+1", "assetDataUrl": asset},
        {"type": "add_text", "page": 0, "bbox": [72, 220, 360, 270], "text": "A new editable answer.", "style": {"fontSize": 11}},
        {"type": "append_page", "title": "Solutions", "text": "Long answers are placed on a new page instead of being squeezed into a source rectangle."},
    ])
    assert result["pageCount"] == 2
    output = pymupdf.open(stream=result["pdf"], filetype="pdf")
    try:
        text = "\n".join(page.get_text() for page in output)
        assert "Question 2 Solve and justify your answer." in text
        assert "Question 2 Explain your reasoning." not in text
        assert "A new editable answer." in text
        assert "Long answers are placed on a new page" in text
    finally:
        output.close()


def main() -> None:
    values = test_import()
    test_save(*values)
    print("Lumina hybrid structured edit tests passed.")


if __name__ == "__main__":
    main()
