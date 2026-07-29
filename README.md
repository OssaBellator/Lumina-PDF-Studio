# Lumina PDF Studio

Lumina PDF Studio is a local-first browser workspace for viewing, combining, editing, annotating, organising, understanding, and exporting PDFs.

## Highlights

- Open several PDFs together and merge their pages into one workspace.
- Drag pages to reorder them; rotate, duplicate, delete, or insert blank pages.
- Shift-click page thumbnails and export only the selected range.
- Add movable and resizable text, images, highlights, comments, rectangles, ink, and whiteout regions directly on the page.
- Visually replace existing content with a whiteout region plus editable text.
- Search text extracted from every loaded PDF.
- Connect OpenRouter, OpenAI/Codex models, LM Studio, Ollama, or another OpenAI-compatible chat-completions endpoint.
- Let AI answer document questions and propose edits through a review queue.
- Keep destructive AI tools disabled until the user explicitly enables them.
- Export a new flattened PDF assembled from every source document and approved edit.

## Run locally

```bash
npm start
```

Open `http://localhost:4173`.

No build step is required. The app loads PDF.js, PDF-Lib, Lucide, and Google Fonts from public CDNs. Documents remain in browser memory unless the user sends extracted text to a configured AI provider.

## Validation

```bash
npm run check
```

This checks JavaScript syntax and verifies the expected static application entry points.

## AI providers

The settings panel supports these presets:

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

See [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) for the design and trust boundaries.

## Important limitations

- Existing PDF text is not structurally rewritten. Lumina performs visual replacement using whiteout plus new text and flattens the result during export. True content-stream editing requires a more specialised PDF engine and careful font reconstruction.
- Scanned documents require OCR before search or AI context can read their text.
- Annotations are flattened during PDF export rather than saved as fully editable native PDF annotations.
- Direct browser use of cloud API keys is suitable for local personal use, not a multi-user production deployment. A server-side proxy and authenticated secret storage should be added before hosting publicly.
- Encrypted, signed, malformed, or unusually complex PDFs may not export correctly.

## Keyboard shortcuts

- `Ctrl/Cmd + O`: add PDFs
- `Ctrl/Cmd + F`: search
- `Ctrl/Cmd + Z`: undo
- `Ctrl/Cmd + Shift + Z`: redo
- `V`: select
- `H`: pan
- `T`: text
- `M`: highlight
- `P`: draw
- `C`: comment
- Arrow keys: previous or next page
- `Delete`: remove the selected canvas object
