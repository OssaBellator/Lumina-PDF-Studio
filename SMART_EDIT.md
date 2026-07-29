# Smart Edit architecture

Smart Edit replaces Lumina's automatic PDF-to-DOCX reconstruction as the primary editing workflow.

## Why the previous approach failed

A PDF commonly stores positioned text runs, subset-font glyph IDs, vector paths, images, and drawing commands. It does not necessarily contain Word-style paragraphs, tables, matrices, or equations.

The previous reflow importer tried to infer a complete flowing document from those fragments. On mathematical worksheets this produced several failure modes:

- One matrix became many unrelated number blocks.
- Subset-font symbols became missing Unicode squares.
- Repeated image crops duplicated content already visible on the source page.
- Reading-order guesses moved unrelated objects together.
- Regenerated DOCX and PDF output diverged from the source.
- AI actions inherited the same bad regions and were forced into guessed rectangles.

Smart Edit avoids those failure modes by never reconstructing untouched content.

## Core invariant

> The original PDF page is the visual source of truth. Recognition creates interaction targets, not replacement artwork.

Every imported element contains:

- A stable element ID
- A page number
- A bounding box
- A typed kind
- Extracted text or formula data when available
- An editability flag
- A confidence score
- Source backend and provenance metadata
- `sourceMode: background`

The editor draws only borders and labels over unchanged regions. It creates a temporary white source mask only after a user or approved AI action changes a region.

When saved, the native engine redacts only changed source rectangles and inserts their replacements. Everything else remains the original PDF content stream.

## Typed regions

Smart Edit recognizes:

- `text`
- `heading`
- `list`
- `caption`
- `formula`
- `table`
- `picture`
- `complex`

Text-like regions can be directly editable when their extraction is reliable. Formula, table, picture, and complex regions are preserved by default.

A formula is one grouped region rather than a list of glyphs. Replacing it is an explicit whole-region operation using LaTeX-rendered vector content.

## Import modes

### Fast local

The default importer uses PyMuPDF and requires no model download.

It extracts whole PDF text blocks, detects tables and pictures, groups neighboring mathematical blocks, and records source coordinates. Its heuristics are deliberately conservative: preserving an uncertain region is preferable to exposing a destructive edit target.

### Accurate with Docling

Accurate mode is optional and installed through `requirements-accurate.txt`.

Docling was selected because its native document model provides typed items, reading order, page and bounding-box provenance, table structure, OCR integration, and formula enrichment. Smart Edit maps those items into its source-preserving region model; it still keeps the original PDF page underneath.

Docling is not a mandatory dependency because its local models and inference stack are considerably heavier than the fast importer.

### Scanned PDFs

OCR is a recognition stage, not a layout editor. For scans, Accurate mode can use Docling OCR. OCRmyPDF is also a suitable preprocessing option when the desired result is a searchable PDF text layer. Neither OCR system guarantees semantic equations or Word-style structure by itself.

## Save transaction

Smart Edit sends the local engine:

1. The current source PDF bytes
2. The typed region model
3. A list of approved changes

Supported native changes are:

- `replace_text`
- `replace_formula`
- `delete`
- `add_text`
- `add_image`
- `append_page`

The engine indexes source elements by stable ID. Replace and delete operations derive their page and rectangle from the imported model rather than trusting AI-supplied coordinates.

Long content is not shrunk into a question label or instruction rectangle. It is placed in safe blank space when possible or written to a continuation page.

## AI contract

AI receives text such as:

```text
[p0-block-4 | page 1 | heading | editable:true]
Question 1 Find the eigenvalues and eigenvectors...
```

It can propose:

- `hybrid_replace_block`
- `hybrid_delete_block`
- `hybrid_insert_after`
- `hybrid_append_page`
- `hybrid_replace_formula`

The model selects stable block IDs. It does not invent bounding boxes. Approved proposals are applied to the same Smart Edit transaction shown to the user and remain reversible until Save & Read.

## Confidence policy

- High-confidence text is editable.
- Low-confidence text remains preserved.
- Tables and pictures remain preserved unless a dedicated editor is added.
- Formula regions are selectable as a whole but require explicit LaTeX replacement.
- Unknown complex regions are never silently converted into text.

Confidence is surfaced in the right-hand inspector so users can see why a region is editable or protected.

## Research references

- Docling documentation: https://docling-project.github.io/docling/
- Docling GitHub repository: https://github.com/docling-project/docling
- Docling formula understanding example: https://docling-project.github.io/docling/examples/formula_understanding/
- Docling document model: https://docling-project.github.io/docling/concepts/docling_document/
- OCRmyPDF documentation: https://ocrmypdf.readthedocs.io/

## Boundaries

No local or cloud parser can guarantee a lossless conversion from arbitrary PDF internals to a semantic word-processing document. Smart Edit therefore optimizes for safe edits, visual fidelity, provenance, and predictable AI operations rather than pretending every page is a DOCX waiting to be recovered.
