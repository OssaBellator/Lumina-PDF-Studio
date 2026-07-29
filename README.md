# Lumina PDF Studio

Lumina PDF Studio is a local-first workspace for viewing, combining, editing, annotating, organising, understanding, and exporting PDFs.

## Highlights

- Open several PDFs together and merge their pages into one workspace.
- Drag pages to reorder them; rotate, duplicate, delete, or insert blank pages.
- Shift-click page thumbnails and export only the selected range.
- Edit searchable PDF text inline while preserving the original style where the embedded font supports the replacement characters.
- Double-click blank page space—or click blank space and start typing—to create text anywhere on the page.
- Grow text boxes automatically as new lines are entered.
- Shift/Ctrl/Cmd-click or drag a marquee to select multiple page objects, then move, format, duplicate, or delete them together.
- Hide deleted source text, images, equations, and annotations immediately instead of waiting for Save & Read.
- Undo and redo both unsaved object edits and previously saved PDF revisions.
- Detect and group nearby mathematical fragments, including multi-row matrices, into one editable equation region.
- Add movable and resizable text, images, highlights, comments, rectangles, ink, equations, and whiteout regions directly on the page.
- Search text extracted from every loaded PDF.
- Read and update native AcroForm fields without flattening them into canvas annotations.
- Detect signature fields and block source mutations that would invalidate a digital signature.
- Connect OpenRouter, OpenAI/Codex models, LM Studio, Ollama, or another OpenAI-compatible chat-completions endpoint.
- Let AI answer document questions and propose source-PDF edits through a review queue.
- Automatically place long AI answers in available space or on a continuation page instead of failing because a small rectangle cannot contain them.
- Export a new PDF assembled from every source document and approved edit.

## Run locally

Install the native engine dependency and start the same-origin server:

```bash
python3 -m pip install -r requirements.txt
npm start
```

Open `http://127.0.0.1:4173`.

The server binds to loopback by default, serves the static app, and exposes narrowly scoped endpoints under `/api/pdf`. It does not upload documents to Lumina or a third-party service. Cloud AI providers receive extracted document text only when document context is enabled and the user sends a prompt.

### Browser-only mode

The interface still works without PyMuPDF:

```bash
npm run start:static
```

In browser-only mode, merging, page organisation, annotations, AI connections, and flattened export remain available. The status button in the top bar shows `Browser mode`, and native source-text/form editing is unavailable.

## Document edit mode

Open a PDF and select **Edit PDF**.

- Double-click searchable text to type directly into it.
- Double-click blank space to create a text box at that position.
- Click blank space and start typing, or press Enter, to begin a text box there.
- Hold Shift, Ctrl, or Cmd while clicking to add or remove objects from the current selection.
- Drag over blank page space with the Select tool to marquee-select several objects.
- Use the centre handle to move the selected object or selected group.
- Press Delete to remove selected content. Source content disappears from the edit preview immediately and is removed natively when saved.
- Press `Ctrl/Cmd + Z` and `Ctrl/Cmd + Shift + Z` for draft edits. Once all draft edits are undone, the same controls step backward and forward through saved source-PDF revisions.
- Choose **Save & Read** to write the transaction into the PDF and return to a normal reader view.

PDF remains a fixed-layout format. Lumina can expand boxes, wrap text, and append continuation pages, but it cannot guarantee Word-style reflow through arbitrary columns, tables, footnotes, or graphics.

## Native PDF engine

Open a PDF and select **Native engine** in the top bar.

The current engine supports:

- PDF structure, metadata, permission, repair, form, and signature inspection.
- Exact searchable-text replacement on the current source page or all source pages.
- Native AcroForm text, checkbox, radio, list, and combo field updates.
- Metadata updates through the API.
- Native text insertion into a specified PDF rectangle through the API.
- Grouping adjacent mathematical fragments into a larger equation or matrix region.
- Automatic continuation-page fallback for text that cannot fit safely in its requested area.
- Up to twenty in-memory source revisions per imported document, available to edit-mode undo and redo.

Text replacement is implemented as PDF redaction followed by new page-content insertion in the selected region. This removes the selected source text from the content seen by normal PDF readers instead of merely painting a white rectangle over it. The engine preserves the detected font size, colour, and embedded font where practical and falls back to a compatible PDF font when required.

The engine refuses to mutate signed PDFs by default. Rewriting a signed PDF generally invalidates its existing signature; Lumina surfaces that boundary rather than silently producing a document that appears signed.

## Validation

```bash
npm run check
```

This validates every JavaScript entry point, compiles all Python services, and runs generated-PDF tests for analysis, forms, rich text replacement, image/equation placement, inline editing, Windows disconnect handling, matrix grouping, saved revisions, and AI text overflow.

## AI providers

| Provider | Default base URL |
| --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI / Codex | `https://api.openai.com/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Ollama | `http://localhost:11434/v1` |
| Custom | Any OpenAI-compatible base URL |

Enter a model ID supported by the selected server. API keys are stored in `sessionStorage`, so closing the browser session removes them. Provider metadata and permissions are stored locally.

Local model servers must permit browser requests from Lumina's origin. If a connection test fails while the server is running, check its CORS and authentication configuration.

## AI tool model

AI access is deliberately narrower than unrestricted human access. A connected model can propose only Lumina-native document actions:

- Correct or briefly rewrite exact searchable source text.
- Insert answers and explanations into available page space.
- Add a continuation page automatically when the content does not fit safely.
- Insert native text boxes and LaTeX equations.
- Add highlights, comments, rectangles, and other approved visual edits.
- Rotate, duplicate, move, or—when separately enabled—delete pages.
- Trigger an export when that permission is enabled.

Actions are shown in a review queue and do not run until the user approves them. Long replacements are converted into answer insertion rather than being forced into the original short text rectangle. The web app does not grant models shell access, browser-account access, arbitrary filesystem access, or unrestricted network access.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) for the design and trust boundaries.

## Important limitations

- Source-text editing works only for searchable text. Scanned documents require OCR first.
- Replacement typography is approximate when the original font is subsetted, unavailable, or uses complex shaping.
- Mathematical grouping is heuristic. Unusual vector-only equations may still need to be selected as a region and replaced with LaTeX.
- The engine does not structurally edit every possible vector path, transparency group, tagged-PDF element, or content-stream construction.
- Canvas annotations are still flattened during export rather than saved as fully editable native PDF annotations.
- Password-protected PDFs are not yet supported by the native engine.
- Direct browser use of cloud API keys is suitable for local personal use, not a multi-user production deployment. A server-side AI proxy and authenticated secret storage should be added before hosting publicly.

## Keyboard shortcuts

- `Ctrl/Cmd + O`: add PDFs
- `Ctrl/Cmd + F`: search
- `Ctrl/Cmd + Z`: undo the current edit, then older saved PDF revisions
- `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y`: redo
- `Ctrl/Cmd + D`: duplicate the selected object
- `V`: select
- `H`: pan
- `T`: text
- `M`: highlight
- `P`: draw
- `C`: comment
- Arrow keys: previous or next page
- `Delete`: remove the selected object or selected group
