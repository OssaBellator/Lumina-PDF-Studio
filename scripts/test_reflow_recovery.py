#!/usr/bin/env python3
"""Regression tests for equation fidelity and resilient DOCX/PDF rendering."""
from __future__ import annotations

import io
import math
import sys
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import document_reflow_safe as safe


def fixture_pdf() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 72), "Matrix worksheet", fontsize=18, fontname="hebo")
    page.insert_text((110, 130), "( -3   1 )", fontsize=13)
    page.insert_text((110, 151), "(  2  -2 )", fontsize=13)
    page.insert_text((72, 210), "Safe paragraph after the equation.", fontsize=11)
    output = document.tobytes(garbage=4, deflate=True)
    document.close()
    return output


def test_equation_snapshot() -> dict:
    model = {
        "version": 1,
        "title": "Worksheet",
        "page": {"width": 612, "height": 792, "margin": 54},
        "blocks": [
            {
                "id": "unsafe-equation",
                "type": "equation",
                "text": "\ue000 = -3\n\ue001 = 2",
                "html": "\ue000 = -3<br>\ue001 = 2",
                "rect": [104, 112, 190, 162],
                "style": {"fontFamily": "SubsetMath", "fontSize": 13},
                "source": {"kind": "math", "page": 0},
            },
            {
                "id": "safe-text",
                "type": "paragraph",
                "text": "Safe paragraph after the equation.",
                "html": "Safe paragraph after the equation.",
                "rect": [72, 198, 300, 218],
                "style": {"fontFamily": "Arial", "fontSize": 11},
                "source": {"kind": "text", "page": 0},
            },
        ],
    }
    preserved, warnings = safe.preserve_complex_math(fixture_pdf(), model)
    snapshot = preserved["blocks"][0]
    assert snapshot["type"] == "image", snapshot
    assert snapshot["source"]["kind"] == "equation_snapshot", snapshot
    assert snapshot["dataUrl"].startswith("data:image/png;base64,"), snapshot
    assert warnings, warnings
    return preserved


def test_sanitized_round_trip(model: dict) -> None:
    model["page"] = {"width": float("nan"), "height": None, "margin": -500}
    model["blocks"].extend([
        {
            "id": "malformed-table",
            "type": "table",
            "rows": [["Name", "Value"], ["Trace", -5], "not-a-row"],
            "style": {"fontFamily": None, "fontSize": float("inf"), "lineHeight": None},
        },
        {
            "id": "invalid-image",
            "type": "image",
            "dataUrl": "data:image/png;base64,not-valid-base64%%%",
            "width": None,
            "height": "bad",
            "alt": "Broken image",
        },
        {
            "id": "unsafe-text",
            "type": "paragraph",
            "text": "Private glyph \ue123 must not abort PDF output.",
            "html": "Private glyph \ue123 must not abort PDF output.",
            "style": {"fontFamily": "Missing Font", "fontSize": None, "lineHeight": 99},
        },
    ])
    result = safe.render_document_model(model, prefer_office=False)
    assert result["docx"][:2] == b"PK", result.keys()
    assert result["pdf"].startswith(b"%PDF"), result.keys()
    assert result["warnings"], result
    with zipfile.ZipFile(io.BytesIO(result["docx"])) as archive:
        names = archive.namelist()
        assert any(name.startswith("word/media/") for name in names), names
        xml = archive.read("word/document.xml").decode("utf-8")
        assert "Safe paragraph" in xml, xml
    pdf = pymupdf.open(stream=result["pdf"], filetype="pdf")
    try:
        text = "\n".join(page.get_text() for page in pdf)
        assert "Safe paragraph" in text, text
        assert pdf.page_count >= 1
    finally:
        pdf.close()


def test_emergency_pdf(model: dict) -> None:
    original = safe.legacy.model_to_fallback_pdf_bytes
    safe.legacy.model_to_fallback_pdf_bytes = lambda _model: (_ for _ in ()).throw(RuntimeError("forced fallback failure"))
    try:
        result = safe.render_document_model(model, prefer_office=False)
    finally:
        safe.legacy.model_to_fallback_pdf_bytes = original
    assert result["converter"] == "pymupdf-emergency", result
    assert result["recovered"] is True, result
    pdf = pymupdf.open(stream=result["pdf"], filetype="pdf")
    try:
        assert pdf.page_count >= 1
    finally:
        pdf.close()


def main() -> None:
    model = test_equation_snapshot()
    test_sanitized_round_trip(model)
    test_emergency_pdf(model)
    print("Lumina reflow recovery tests passed.")


if __name__ == "__main__":
    main()
