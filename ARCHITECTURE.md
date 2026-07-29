# Architecture

## Runtime modes

Lumina PDF Studio has two compatible runtime modes.

### Browser workspace

- **PDF.js** renders source PDF pages and extracts text.
- **PDF-Lib** creates sample/blank pages and assembles browser exports.
- **SVG** is the editable overlay for annotations and placed content.
- **Browser memory** stores loaded PDF bytes, page order, annotations, and AI settings for the current session.

Each imported PDF becomes a source document. The workspace maintains an ordered list of page references:

```text
workspace page -> source document ID + source page index + rotation + annotations
```

This lets pages from several PDFs be rearranged without rewriting every source file. Export copies each referenced source page into a new PDF and draws approved canvas edits on top.

### Local native engine

`server.py` serves the static app and a loopback-only JSON/multipart API powered by PyMuPDF:

```text
GET  /api/health
POST /api/pdf/analyze
POST /api/pdf/edit
```

The browser sends one source PDF and a bounded list of typed operations. The engine returns either analysis JSON or a modified PDF plus an operation report. It does not accept arbitrary Python, shell commands, filesystem paths, or URLs.

Supported native operations are:

```text
replace_text
set_form_field
set_metadata
add_text
```

`replace_text` searches page text, records nearby span styling, creates PDF redaction annotations, applies those redactions, and inserts replacement content into the original rectangle. This is structurally different from the canvas whiteout tool: the matched source content is removed from the rewritten PDF page stream.

The browser replaces the source document bytes in memory and reloads PDF.js. Up to ten prior source revisions are kept in memory for explicit restore. Workspace page references remain valid because current native operations do not change page count.

## Canvas editing

All canvas coordinates are normalised from `0` to `1` with the origin at the top-left. That makes edits independent of zoom level and source page size.

Editable overlay types:

- text
- image
- highlight
- whiteout
- rectangle
- freehand drawing
- comment marker

The select tool supports dragging every object and resizing objects with rectangular bounds. Text and comments can also be edited from the inspector or by double-clicking.

## Forms and signatures

The analysis endpoint walks each page's widget chain while retaining the page object required by PyMuPDF. It reports field type, value, choices, flags, rectangle, and signature status.

AcroForm updates modify widget values and call `Widget.update()`, preserving field interactivity. Signature widgets are read-only. If the document contains a signed field or a signature policy indicating non-incremental changes would invalidate a signature, mutation is rejected unless a future trusted caller explicitly opts into invalidation.

Lumina currently writes a new cleaned PDF for native edits rather than attempting an incremental signature-preserving update.

## AI adapter

Cloud and local providers share the OpenAI-compatible `POST /chat/completions` request shape. Provider presets change only the base URL and optional headers.

The system prompt requests JSON with this contract:

```json
{
  "message": "Human-readable response",
  "actions": [
    {
      "tool": "add_text",
      "args": {
        "page": 1,
        "x": 0.1,
        "y": 0.1,
        "text": "Example"
      }
    }
  ]
}
```

Returned actions pass through three controls:

1. Schema validation and a known-tool allowlist.
2. User-configured permission categories.
3. A visible review queue requiring approval.

The app intentionally does not expose a generic URL fetcher, browser automation, shell commands, local filesystem traversal, credential access, or arbitrary JavaScript execution as AI tools. Native source operations are not yet model-callable.

## Production evolution

A hosted multi-user version should add:

- A separately deployed API with authentication, CSRF protection, request timeouts, quotas, and isolated worker processes.
- A same-origin backend for AI requests and secret management.
- Encrypted document storage and per-document access control.
- A durable workspace format for editable projects.
- OCR for scanned documents.
- Native PDF annotations and a richer content-object editor.
- Content Security Policy and self-hosted dependencies.
- Sandboxed, auditable external tools with per-tool OAuth and approval policies.
- PDF parser fuzzing and validation across multiple independent readers.
