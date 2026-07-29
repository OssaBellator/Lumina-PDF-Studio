import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = (await Promise.all([1, 2, 3].map((part) => readFile(new URL(`../css/styles-${part}.css`, import.meta.url), 'utf8')))).join('\n');
const js = (await Promise.all(['core', 'editor', 'pdf-export', 'ai'].map((part) => readFile(new URL(`../js/${part}.js`, import.meta.url), 'utf8')))).join('\n') + await readFile(new URL('../app.js', import.meta.url), 'utf8');

const failures = [];
for (const required of ['id="app"', 'id="pdf-input"', 'id="page-stage"', 'id="ai-modal"', './css/styles-1.css', './app.js']) {
  if (!html.includes(required)) failures.push(`index.html is missing ${required}`);
}
for (const required of ['.page-stage', '.annotation-layer', '.ai-chat', '.modal-backdrop']) {
  if (!css.includes(required)) failures.push(`styles.css is missing ${required}`);
}
for (const required of ['importPdfFiles', 'exportPdf', 'sendAIMessage', 'executePendingAIActions']) {
  if (!js.includes(`function ${required}`) && !js.includes(`async function ${required}`)) failures.push(`app.js is missing ${required}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina static validation passed.');
