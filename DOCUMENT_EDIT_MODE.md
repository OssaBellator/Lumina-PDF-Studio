# Document edit mode

Lumina now has two distinct page modes.

## Read mode

Read mode renders the source PDF normally through PDF.js. The editable text layer is removed, so the page behaves like an ordinary PDF again. Existing Lumina annotations remain separate until export.

## Edit mode

1. Start Lumina with `npm start` so the local PDF engine is available.
2. Open a PDF and choose **Edit PDF** in the top bar.
3. Double-click any searchable text run on the page.
4. Type the replacement directly in place.
5. Move between pages and continue editing.
6. Choose **Save & Read** or press `Ctrl/Cmd + S`.

Lumina groups pending edits by source document, sends exact page rectangles to the loopback PDF engine, rewrites those regions, reloads the modified source bytes, and returns to read mode. **Cancel** or `Escape` discards all unsaved inline changes.

## AI editing

The AI contract now exposes two native document tools:

- `edit_text`: replaces an exact searchable phrase on a specified page.
- `add_native_text`: inserts real PDF text into a specified page rectangle.

Providers that support OpenAI-style tool calls receive typed function schemas. If a provider rejects tool-calling fields, Lumina retries with the JSON-only instruction format. Approved native actions are routed through the same local PDF engine used by manual edit mode.

## Current limits

- Inline editing works on searchable PDF text. Scanned pages require OCR first.
- PDF text is stored as positioned runs rather than flowing paragraphs. Lumina makes those runs editable, but it does not yet reflow the whole page like a word processor.
- Replacement text must fit the original region; the engine reduces font size down to the configured minimum before reporting an error.
- Complex subset fonts, vertical writing, rotated text, and unusual character encodings may need manual adjustment.
- Signed PDFs remain read-only because rewriting their contents would invalidate the signature.
- Images and vector graphics remain selectable only through Lumina's existing canvas tools; this milestone focuses on source text and native form fields.
