import { readFile } from 'node:fs/promises';

const reflow = await readFile(new URL('../js/document-reflow.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../css/styles-document-reflow.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

const failures = [];
for (const required of [
  'loadModel', 'saveAndRead', 'renderCurrentModel', 'document_replace_text', 'document_insert_after',
  'document_append', 'document_insert_equation', 'document_insert_table', 'applyDocumentAction',
  'downloadDocx', 'downloadMarkdown', 'previousExecutePendingAIActions', 'replaceSourceDocumentBytes',
]) {
  if (!reflow.includes(required)) failures.push(`document-reflow.js is missing ${required}`);
}
for (const required of [
  '.reflow-editor-shell', '.reflow-ribbon', '.reflow-document', '.reflow-table', '.reflow-equation',
  '.reflow-edit-mode', '.layout-edit-button',
]) {
  if (!css.includes(required)) failures.push(`reflow stylesheet is missing ${required}`);
}
if (!app.includes("reflowScript.src = './js/document-reflow.js'")) failures.push('app.js must load the DOCX reflow editor');
if (!reflow.includes("tool === 'edit_text' || tool === 'replace_text'")) failures.push('legacy AI text tools must be normalised into document operations');
if (!reflow.includes("tool === 'insert_answer' || tool === 'add_answer'")) failures.push('legacy AI answer tools must be normalised into document insertion');
if (!reflow.includes("activateEditor();")) failures.push('approved AI document actions must open Reflow Edit for review');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina DOCX reflow browser checks passed.');
