# Lumina PDF Studio

Lumina PDF Studio is a local-first workspace for viewing, combining, editing, annotating, organising, understanding, and exporting PDFs.

## Highlights

- Open several PDFs together and merge their pages into one workspace.
- Drag pages to reorder them; rotate, duplicate, delete, or insert blank pages.
- Shift-click page thumbnails and export only the selected range.
- Add movable and resizable text, images, highlights, comments, rectangles, ink, and whiteout regions directly on the page.
- Search text extracted from every loaded PDF.
- Rewrite searchable source text through the optional local PDF engine.
- Read and update native AcroForm fields without flattening them into canvas annotations.
- Detect signature fields and block source mutations that would invalidate a digital signature.
- Connect OpenRouter, OpenAI/Codex models, LM Studio, Ollama, or another OpenAI-compatible chat-completions endpoint.
- Let AI answer document questions and propose edits through a review queue.
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

## Native PDF engine

Open a PDF and select **Native engine** in the top bar.

The current engine supports:

- PDF structure, metadata, permission, repair, form, and signature inspection.
- Exact searchable-text replacement on the current source page or all source pages.
- Native AcroForm text, checkbox, radio, list, and combo field updates.
- Metadata updates through the API.
- Native text insertion into a specified PDF rectangle through the API.
- Up to ten in-memory source revisions per imported document, restorable from the engine panel.

Text replacement is implemented as PDF redaction followed by new page-content insertion in the matched rectangle. This removes the matched source text from the content seen by normal PDF readers instead of merely painting a white rectangle over it. The engine preserves the detected font size and colour where practical and falls back to a base PDF font.

The engine refuses to mutate signed PDFs by default. Rewriting a signed PDF generally invalidates its existing signature; Lumina surfaces that boundary rather than silently producing a document that appears signed.

## Validation

```bash
npm run check
```

This validates JavaScript entry points, compiles the Python service, and runs native PDF analysis/edit tests against a generated PDF fixture.

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

- Add text, highlights, comments, rectangles, whiteout regions, and visual text replacements.
- Rotate, duplicate, move, or—when separately enabled—delete pages.
- Trigger an export when that permission is enabled.

Actions are returned as structured JSON and shown in a review queue. They do not run until the user approves them. The web app does not grant models shell access, browser-account access, arbitrary filesystem access, or unrestricted network access.

Native source mutations are currently user-operated in the engine panel rather than directly exposed to AI tools. This keeps exact text replacement and form writes behind an additional explicit human action while their schemas and audit trail mature.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) for the design and trust boundaries.

## Important limitations

- Source-text replacement works only for searchable text. Scanned documents require OCR first.
- Replacement typography is approximate when the original font is subsetted, embedded under a synthetic name, unavailable, or uses complex shaping.
- A replacement must fit the original match rectangle; substantially longer content may require an added text box or manual layout work.
- The engine does not edit arbitrary vector paths, images, transparency groups, tagged-PDF structure, or every possible content-stream construction.
- Canvas annotations are still flattened during export rather than saved as fully editable native PDF annotations.
- Password-protected PDFs are not yet supported by the native engine.
- Direct browser use of cloud API keys is suitable for local personal use, not a multi-user production deployment. A server-side AI proxy and authenticated secret storage should be added before hosting publicly.

## Keyboard shortcuts

- `Ctrl/Cmd + O`: add PDFs
- `Ctrl/Cmd + F`: search
- `Ctrl/Cmd + Z`: undo canvas/page operations
- `Ctrl/Cmd + Shift + Z`: redo canvas/page operations
- `V`: select
- `H`: pan
- `T`: text
- `M`: highlight
- `P`: draw
- `C`: comment
- Arrow keys: previous or next page
- `Delete`: remove the selected canvas object
