#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pymupdf

from server import analyze_pdf, edit_pdf


def make_fixture() -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 96), "Hello world", fontsize=14, fontname="helv")
    widget = pymupdf.Widget()
    widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    widget.field_name = "customer_name"
    widget.field_label = "Customer name"
    widget.field_value = "Ada"
    widget.rect = pymupdf.Rect(72, 130, 260, 158)
    page.add_widget(widget)
    return document.tobytes(garbage=4, deflate=True)


def test_analysis(pdf_bytes: bytes) -> None:
    analysis = analyze_pdf(pdf_bytes)
    assert analysis["pageCount"] == 1
    assert analysis["isFormPdf"]
    field = next(item for item in analysis["formFields"] if item["name"] == "customer_name")
    assert field["value"] == "Ada"
    assert field["typeCode"] == pymupdf.PDF_WIDGET_TYPE_TEXT


def test_text_and_form_edit(pdf_bytes: bytes) -> None:
    output, report = edit_pdf(pdf_bytes, [
        {
            "type": "replace_text",
            "page": 0,
            "search": "Hello world",
            "replacement": "Hello Lumina",
            "occurrence": "all",
        },
        {
            "type": "set_form_field",
            "name": "customer_name",
            "value": "Grace",
        },
        {
            "type": "set_metadata",
            "values": {"title": "Engine test"},
        },
    ])
    assert report["operations"][0]["matches"] == 1
    edited = pymupdf.open(stream=output, filetype="pdf")
    try:
        text = edited[0].get_text("text")
        assert "Hello Lumina" in text
        assert "Hello world" not in text
        assert edited.metadata.get("title") == "Engine test"
        page = edited[0]
        widget = page.first_widget
        values = {}
        while widget:
            values[widget.field_name] = widget.field_value
            widget = widget.next
        assert values["customer_name"] == "Grace"
    finally:
        edited.close()


def main() -> None:
    fixture = make_fixture()
    test_analysis(fixture)
    test_text_and_form_edit(fixture)
    print("Lumina native engine tests passed.")


if __name__ == "__main__":
    main()
