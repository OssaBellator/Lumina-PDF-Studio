import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/document-edit-transactions.js', import.meta.url), 'utf8');
const required = [
  'document-deletion-mask',
  'selectedIds',
  'undoSavedRevision',
  'redoSavedRevision',
  'autoGrowTextBox',
  'createTextAt',
  'document-multi-marquee',
  'normalizeLongAIReplacements',
  "tool: 'insert_answer'",
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) {
  console.error(`Transaction editor is missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('Lumina edit transaction browser checks passed.');
