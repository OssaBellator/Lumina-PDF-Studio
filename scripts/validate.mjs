import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssFiles = await Promise.all([
  'styles-1.css', 'styles-2.css', 'styles-3.css', 'styles-native.css',
].map((name) => readFile(new URL(`../css/${name}`, import.meta.url), 'utf8')));
const jsFiles = await Promise.all([
  '../js/core.js', '../js/editor.js', '../js/pdf-export.js', '../js/ai.js', '../js/native-engine.js', '../app.js',
].map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
const css = cssFiles.join('\n');
const js = jsFiles.join('\n');

const failures = [];
for (const required of [
  'id="app"', 'id="pdf-input"', 'id="page-stage"', 'id="ai-modal"',
  'id="native-engine-modal"', 'id="native-engine-button"', './css/styles-native.css', './js/native-engine.js',
]) {
  if (!html.includes(required)) failures.push(`index.html is missing ${required}`);
}
for (const required of ['.page-stage', '.annotation-layer', '.ai-chat', '.modal-backdrop', '.native-modal', '.native-form-list']) {
  if (!css.includes(required)) failures.push(`stylesheets are missing ${required}`);
}
for (const required of [
  'importPdfFiles', 'exportPdf', 'sendAIMessage', 'executePendingAIActions',
  'checkNativeEngine', 'analyzeDocumentNatively', 'performNativeOperations', 'restoreNativeSource',
]) {
  if (!js.includes(`function ${required}`) && !js.includes(`async function ${required}`)) failures.push(`JavaScript is missing ${required}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina static validation passed.');
