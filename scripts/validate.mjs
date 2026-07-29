import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cssFiles = await Promise.all([
  'styles-1.css', 'styles-2.css', 'styles-3.css', 'styles-native.css', 'styles-document-edit.css', 'styles-document-reflow.css',
].map((name) => readFile(new URL(`../css/${name}`, import.meta.url), 'utf8')));
const jsFiles = await Promise.all([
  '../js/core.js', '../js/editor.js', '../js/pdf-export.js', '../js/ai.js', '../js/native-engine.js',
  '../js/document-edit.js', '../js/document-edit-interaction-fix.js', '../js/document-edit-transactions.js',
  '../js/document-revision-flex.js', '../js/document-reflow.js', '../app.js',
].map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
const interactionFix = jsFiles.at(-5);
const transactions = jsFiles.at(-4);
const revisionFlex = jsFiles.at(-3);
const reflow = jsFiles.at(-2);
const app = jsFiles.at(-1);
const server = await readFile(new URL('../server_v3.py', import.meta.url), 'utf8');
const transportServer = await readFile(new URL('../server_v4.py', import.meta.url), 'utf8');
const transactionServer = await readFile(new URL('../server_v5.py', import.meta.url), 'utf8');
const reflowServer = await readFile(new URL('../server_v6.py', import.meta.url), 'utf8');
const reflowEngine = await readFile(new URL('../document_reflow.py', import.meta.url), 'utf8');
const css = cssFiles.join('\n');
const js = jsFiles.join('\n');

const failures = [];
for (const required of [
  'id="app"', 'id="pdf-input"', 'id="page-stage"', 'id="ai-modal"',
  'id="native-engine-modal"', 'id="native-engine-button"', './css/styles-native.css', './js/native-engine.js',
]) {
  if (!html.includes(required)) failures.push(`index.html is missing ${required}`);
}
if (!app.includes("documentEditScript.src = './js/document-edit.js'")) failures.push('app.js must load ./js/document-edit.js');
if (!app.includes("interactionFixScript.src = './js/document-edit-interaction-fix.js'")) failures.push('app.js must load the inline edit interaction fix');
if (!app.includes("transactionScript.src = './js/document-edit-transactions.js'")) failures.push('app.js must load the transaction editor');
if (!app.includes("revisionScript.src = './js/document-revision-flex.js'")) failures.push('app.js must load flexible saved revision handling');
if (!app.includes("reflowScript.src = './js/document-reflow.js'")) failures.push('app.js must load DOCX reflow editing');
for (const required of [
  '.page-stage', '.annotation-layer', '.ai-chat', '.modal-backdrop', '.native-modal',
  '.document-edit-ribbon', '.document-object', '.object-resize-handle', '.equation-modal',
  '.reflow-editor-shell', '.reflow-ribbon', '.reflow-document', '.reflow-table',
]) {
  if (!css.includes(required)) failures.push(`stylesheets are missing ${required}`);
}
for (const required of [
  'importPdfFiles', 'exportPdf', 'sendAIMessage', 'executePendingAIActions',
  'checkNativeEngine', 'analyzeDocumentNatively', 'performNativeOperations', 'restoreNativeSource',
  'enterDocumentEditMode', 'commitDocumentEditsAndRead', 'undoDocumentEdit',
  'addImageDataUrl', 'latexToSvgDataUrl', 'findAnswerPlacement',
]) {
  if (!js.includes(`function ${required}`) && !js.includes(`async function ${required}`)) failures.push(`JavaScript is missing ${required}`);
}
for (const required of [
  'handlePointerDownCapture', 'beginPatchedInlineEdit', 'document-source-mask',
  'sampleBackground', 'stopImmediatePropagation',
]) {
  if (!interactionFix.includes(required)) failures.push(`inline edit fix is missing ${required}`);
}
for (const required of [
  'document-deletion-mask', 'selectedIds', 'undoSavedRevision', 'redoSavedRevision',
  'autoGrowTextBox', 'createTextAt', 'document-multi-marquee', 'normalizeLongAIReplacements',
]) {
  if (!transactions.includes(required)) failures.push(`transaction editor is missing ${required}`);
}
for (const required of [
  'replaceSourceDocumentBytesAcrossPageCounts', 'nextPageCount < previousPageCount',
  'nextPageCount > previousPageCount', 'state.selectedPageIds',
]) {
  if (!revisionFlex.includes(required)) failures.push(`flexible revision handling is missing ${required}`);
}
for (const required of [
  'loadModel', 'saveAndRead', 'document_replace_text', 'document_insert_after',
  'document_append', 'document_insert_equation', 'document_insert_table', 'downloadDocx', 'downloadMarkdown',
]) {
  if (!reflow.includes(required)) failures.push(`DOCX reflow editor is missing ${required}`);
}
for (const required of [
  'extract_page_layout', '_replace_text_region', '_place_asset', '_append_text_page',
]) {
  if (!server.includes(`def ${required}`)) failures.push(`server_v3.py is missing ${required}`);
}
for (const required of ['is_client_disconnect_error', 'QuietLuminaHandler']) {
  if (!transportServer.includes(required)) failures.push(`server_v4.py is missing ${required}`);
}
for (const required of ['group_math_objects', '_add_text_box_with_overflow', 'LuminaTransactionalHandler']) {
  if (!transactionServer.includes(required)) failures.push(`server_v5.py is missing ${required}`);
}
for (const required of ['LuminaReflowHandler', '/api/document/import', '/api/document/render', 'reflow_document', 'docx_export']) {
  if (!reflowServer.includes(required)) failures.push(`server_v6.py is missing ${required}`);
}
for (const required of ['pdf_to_document_model', 'model_to_docx_bytes', 'model_to_markdown', 'model_to_fallback_pdf_bytes', 'render_document_model']) {
  if (!reflowEngine.includes(`def ${required}`)) failures.push(`document_reflow.py is missing ${required}`);
}
if (packageJson.scripts.start !== 'python3 server_v6.py') failures.push('npm start must launch server_v6.py');
if (packageJson.version !== '3.0.0') failures.push('package version must be 3.0.0');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina DOCX reflow validation passed.');
