# Lumina PDF Studio

Lumina PDF Studio is a local-first workspace for viewing, combining, editing, annotating, organising, understanding, and exporting PDFs.

## Highlights

- Open several PDFs together and merge their pages into one workspace.
- Drag pages to reorder them; rotate, duplicate, delete, or insert blank pages.
- Shift-click page thumbnails and export only the selected range.
- Convert a PDF into a flowing DOCX-style document for reliable editing.
- Edit paragraphs, headings, lists, quotes, equations, tables, images, and page breaks in a Word-like canvas.
- Use rich-text formatting, alignment, document styles, an outline, block movement, duplication, deletion, and 100-step undo/redo.
- Download the editable result as DOCX or Markdown at any time.
- Choose **Save & Read** to regenerate a normal PDF from the edited document.
- Keep the previous PDF as a restorable source revision.
- Use the optional **Layout** editor for exact page-coordinate adjustments.
- Connect OpenRouter, OpenAI/Codex models, LM Studio, Ollama, or another OpenAI-compatible endpoint.
- Let AI use the same paragraph, section, table, equation, formatting, and document-text operations as the user.
- Review all AI edits in Reflow Edit before regenerating the PDF.
- Search extracted text, update AcroForm fields, annotate pages, and export assembled PDFs.

## Run locally

Install the native engine and DOCX dependencies, then start the same-origin server:

```bash
python3 -m pip install -r requirements.txt
npm start
```

Open `http://127.0.0.1:4173`.

`npm start` launches `server_v6.py`. The server binds to loopback by default and exposes narrowly scoped endpoints under `/api/pdf` and `/api/document`. PDFs and editable document models remain on the local machine. Cloud AI providers receive document content only when document context is enabled and the user sends a prompt.

### Optional LibreOffice conversion

Lumina always creates a real DOCX. When LibreOffice is installed, Lumina uses it to convert that DOCX back to PDF.

Detected commands and locations include:

- `libreoffice`
- `soffice`
- Common Windows LibreOffice installation paths
- A custom executable supplied through `LUMINA_OFFICE`

When LibreOffice is unavailable, Lumina uses its built-in PyMuPDF reflow renderer. The fallback supports pagination, headings, paragraphs, lists, editable math text, tables, images, alignment, colours, font sizes, and page breaks.

### Browser-only mode

```bash
npm run start:static
```

Browser-only mode retains viewing, merging, page organisation, canvas annotations, AI connections, and flattened export. DOCX-backed Reflow Edit, native forms, and source-PDF operations require `npm start`.

## Reflow Edit

Open a PDF and choose **Edit document**.

Lumina reconstructs a flowing document model containing:

- Paragraphs and headings
- Bulleted and numbered list items
- Quotes
- Grouped mathematical content, including multi-row matrix text
- Simple tables
- Embedded images
- Explicit page breaks

The ribbon provides:

- Undo and redo
- Paragraph and heading styles
- Font family, size, bold, italic, underline, and colour
- Left, centre, right, and justified alignment
- Text, equation, table, image, and page-break insertion
- Block movement, duplication, and deletion
- DOCX and Markdown downloads
- A heading outline for navigation

Choose **Save & Read** to create the DOCX, regenerate the active PDF, and return to the normal reader. The prior PDF is stored in the source revision history.

The conversion is reconstructive rather than lossless. PDFs usually store positioned glyphs and drawing instructions, not Word paragraphs or tables. Reflow Edit prioritises editability and reliable content insertion over pixel-perfect reproduction. See [REFLOW_EDITING.md](REFLOW_EDITING.md).

## Layout Edit

Choose **Layout** beside the main edit button for the previous fixed-coordinate editor. It remains useful for:

- Moving and resizing existing page objects
- Adding page-positioned text, images, and equations
- Exact source-region replacement
- Whiteout and visual object work

Use Reflow Edit for document-style authoring and Layout Edit for page-specific finishing.

## AI document workflow

Connected AI providers can propose:

- `document_replace_text`
- `document_insert_after`
- `document_append`
- `document_insert_equation`
- `document_insert_table`
- `document_format`
- `document_delete`
- `document_set_title`

Legacy proposals such as `edit_text`, `insert_answer`, and `add_native_text` are converted into document-model operations. Long answers are paragraphs or sections, not replacements forced into a small PDF rectangle.

Approved AI operations open Reflow Edit for human review. They do not immediately overwrite the source PDF. After review, **Save & Read** generates the DOCX and reader PDF.

AI access remains permission-gated. Models do not receive shell access, browser-account access, unrestricted filesystem access, arbitrary network access, or credentials beyond the provider key explicitly configured for the current browser session.

## Native PDF engine

The native engine still supports:

- PDF structure, metadata, permission, repair, form, and signature inspection
- Searchable-text and region replacement
- AcroForm text, checkbox, radio, list, and combo updates
- Native text, image, and equation placement
- Grouped mathematics for the Layout editor
- Source revision restoration

Signed PDFs remain protected from in-place source mutation. Reflow Edit creates a new regenerated PDF; it does not preserve the original digital signature.

## Validation

```bash
npm run check
```

The suite validates all JavaScript entry points, compiles every Python service, and runs generated-document tests for PDF extraction, DOCX package creation, Markdown conversion, fallback PDF pagination, headings, matrices, tables, page breaks, rich text, forms, source editing, images, equations, revision handling, AI operations, and Windows client disconnects.

## AI providers

| Provider | Default base URL |
| --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI / Codex | `https://api.openai.com/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Ollama | `http://localhost:11434/v1` |
| Custom | Any OpenAI-compatible base URL |

API keys are stored in `sessionStorage`; closing the browser session removes them. Provider metadata and permissions are stored locally. Local model servers must allow browser requests from Lumina's origin.

## Important limitations

- Scanned PDFs require OCR before text can become editable.
- PDF reading order can be ambiguous, especially with multiple columns, floating text, headers, footers, and footnotes.
- Complex tables may require cleanup after conversion.
- Vector-only equations may become editable plain math text rather than perfect native Word equations.
- DOCX-to-PDF output can differ between LibreOffice, Microsoft Word, and Lumina's built-in renderer.
- Password-protected PDFs are not yet supported by the native engine.
- Canvas annotations are flattened during standard PDF export.
- Direct browser use of cloud API keys is intended for local personal use, not a public multi-user deployment.

## Keyboard shortcuts

- `Ctrl/Cmd + O`: add PDFs
- `Ctrl/Cmd + F`: search
- `Ctrl/Cmd + S`: save the flowing document and return to read mode
- `Ctrl/Cmd + Z`: undo in Reflow Edit
- `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y`: redo
- Arrow keys: previous or next PDF page in read mode
- `Delete`: remove the selected Reflow block or selected Layout object
