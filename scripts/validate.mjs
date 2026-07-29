import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cssFiles = await Promise.all([
  'styles-1.css', 'styles-2.css', 'styles-3.css', 'styles-native.css', 'styles-document-edit.css',
  'styles-document-reflow.css', 'styles-hybrid-edit.css',
].map((name) => readFile(new URL(`../css/${name}`, import.meta.url), 'utf8')));
const jsNames = [
  '../js/core.js', '../js/editor.js', '../js/pdf-export.js', '../js/ai.js', '../js/native-engine.js',
  '../js/document-edit.js', '../js/document-edit-interaction-fix.js', '../js/document-edit-transactions.js',
  '../js/document-revision-flex.js', '../js/document-reflow.js', '../js/document-reflow-recovery.js',
  '../js/hybrid-edit.js', '../app.js',
];
const jsFiles = await Promise.all(jsNames.map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
const byName = Object.fromEntries(jsNames.map((name, index) => [name, jsFiles[index]]));
const interactionFix = byName['../js/document-edit-interaction-fix.js'];
const transactions = byName['../js/document-edit-transactions.js'];
const revisionFlex = byName['../js/document-revision-flex.js'];
const reflow = byName['../js/document-reflow.js'];
const recovery = byName['../js/document-reflow-recovery.js'];
const hybrid = byName['../js/hybrid-edit.js'];
const app = byName['../app.js'];
const server = await readFile(new URL('../server_v3.py', import.meta.url), 'utf8');
const transportServer = await readFile(new URL('../server_v4.py', import.meta.url), 'utf8');
const transactionServer = await readFile(new URL('../server_v5.py', import.meta.url), 'utf8');
const reflowServer = await readFile(new URL('../server_v6.py', import.meta.url), 'utf8');
const safeReflowServer = await readFile(new URL('../server_v7.py', import.meta.url), 'utf8');
const hybridServer = await readFile(new URL('../server_v8.py', import.meta.url), 'utf8');
const reflowEngine = await readFile(new URL('../document_reflow.py', import.meta.url), 'utf8');
const safeReflowEngine = await readFile(new URL('../document_reflow_safe.py', import.meta.url), 'utf8');
const hybridEngine = await readFile(new URL('../hybrid_document.py', import.meta.url), 'utf8');
const css = cssFiles.join('\n');
const js = jsFiles.join('\n');

const failures = [];
for (const required of [
  'id="app"', 'id="pdf-input"', 'id="page-stage"', 'id="ai-modal"',
  'id="native-engine-modal"', 'id="native-engine-button"', './css/styles-native.css', './js/native-engine.js',
]) if (!html.includes(required)) failures.push(`index.html is missing ${required}`);

for (const [needle, message] of [
  ["documentEditScript.src = './js/document-edit.js'", 'app.js must load the original layout editor'],
  ["interactionFixScript.src = './js/document-edit-interaction-fix.js'", 'app.js must load the inline interaction fix'],
  ["transactionScript.src = './js/document-edit-transactions.js'", 'app.js must load transaction editing'],
  ["revisionScript.src = './js/document-revision-flex.js'", 'app.js must load saved revision handling'],
  ["reflowScript.src = './js/document-reflow.js'", 'app.js must retain legacy reflow as a compatibility layer'],
  ["recoveryScript.src = './js/document-reflow-recovery.js'", 'app.js must retain reflow recovery'],
  ["hybridScript.src = './js/hybrid-edit.js'", 'app.js must load Smart Edit last'],
]) if (!app.includes(needle)) failures.push(message);

for (const required of [
  '.page-stage', '.annotation-layer', '.ai-chat', '.modal-backdrop', '.native-modal',
  '.document-edit-ribbon', '.reflow-editor-shell', '.hybrid-edit-layer', '.hybrid-object', '.hybrid-ribbon', '.hybrid-marquee',
]) if (!css.includes(required)) failures.push(`stylesheets are missing ${required}`);

for (const required of [
  'importPdfFiles', 'exportPdf', 'sendAIMessage', 'executePendingAIActions',
  'checkNativeEngine', 'analyzeDocumentNatively', 'performNativeOperations', 'restoreNativeSource',
  'enterDocumentEditMode', 'commitDocumentEditsAndRead', 'undoDocumentEdit',
  'addImageDataUrl', 'latexToSvgDataUrl', 'findAnswerPlacement',
]) if (!js.includes(`function ${required}`) && !js.includes(`async function ${required}`)) failures.push(`JavaScript is missing ${required}`);

for (const required of ['handlePointerDownCapture', 'beginPatchedInlineEdit', 'document-source-mask', 'sampleBackground', 'stopImmediatePropagation'])
  if (!interactionFix.includes(required)) failures.push(`inline edit fix is missing ${required}`);
for (const required of ['document-deletion-mask', 'selectedIds', 'undoSavedRevision', 'redoSavedRevision', 'autoGrowTextBox', 'createTextAt', 'document-multi-marquee', 'normalizeLongAIReplacements'])
  if (!transactions.includes(required)) failures.push(`transaction editor is missing ${required}`);
for (const required of ['replaceSourceDocumentBytesAcrossPageCounts', 'nextPageCount < previousPageCount', 'nextPageCount > previousPageCount', 'state.selectedPageIds'])
  if (!revisionFlex.includes(required)) failures.push(`flexible revision handling is missing ${required}`);
for (const required of ['loadModel', 'saveAndRead', 'document_replace_text', 'document_insert_after', 'document_append', 'document_insert_equation', 'document_insert_table'])
  if (!reflow.includes(required)) failures.push(`legacy reflow editor is missing ${required}`);
for (const required of ['sanitizeModel', 'luminaRecoveryFetch', 'equation_snapshot', 'replaceEquationSnapshot'])
  if (!recovery.includes(required)) failures.push(`legacy reflow recovery is missing ${required}`);

for (const required of [
  'Smart Edit', 'renderHybridLayer', 'source-preserving', 'hybrid_replace_block', 'hybrid_insert_after',
  'hybrid_append_page', 'hybrid_replace_formula', 'block_id', '/api/hybrid/import', '/api/hybrid/save',
]) if (!hybrid.includes(required)) failures.push(`Smart Edit is missing ${required}`);
if (hybrid.includes('Original equation preserved')) failures.push('Smart Edit must not generate repeated equation snapshot cards');
if (!hybrid.includes('event.detail >= 2')) failures.push('Smart Edit must preserve double-click activation after selection');

for (const required of ['extract_page_layout', '_replace_text_region', '_place_asset', '_append_text_page'])
  if (!server.includes(`def ${required}`)) failures.push(`server_v3.py is missing ${required}`);
for (const required of ['is_client_disconnect_error', 'QuietLuminaHandler'])
  if (!transportServer.includes(required)) failures.push(`server_v4.py is missing ${required}`);
for (const required of ['group_math_objects', '_add_text_box_with_overflow', 'LuminaTransactionalHandler'])
  if (!transactionServer.includes(required)) failures.push(`server_v5.py is missing ${required}`);
for (const required of ['LuminaReflowHandler', '/api/document/import', '/api/document/render'])
  if (!reflowServer.includes(required)) failures.push(`server_v6.py is missing ${required}`);
for (const required of ['LuminaSafeReflowHandler', 'equation_snapshot_fidelity', 'model_sanitization', 'render_recovery'])
  if (!safeReflowServer.includes(required)) failures.push(`server_v7.py is missing ${required}`);
for (const required of ['LuminaHybridHandler', '/api/hybrid/import', '/api/hybrid/save', 'doclingAvailable', 'source_preserving_edit'])
  if (!hybridServer.includes(required)) failures.push(`server_v8.py is missing ${required}`);

for (const required of ['pdf_to_document_model', 'model_to_docx_bytes', 'model_to_markdown', 'model_to_fallback_pdf_bytes', 'render_document_model'])
  if (!reflowEngine.includes(`def ${required}`)) failures.push(`document_reflow.py is missing ${required}`);
for (const required of ['preserve_complex_math', 'sanitise_model', '_emergency_pdf', 'render_document_model'])
  if (!safeReflowEngine.includes(`def ${required}`)) failures.push(`document_reflow_safe.py is missing ${required}`);
for (const required of ['import_pdf_model', '_docling_import', '_group_formula_candidates', 'apply_model_changes'])
  if (!hybridEngine.includes(`def ${required}`)) failures.push(`hybrid_document.py is missing ${required}`);
for (const required of ['sourceMode', 'docling-accurate', 'pymupdf-fast', 'blockIndex'])
  if (!hybridEngine.includes(required)) failures.push(`hybrid_document.py is missing ${required}`);

if (packageJson.scripts.start !== 'python3 server_v8.py') failures.push('npm start must launch server_v8.py');
if (packageJson.version !== '4.0.0') failures.push('package version must be 4.0.0');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina source-preserving Smart Edit validation passed.');
