# Lumina PDF Studio

Lumina PDF Studio is a local-first workspace for viewing, combining, annotating, understanding, and carefully editing PDFs.

## Smart Edit 4.0

The primary editor is now **source-preserving**. Lumina no longer converts every PDF into a guessed DOCX layout before editing.

Smart Edit keeps the original PDF page as the visual source of truth and adds a typed interaction layer containing stable regions such as text, headings, formulas, tables, and pictures. Untouched regions are never repainted, duplicated, or regenerated.

When you choose **Save & Read**, Lumina changes only the approved regions and returns to the normal PDF reader.

### What this fixes

- Mathematical content is not split into individual numbers or duplicated as many image cards.
- Tables, diagrams, and uncertain regions remain intact instead of being reconstructed incorrectly.
- Double-clicking a confident text region edits that whole source block.
- Formula replacement targets one grouped formula region.
- Long answers are placed in safe page space or on a new page.
- AI actions target stable block IDs instead of guessing page coordinates or text rectangles.
- Unchanged pages retain their original fonts, vectors, images, and layout.

## Highlights

- Open and merge several PDFs.
- Reorder, rotate, duplicate, delete, and select pages.
- Use **Smart Edit** for source-preserving structured changes.
- Add new text anywhere on a page.
- Replace a complete formula with LaTeX-rendered vector content.
- Multi-select regions with Shift/Ctrl/Cmd-click or a drag marquee.
- Undo and redo up to 100 Smart Edit transactions.
- Keep source-PDF revisions for restoration.
- Add highlights, comments, drawings, shapes, images, and other canvas annotations.
- Search extracted text and update AcroForm fields.
- Connect OpenRouter, OpenAI/Codex, LM Studio, Ollama, or another OpenAI-compatible provider.
- Review every AI edit before it changes the PDF.

## Run locally

```bash
python3 -m pip install -r requirements.txt
npm start
```

Open `http://127.0.0.1:4173`.

`npm start` launches `server_v8.py`. The server binds to loopback by default. PDFs remain on the local machine; cloud AI providers receive document content only when document context is enabled and the user sends a prompt.

### Optional accurate document analysis

Fast Smart Edit analysis uses PyMuPDF and works with the normal requirements.

For more advanced reading order, layout labels, table structure, OCR, formula enrichment, and source provenance, install the optional Docling pipeline:

```bash
python3 -m pip install -r requirements-accurate.txt
npm start
```

Select **Accurate (Docling)** from the Smart Edit ribbon and reanalyse the document. The first accurate run may download local model assets.

Accurate mode remains optional because its dependencies and models are substantially larger than the fast local engine.

### Browser-only mode

```bash
npm run start:static
```

Browser-only mode retains viewing, merging, page organisation, annotations, AI connections, and flattened export. Smart Edit, native forms, and source-region PDF changes require `npm start`.

## Smart Edit workflow

1. Open a PDF and choose **Smart Edit**.
2. Lumina analyses the PDF into typed regions with page coordinates and provenance.
3. The original page remains visible underneath the interaction layer.
4. Double-click confident text to edit it.
5. Select a complete formula and choose **Replace math** to provide LaTeX.
6. Press `T` or select **Add text**, then click blank page space.
7. Review the temporary source masks and replacements.
8. Choose **Save & Read**.
9. Lumina redacts only changed source regions, inserts approved replacements, and reloads the PDF.

Tables, pictures, diagrams, and low-confidence regions are preserved by default. The inspector shows each region's type, confidence, source backend, and edit state.

See [SMART_EDIT.md](SMART_EDIT.md) for architecture, import modes, AI tools, and design boundaries.

## AI workflow

AI receives a structured list containing stable block IDs, page numbers, region types, editability, and extracted text. It never needs to invent coordinates.

Supported Smart Edit tools are:

- `hybrid_replace_block`
- `hybrid_delete_block`
- `hybrid_insert_after`
- `hybrid_append_page`
- `hybrid_replace_formula`

Short corrections replace a specific editable block. Long answers use available space or append a new page. Formula changes target a complete formula block. Approved operations open in Smart Edit for human review before saving.

AI access remains permission-gated. Models do not receive shell access, browser-account access, unrestricted filesystem access, arbitrary network access, or credentials beyond the provider key configured for the current browser session.

## Other editing tools

The existing page-coordinate and reflow implementations remain in the codebase for compatibility and migration, but they are no longer the primary Edit-button workflow.

Canvas tools remain useful for:

- Highlights and comments
- Freehand drawing and rectangles
- Images and visual overlays
- Page organisation and export

The native engine still supports PDF inspection, forms, metadata, source revision restoration, and signed-document protection.

## Validation

```bash
npm run check
```

The suite validates every JavaScript entry point, compiles all Python services, and runs generated-PDF tests covering:

- Fragmented matrix grouping into complete formula regions
- Source-background preservation without equation crop duplication
- Stable block IDs and provenance
- Exact changed-region replacement
- Formula SVG insertion
- New page-positioned text
- Long-answer continuation pages
- AI block-ID tools
- Existing forms, images, equations, revisions, reflow compatibility, and Windows transport handling

## AI providers

| Provider | Default base URL |
| --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI / Codex | `https://api.openai.com/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Ollama | `http://localhost:11434/v1` |
| Custom | Any OpenAI-compatible base URL |

API keys are stored in `sessionStorage`; closing the browser session removes them. Local model servers must allow requests from Lumina's origin.

## Important boundaries

- PDF is a fixed-layout final-form format, not a Word-processing format.
- Fast analysis is conservative and may preserve a region rather than make a dangerous edit guess.
- Accurate Docling analysis improves structure recognition but cannot guarantee perfect reconstruction for every PDF.
- Scanned pages need OCR before text becomes editable; Accurate mode can provide local OCR when its dependencies are installed.
- Formula recognition may still require manual LaTeX transcription for unusual notation.
- Source-region replacement cannot preserve a digital signature; signed PDFs remain protected from mutation.
- Password-protected PDFs are not yet supported by the native engine.
- Direct browser use of cloud API keys is intended for local personal use, not a public multi-user deployment.

## Keyboard shortcuts

- `Ctrl/Cmd + O`: add PDFs
- `Ctrl/Cmd + F`: search
- `Ctrl/Cmd + S`: save Smart Edit changes and return to read mode
- `Ctrl/Cmd + Z`: undo
- `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y`: redo
- `T`: place new text in Smart Edit
- `Delete`: remove selected Smart Edit regions
- Arrow keys: previous or next PDF page in read mode
