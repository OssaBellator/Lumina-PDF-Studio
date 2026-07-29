import { readFile } from 'node:fs/promises';

const recovery = await readFile(new URL('../js/document-reflow-recovery.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server_v7.py', import.meta.url), 'utf8');
const engine = await readFile(new URL('../document_reflow_safe.py', import.meta.url), 'utf8');

const failures = [];
for (const token of [
  'sanitizeModel', 'luminaRecoveryFetch', 'preferOffice', 'invalid_server_response',
  'equation_snapshot', 'replaceEquationSnapshot', 'reflow-equation-snapshot-label',
]) {
  if (!recovery.includes(token)) failures.push(`Recovery script is missing ${token}`);
}
if (!app.includes("recoveryScript.src = './js/document-reflow-recovery.js'")) failures.push('app.js must load the reflow recovery script');
for (const token of ['equation_snapshot_fidelity', 'model_sanitization', 'render_recovery', 'safe_reflow.render_document_model']) {
  if (!server.includes(token)) failures.push(`server_v7.py is missing ${token}`);
}
for (const token of ['preserve_complex_math', 'sanitise_model', '_emergency_pdf', 'pymupdf-emergency']) {
  if (!engine.includes(token)) failures.push(`Safe reflow engine is missing ${token}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lumina reflow recovery browser checks passed.');
