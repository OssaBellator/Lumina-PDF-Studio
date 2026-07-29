import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cssFiles = await Promise.all([
  'styles-1.css', 'styles-2.css', 'styles-3.css', 'styles-native.css', 'styles-document-edit.css',
].map((name) => readFile(new URL(`../css/${name}`, import.meta.url), 'utf8')));
const jsFiles = await Promise.all([
  '../js/core.js', '../js/editor.js', '../js/pdf-export.js', '../js/ai.js', '../js/native-engine.js', '../js/document-edit.js', '../app.js',
].map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
const app = jsFiles.at(-1);
const server = await readFile(new URL('../server_v3.py', import.meta.url), 'utf8');
const transportServer = await readFile(new URL('../server_v4.py', import.meta.url), 'utf8');
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
for (const required of [
  '.page-stage', '.annotation-layer', '.ai-chat', '.modal-backdrop', '.native-modal',
  '.document-edit-ribbon', '.document-object', '.object-resize-handle', '.equation-modal',
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
  'extract_page_layout', '_replace_text_region', '_place_asset', '_append_text_page',
]) {
  if (!server.includes(`def ${required}`)) failures.push(`server_v3.py is missing ${required}`);
}
for (const required of ['is_client_disconnect_error', 'QuietLuminaHandler']) {
  if (!transportServer.includes(required)) failures.push(`server_v4.py is missing ${required}`);
}
if (packageJson.scripts.start !== 'python3 server_v4.py') failures.push('npm start must launch server_v4.py');
if (packageJson.version !== '2.3.1') failures.push('package version must be 2.3.1');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina rich edit validation passed.');
