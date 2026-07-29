# Rich PDF edit mode

Lumina has separate **Read** and **Edit** modes. Read mode renders the saved source PDF normally. Edit mode adds a temporary object layer for manipulating content, then writes approved changes back into the PDF when **Save & Read** is selected.

## Editing text

1. Run `npm start` and open a PDF.
2. Select **Edit PDF**.
3. Double-click a text line to edit it in place.
4. Use the ribbon for font family, exact font size, bold, italic, underline, colour, alignment, and line spacing.
5. Drag the selected object's top handle to move it or use any of its eight handles to resize its text area.
6. Use **Save & Read** or `Ctrl/Cmd + S` to write changes into the source PDF and return to a clean PDF view.

Unchanged source overlays are transparent. The original PDF canvas remains visible instead of being covered by white HTML text boxes.

When a source font is embedded and contains the replacement characters, the native engine extracts and reuses it. It attempts the original font size before reducing the size. Formatting changes deliberately switch to an appropriate standard font when the original embedded font cannot provide the requested style or glyphs.

## Undo, redo, and object controls

The edit session keeps up to 80 snapshots.

- `Ctrl/Cmd + Z`: undo
- `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y`: redo
- `Ctrl/Cmd + D`: duplicate the selected object
- `Delete` or `Backspace`: delete the selected object
- `Escape`: cancel the active text edit, equation tool, or selection
- **Cancel** in the top bar: discard every unsaved edit in the session

Text boxes, images, and equations can be selected, moved, duplicated, deleted, and resized. Images and equations preserve their aspect ratio during corner resizing; hold `Shift` to resize freely.

## Images

Use the ribbon's **Image** action or paste an image from the clipboard with `Ctrl/Cmd + V`. Existing raster image blocks detected by the native engine can also be moved and resized. Saving replaces the original image region and embeds the edited asset into the PDF.

Very large image blocks are not copied into the browser's editable layer. They remain visible in the PDF and are reported as unavailable for interactive editing.

## Equations and mathematical content

PDF mathematics is frequently stored as many individually positioned glyphs, custom subset fonts, or vector outlines rather than one editable equation. Lumina therefore keeps the original rendered mathematics visible and marks probable equation regions without repainting them as ordinary text.

Use **Equation** to:

- double-click a detected equation region;
- select a text or math region and choose **Equation**; or
- choose **Equation** and drag around any region on the page.

Enter LaTeX in the equation editor. Lumina renders it to SVG with MathJax and embeds it as scalable vector content, so the saved equation remains crisp at any zoom level. MathJax is currently loaded from a public CDN and therefore needs an internet connection the first time it is used.

## AI document editing

AI edits use four typed tools:

- `edit_text`: correct or briefly rewrite existing words while preserving nearby style;
- `insert_answer`: add a solution or explanation without deleting the original question;
- `add_native_text`: insert an explicitly positioned text box;
- `insert_equation`: add LaTeX mathematics as SVG.

`insert_answer` searches for blank space after the requested anchor. If the current page has no safe area, Lumina appends a new solution page instead of forcing the answer into the question's original rectangle. When a user asks to add the AI's previous response to the PDF and the provider returns no tool call, Lumina creates an `insert_answer` proposal automatically. All proposals still require approval.

## Current boundaries

PDF is a fixed-layout format rather than a flowing word-processing format. Lumina can edit and reposition detected lines and objects, but it cannot guarantee Word-style reflow across arbitrary columns, tables, footnotes, or pages.

- Scanned pages need OCR before text can be edited.
- Mathematics stored as vector outlines must be replaced by selecting its region and entering LaTeX.
- Some subset fonts lack replacement glyphs; Lumina falls back to a compatible standard font in that case.
- Rotated, vertical, clipped, or unusually encoded text may need manual resizing or equation replacement.
- Signed PDFs remain read-only because any content rewrite would invalidate the signature.
- Save edits on a copy when working with important source documents, especially those containing complex forms or signatures.
