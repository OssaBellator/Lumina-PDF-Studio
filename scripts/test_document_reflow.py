#!/usr/bin/env python3
"""Regression tests for PDF -> document model -> DOCX/PDF reflow."""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import document_reflow


def fixture_pdf() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 72), "Linear Algebra Worksheet", fontsize=20, fontname="hebo")
    page.insert_text((72, 108), "Find the eigenvalues and eigenvectors of the following matrix.", fontsize=11)
    page.insert_text((116, 155), "( -3   1 )", fontsize=12)
    page.insert_text((116, 176), "(  2  -2 )", fontsize=12)
    page.insert_text((72, 224), "1. Explain each step clearly.", fontsize=11)
    return document.tobytes(garbage=4, deflate=True)


def test_import_model() -> dict:
    model = document_reflow.pdf_to_document_model(fixture_pdf(), "Worksheet")
    kinds = [block["type"] for block in model["blocks"]]
    assert "heading" in kinds, kinds
    assert "paragraph" in kinds, kinds
    equations = [block for block in model["blocks"] if block["type"] == "equation"]
    assert equations and "-3" in equations[0]["text"] and "-2" in equations[0]["text"], equations
    return model


def test_docx_and_markdown(model: dict) -> None:
    model["blocks"].extend([
        {"id": "table-test", "type": "table", "rows": [["Name", "Value"], ["Trace", "-5"]], "style": {"fontFamily": "Arial", "fontSize": 10}},
        {"id": "break-test", "type": "page_break"},
        {"id": "rich-test", "type": "paragraph", "html": "A <strong>bold</strong> conclusion with <em>emphasis</em>.", "style": {"fontFamily": "Arial", "fontSize": 11}},
    ])
    docx_bytes = document_reflow.model_to_docx_bytes(model)
    assert len(docx_bytes) > 1000
    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as archive:
        xml = archive.read("word/document.xml").decode("utf-8")
        assert "Linear Algebra Worksheet" in xml
        assert "Trace" in xml
        assert "w:pageBreakBefore" in xml or 'w:type="page"' in xml
    markdown = document_reflow.model_to_markdown(model)
    assert "#" in markdown and "| Name | Value |" in markdown and "$$" in markdown


def test_pdf_render(model: dict) -> None:
    result = document_reflow.render_document_model(model, prefer_office=False)
    assert result["converter"] == "pymupdf-reflow"
    pdf = pymupdf.open(stream=result["pdf"], filetype="pdf")
    try:
        assert pdf.page_count >= 2
        text = "\n".join(page.get_text() for page in pdf)
        assert "Linear Algebra Worksheet" in text
        assert "bold conclusion" in text
        assert "Trace" in text
    finally:
        pdf.close()


def main() -> None:
    model = test_import_model()
    test_docx_and_markdown(model)
    test_pdf_render(model)
    print("Lumina DOCX reflow tests passed.")


if __name__ == "__main__":
    main()
