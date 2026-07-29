# DOCX-backed Reflow Edit mode

Lumina 3 uses a flowing document model for its primary editor rather than trying to mutate every PDF glyph at its original coordinate.

## Workflow

1. The source PDF remains stored as an untouched revision.
2. `POST /api/document/import` extracts headings, paragraphs, lists, grouped mathematics, simple tables, and embedded images.
3. The browser edits those blocks in a Word-like flowing canvas.
4. AI providers use the same block operations as the browser editor.
5. **Save & Read** creates a DOCX and regenerates a normal PDF.
6. The generated PDF replaces the active reader document; the previous PDF remains available through source revision undo.

The legacy **Layout** editor remains available for page-coordinate adjustments that should not reflow.

## Canonical document model

The model is JSON so the browser and AI can use the same deterministic operations. Blocks include:

- paragraph
- heading
- list item
- quote
- equation
- table
- image
- page break

Text blocks support a limited rich-text subset: bold, italic, underline, inline colour, font family, font size, line breaks, code, subscript, and superscript. Block styles include alignment and line spacing.

## AI tools

Connected models can propose:

- `document_replace_text`
- `document_insert_after`
- `document_append`
- `document_insert_equation`
- `document_insert_table`
- `document_format`
- `document_delete`
- `document_set_title`

Legacy actions such as `edit_text`, `insert_answer`, and `add_native_text` are normalised into these document operations. Approved actions open Reflow Edit for review rather than writing directly into PDF rectangles.

## PDF generation

Lumina always generates a DOCX. For the reader PDF:

1. LibreOffice is used when `libreoffice` or `soffice` is available.
2. On Windows, common LibreOffice installation paths are detected.
3. `LUMINA_OFFICE` can point to a custom executable.
4. If no office converter is available, Lumina uses its built-in PyMuPDF reflow renderer.

The built-in renderer supports pagination, paragraphs, headings, lists, equations as editable text, tables, images, alignment, font size, colour, and explicit page breaks.

## Fidelity boundary

PDF is a fixed-layout final format. Many PDFs do not contain semantic paragraphs, tables, equations, headers, or reading order; they may contain only positioned glyphs and vector paths. Conversion is therefore reconstructive rather than lossless.

Reflow Edit prioritises editability and reliable AI insertion over pixel-perfect reproduction. Use **Layout** edit when exact original placement matters more than flowing document behaviour.

Current boundaries:

- Scanned pages still need OCR before text can become editable.
- Complex vector equations may be reconstructed as editable plain math rather than perfect native Word equations.
- Multi-column pages, footnotes, floating objects, and unusual reading order can require manual rearrangement.
- Headers and footers may be imported as ordinary blocks.
- Very complex tables may need cleanup after conversion.
- DOCX-to-PDF output can differ between LibreOffice, Microsoft Word, and Lumina's fallback renderer.
- Signed PDFs remain protected from source mutation; the regenerated document is a new PDF and does not preserve the original digital signature.
