import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/document-edit-interaction-fix.js', import.meta.url), 'utf8');

for (const required of [
  'DOUBLE_CLICK_MS',
  'isSecondPointer',
  "layer.addEventListener('pointerdown', handlePointerDownCapture, true)",
  'beginPatchedInlineEdit',
  'content.contentEditable = \'true\'',
  'event.stopImmediatePropagation()',
  'document-source-mask',
  'sampleBackground',
  'current.changes.set(object.id, clone(object))',
  'source-object.selected:not(.changed):not(.is-editing)',
]) {
  assert.ok(source.includes(required), `Missing inline-edit regression marker: ${required}`);
}

assert.match(source, /elapsed\s*>=\s*0\s*&&\s*elapsed\s*<=\s*DOUBLE_CLICK_MS/);
assert.match(source, /distance\s*<=\s*DOUBLE_CLICK_DISTANCE/);
assert.match(source, /current\.activeEditableId\s*===\s*objectId/);
assert.match(source, /object\.sourceRect/);

console.log('Lumina inline edit interaction tests passed.');
