# Architecture

## Runtime

Lumina PDF Studio is a static browser application:

- **PDF.js** renders source PDF pages and extracts text.
- **PDF-Lib** creates sample/blank pages and assembles the exported PDF.
- **SVG** is the editable overlay for annotations and placed content.
- **Browser memory** stores loaded PDF bytes, page order, and annotations for the current session.

Each imported PDF becomes an immutable source document. The workspace maintains an ordered list of page references:

```text
workspace page -> source document ID + source page index + rotation + annotations
```

This allows pages from several PDFs to be rearranged without rewriting source files. Export copies each referenced source page into a new PDF and then draws the approved edits on top.

## Canvas editing

All coordinates are normalised from `0` to `1` with the origin at the top-left. That makes edits independent of zoom level and source page size.

Editable overlay types:

- text
- image
- highlight
- whiteout
- rectangle
- freehand drawing
- comment marker

The select tool supports dragging every object and resizing objects with rectangular bounds. Text and comments can also be edited from the inspector or by double-clicking.

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

The app intentionally does not expose a generic URL fetcher, browser automation, shell commands, local filesystem traversal, credential access, or arbitrary JavaScript execution as AI tools.

## Production evolution

A hosted multi-user version should add:

- A same-origin backend for AI requests and secret management.
- Authentication, encrypted document storage, and per-document access control.
- A durable workspace format for editable projects.
- OCR for scanned documents.
- Native PDF annotation/form support.
- Content Security Policy and self-hosted dependencies.
- Sandboxed, auditable external tools with per-tool OAuth and approval policies.
