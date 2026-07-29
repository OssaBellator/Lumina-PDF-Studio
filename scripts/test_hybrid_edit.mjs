import { readFile } from 'node:fs/promises';

const editor = await readFile(new URL('../js/hybrid-edit.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server_v8.py', import.meta.url), 'utf8');
const engine = await readFile(new URL('../hybrid_document.py', import.meta.url), 'utf8');
const css = await readFile(new URL('../css/styles-hybrid-edit.css', import.meta.url), 'utf8');

const failures = [];
for (const required of [
  'hybrid-edit-layer', 'source-preserving', 'Smart Edit', 'renderHybridLayer', 'beginTextEdit',
  'hybrid_replace_block', 'hybrid_insert_after', 'hybrid_append_page', 'hybrid_replace_formula',
  'block_id', '/api/hybrid/import', '/api/hybrid/save', 'replaceSourceDocumentBytes',
]) if (!editor.includes(required)) failures.push(`hybrid editor is missing ${required}`);

for (const required of ['LuminaHybridHandler', '/api/hybrid/import', '/api/hybrid/save', 'doclingAvailable', 'hybrid_edit'])
  if (!server.includes(required)) failures.push(`server_v8.py is missing ${required}`);

for (const required of ['import_pdf_model', '_docling_import', '_group_formula_candidates', 'sourceMode', 'apply_model_changes'])
  if (!engine.includes(required)) failures.push(`hybrid_document.py is missing ${required}`);

for (const required of ['.hybrid-edit-layer', '.hybrid-object', '.hybrid-ribbon', '.hybrid-marquee', '.mask-source'])
  if (!css.includes(required)) failures.push(`hybrid stylesheet is missing ${required}`);

if (editor.includes('Original equation preserved')) failures.push('hybrid editor must not create repeated preserved-equation cards');
if (!editor.includes("event.detail >= 2")) failures.push('double-click editing must survive selection without rebuilding the target first');
if (!editor.includes('sourceMode') && !engine.includes('sourceMode')) failures.push('source background preservation is not represented');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina hybrid browser validation passed.');
