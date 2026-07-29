(function () {
  'use strict';

  const HYBRID_TOOLS = new Set([
    'hybrid_replace_block', 'hybrid_delete_block', 'hybrid_insert_after',
    'hybrid_append_page', 'hybrid_replace_formula',
  ]);
  const clone = (value) => structuredClone(value);
  const hybrid = {
    mode: 'read', model: null, documentId: null, edits: new Map(), added: new Map(), appended: [],
    history: [], future: [], selectedIds: new Set(), activeId: null, tool: 'select', busy: false,
    importMode: localStorage.getItem('lumina-hybrid-import-mode') || 'auto', rendering: 0,
  };

  const previousSendAIMessage = typeof sendAIMessage === 'function' ? sendAIMessage : null;
  const previousExecutePendingAIActions = typeof executePendingAIActions === 'function' ? executePendingAIActions : null;
  const previousPermissionForTool = typeof permissionForTool === 'function' ? permissionForTool : null;
  const previousRenderCurrentPage = typeof renderCurrentPage === 'function' ? renderCurrentPage : null;

  const makeId = (prefix = 'edit') => `${prefix}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const currentDocument = () => (typeof activeDocument === 'function' ? activeDocument() : null);
  const currentPage = () => (typeof activePage === 'function' ? activePage() : null);
  const currentPageModel = () => {
    const page = currentPage();
    return page && hybrid.model ? (hybrid.model.pages || []).find((item) => Number(item.index) === Number(page.sourceIndex)) : null;
  };
  const bytesFromBase64 = (value) => {
    const binary = atob(value || ''); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const escapeText = (value) => {
    const element = document.createElement('div'); element.textContent = String(value ?? ''); return element.innerHTML;
  };
  const isTyping = (target) => Boolean(target?.closest?.('[contenteditable="true"],input,textarea,select'));

  function snapshot() {
    return {
      edits: [...hybrid.edits.entries()].map(([id, edit]) => [id, clone(edit)]),
      added: [...hybrid.added.entries()].map(([id, edit]) => [id, clone(edit)]),
      appended: clone(hybrid.appended), selectedIds: [...hybrid.selectedIds], activeId: hybrid.activeId, tool: hybrid.tool,
    };
  }
  function restore(value) {
    hybrid.edits = new Map(value.edits.map(([id, edit]) => [id, clone(edit)]));
    hybrid.added = new Map(value.added.map(([id, edit]) => [id, clone(edit)]));
    hybrid.appended = clone(value.appended); hybrid.selectedIds = new Set(value.selectedIds); hybrid.activeId = value.activeId; hybrid.tool = value.tool;
    renderHybridLayer(); updateHybridUi();
  }
  function pushHistory() {
    if (hybrid.mode !== 'edit' || hybrid.busy) return;
    hybrid.history.push(snapshot()); hybrid.history = hybrid.history.slice(-100); hybrid.future = []; updateHybridUi();
  }
  function undoHybrid() {
    if (!hybrid.history.length) return;
    hybrid.future.unshift(snapshot()); restore(hybrid.history.pop());
  }
  function redoHybrid() {
    if (!hybrid.future.length) return;
    hybrid.history.push(snapshot()); restore(hybrid.future.shift());
  }

  function createUi() {
    if (document.querySelector('#hybrid-edit-layer')) return;
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = './css/styles-hybrid-edit.css'; stylesheet.dataset.hybridEdit = 'true'; document.head.appendChild(stylesheet);

    let oldMode = document.querySelector('#document-mode-button');
    if (!oldMode) {
      const group = document.createElement('div'); group.className = 'document-mode-group'; group.innerHTML = '<button class="button ghost" id="document-mode-button"><i data-lucide="scan-text"></i><span id="document-mode-label">Smart Edit</span></button><button class="button ghost hidden" id="document-discard-button"><i data-lucide="x"></i><span>Cancel</span></button>';
      document.querySelector('.top-actions')?.insertBefore(group, document.querySelector('#native-engine-button'));
      oldMode = group.querySelector('#document-mode-button');
    }
    const mode = oldMode.cloneNode(true); oldMode.replaceWith(mode); mode.querySelector('#document-mode-label').textContent = 'Smart Edit'; mode.title = 'Edit confidently detected page regions while preserving the original PDF';
    mode.addEventListener('click', () => { if (hybrid.mode === 'edit') saveAndRead(); else enterHybridMode(); });
    const oldCancel = document.querySelector('#document-discard-button');
    if (oldCancel) { const cancel = oldCancel.cloneNode(true); oldCancel.replaceWith(cancel); cancel.addEventListener('click', discardHybrid); }

    const ribbon = document.createElement('div'); ribbon.id = 'hybrid-ribbon'; ribbon.className = 'hybrid-ribbon hidden';
    ribbon.innerHTML = `
      <div class="hybrid-group"><button data-hybrid-command="undo" title="Undo"><i data-lucide="undo-2"></i></button><button data-hybrid-command="redo" title="Redo"><i data-lucide="redo-2"></i></button></div>
      <span class="hybrid-separator"></span>
      <div class="hybrid-group"><button data-hybrid-tool="select" class="active"><i data-lucide="mouse-pointer-2"></i><span>Select</span></button><button data-hybrid-tool="text"><i data-lucide="type"></i><span>Add text</span></button><button data-hybrid-command="formula"><i data-lucide="sigma"></i><span>Replace math</span></button></div>
      <span class="hybrid-separator"></span>
      <div class="hybrid-group hybrid-format"><select id="hybrid-font-family"><option>Helvetica</option><option>Times</option><option>Courier</option></select><input id="hybrid-font-size" type="number" min="5" max="96" value="11" /><button data-hybrid-command="bold"><b>B</b></button><button data-hybrid-command="italic"><i>I</i></button><input id="hybrid-color" type="color" value="#111318" /><select id="hybrid-align"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option></select></div>
      <span class="hybrid-separator"></span>
      <div class="hybrid-group"><button data-hybrid-command="duplicate" title="Duplicate new object"><i data-lucide="copy"></i></button><button data-hybrid-command="delete" class="danger" title="Delete selected region"><i data-lucide="trash-2"></i></button></div>
      <span class="hybrid-spacer"></span>
      <div class="hybrid-group hybrid-import"><select id="hybrid-import-mode" title="Document analysis quality"><option value="auto">Auto analysis</option><option value="fast">Fast local</option><option value="accurate">Accurate (Docling)</option></select><button data-hybrid-command="reanalyze" title="Analyse the source again"><i data-lucide="refresh-cw"></i></button><span id="hybrid-status">Source-preserving edit</span></div>`;
    document.querySelector('.editor-shell')?.appendChild(ribbon);

    const layer = document.createElement('div'); layer.id = 'hybrid-edit-layer'; layer.className = 'hybrid-edit-layer hidden'; layer.setAttribute('aria-label', 'Structured PDF edit layer'); el.pageStage.appendChild(layer);
    const banner = document.createElement('div'); banner.id = 'hybrid-banner'; banner.className = 'hybrid-banner hidden'; banner.innerHTML = '<i data-lucide="shield-check"></i><span>The original page stays untouched until Save & Read. Only changed regions are rewritten.</span>';
    document.querySelector('.editor-shell')?.appendChild(banner);

    const inspector = document.createElement('div'); inspector.id = 'hybrid-inspector'; inspector.className = 'hybrid-inspector hidden';
    document.querySelector('[data-panel="edit"]')?.appendChild(inspector);

    ribbon.querySelectorAll('[data-hybrid-tool]').forEach((button) => button.addEventListener('click', () => { hybrid.tool = button.dataset.hybridTool; updateHybridUi(); }));
    ribbon.querySelectorAll('[data-hybrid-command]').forEach((button) => button.addEventListener('click', () => runCommand(button.dataset.hybridCommand)));
    ribbon.querySelector('#hybrid-import-mode').value = hybrid.importMode;
    ribbon.querySelector('#hybrid-import-mode').addEventListener('change', (event) => { hybrid.importMode = event.target.value; localStorage.setItem('lumina-hybrid-import-mode', hybrid.importMode); });
    ribbon.querySelector('#hybrid-font-family').addEventListener('change', (event) => applyStyle({ fontFamily: event.target.value }));
    ribbon.querySelector('#hybrid-font-size').addEventListener('change', (event) => applyStyle({ fontSize: Math.max(5, Math.min(96, Number(event.target.value) || 11)) }));
    ribbon.querySelector('#hybrid-color').addEventListener('input', (event) => applyStyle({ color: event.target.value }));
    ribbon.querySelector('#hybrid-align').addEventListener('change', (event) => applyStyle({ align: event.target.value }));

    layer.addEventListener('click', onLayerClick); layer.addEventListener('dblclick', onLayerDoubleClick); layer.addEventListener('input', onLayerInput);
    layer.addEventListener('pointerdown', onLayerPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }

  function updateHybridUi() {
    const editing = hybrid.mode === 'edit'; const mode = document.querySelector('#document-mode-button');
    if (mode) { mode.classList.toggle('primary', editing); mode.classList.toggle('ghost', !editing); mode.disabled = hybrid.busy; mode.querySelector('#document-mode-label').textContent = editing ? 'Save & Read' : 'Smart Edit'; }
    document.querySelector('#document-discard-button')?.classList.toggle('hidden', !editing);
    document.querySelector('#hybrid-ribbon')?.classList.toggle('hidden', !editing); document.querySelector('#hybrid-banner')?.classList.toggle('hidden', !editing);
    document.querySelector('#hybrid-edit-layer')?.classList.toggle('hidden', !editing); document.body.classList.toggle('hybrid-edit-mode', editing);
    document.querySelector('#document-edit-ribbon')?.classList.add('hidden'); document.querySelector('#reflow-editor-shell')?.classList.add('hidden');
    document.querySelectorAll('[data-hybrid-tool]').forEach((button) => button.classList.toggle('active', button.dataset.hybridTool === hybrid.tool));
    const undo = document.querySelector('[data-hybrid-command="undo"]'); const redo = document.querySelector('[data-hybrid-command="redo"]');
    if (undo) undo.disabled = !hybrid.history.length; if (redo) redo.disabled = !hybrid.future.length;
    const count = hybrid.edits.size + hybrid.added.size + hybrid.appended.length; const status = document.querySelector('#hybrid-status');
    if (status) status.textContent = hybrid.busy ? 'Working…' : `${hybrid.model?.backend || 'Structured edit'} · ${count} change${count === 1 ? '' : 's'}`;
    renderInspector();
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return { error: { message: text.slice(0, 500) || `Local engine returned ${response.status}` } }; }
  }

  async function loadModel({ force = false, activate = false } = {}) {
    const doc = currentDocument(); if (!doc) throw new Error('Open a PDF first.');
    if (!force && hybrid.model && hybrid.documentId === doc.id) { if (activate) activateHybrid(); return hybrid.model; }
    if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('Smart Edit needs the local engine. Run npm start.');
    if (!(nativeEngine.health?.capabilities || []).includes('hybrid_edit')) throw new Error('The local engine is outdated. Pull the latest code and restart npm start.');
    hybrid.busy = true; updateHybridUi(); setLoading(true, hybrid.importMode === 'accurate' ? 'Running accurate document analysis…' : 'Analysing page structure…');
    try {
      const body = new FormData(); body.append('file', new Blob([doc.bytes], { type: 'application/pdf' }), doc.name || 'document.pdf'); body.append('title', doc.name?.replace(/\.pdf$/i, '') || 'Document'); body.append('mode', hybrid.importMode);
      const response = await fetch('/api/hybrid/import', { method: 'POST', body }); const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error?.message || 'The PDF could not be analysed.');
      hybrid.model = payload.model; hybrid.documentId = doc.id; hybrid.edits.clear(); hybrid.added.clear(); hybrid.appended = []; hybrid.history = []; hybrid.future = []; hybrid.selectedIds.clear(); hybrid.activeId = null;
      if (activate) activateHybrid();
      if (payload.warnings?.length) flash(payload.warnings[0]);
      return hybrid.model;
    } finally { hybrid.busy = false; setLoading(false); updateHybridUi(); }
  }

  async function enterHybridMode() {
    if (hybrid.busy) return;
    try {
      window.LuminaReflowEditor?.discard?.(); window.LuminaDocumentEditor?.discard?.();
      await loadModel({ activate: true });
      flash('Smart Edit keeps the source page visible and edits only approved regions');
    } catch (error) { flash(error.message); }
  }
  function activateHybrid() { hybrid.mode = 'edit'; updateHybridUi(); renderHybridLayer(); }
  function discardHybrid() {
    hybrid.mode = 'read'; hybrid.model = null; hybrid.documentId = null; hybrid.edits.clear(); hybrid.added.clear(); hybrid.appended = []; hybrid.history = []; hybrid.future = []; hybrid.selectedIds.clear(); hybrid.activeId = null;
    document.querySelector('#hybrid-edit-layer').innerHTML = ''; updateHybridUi(); flash('Smart Edit changes discarded');
  }

  function displayElements() {
    const page = currentPageModel(); if (!page) return [];
    const source = (page.elements || []).map((element) => ({ ...element, state: hybrid.edits.get(element.id) || null }));
    const added = [...hybrid.added.values()].filter((element) => Number(element.page) === Number(page.index)).map((element) => ({ ...element, state: element }));
    return [...source, ...added];
  }

  function elementRectCss(element, page, canvasRect) {
    const [x0, y0, x1, y1] = element.bbox; const sx = canvasRect.width / page.width; const sy = canvasRect.height / page.height;
    return { left: x0 * sx, top: y0 * sy, width: Math.max(3, (x1 - x0) * sx), height: Math.max(3, (y1 - y0) * sy) };
  }

  function renderHybridLayer() {
    if (hybrid.mode !== 'edit') return;
    const token = ++hybrid.rendering; const layer = document.querySelector('#hybrid-edit-layer'); const page = currentPageModel();
    if (!layer || !page) { if (layer) layer.innerHTML = ''; return; }
    const stageRect = el.pageStage.getBoundingClientRect(); const canvasRect = el.canvas.getBoundingClientRect();
    layer.style.left = `${canvasRect.left - stageRect.left}px`; layer.style.top = `${canvasRect.top - stageRect.top}px`; layer.style.width = `${canvasRect.width}px`; layer.style.height = `${canvasRect.height}px`; layer.innerHTML = '';
    for (const element of displayElements()) {
      if (token !== hybrid.rendering) return;
      const current = element.state || element; const deleted = current.type === 'delete'; const box = document.createElement('div'); box.dataset.hybridId = element.id; box.dataset.kind = element.kind; box.className = `hybrid-object kind-${element.kind}${hybrid.selectedIds.has(element.id) ? ' selected' : ''}${deleted ? ' deleted' : ''}${element.id.startsWith('new-') ? ' is-new' : ''}`;
      const css = elementRectCss(current.bbox ? current : element, page, canvasRect); Object.assign(box.style, { left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px` });
      if (deleted) { box.innerHTML = '<span class="hybrid-deleted-label">Deleted</span>'; layer.appendChild(box); continue; }
      const editedText = current.type === 'replace_text' || current.type === 'add_text'; const editedFormula = current.type === 'replace_formula';
      if (editedText) {
        const content = document.createElement('div'); content.className = 'hybrid-text-content'; content.contentEditable = 'true'; content.spellcheck = true; content.textContent = current.text || ''; content.style.cssText = styleCss(current.style || element.style || {}); box.classList.add('mask-source', 'has-content'); box.appendChild(content);
      } else if (editedFormula) {
        box.classList.add('mask-source', 'has-content', 'formula-replacement');
        if (current.assetDataUrl) { const image = document.createElement('img'); image.src = current.assetDataUrl; image.alt = current.latex || 'Equation'; box.appendChild(image); }
        else { const code = document.createElement('code'); code.textContent = current.latex || ''; box.appendChild(code); }
      } else {
        const tag = document.createElement('span'); tag.className = 'hybrid-object-tag'; tag.textContent = labelFor(element); box.appendChild(tag);
      }
      layer.appendChild(box);
    }
    if (hybrid.tool === 'text') layer.classList.add('placing-text'); else layer.classList.remove('placing-text');
    updateHybridUi();
  }

  function labelFor(element) {
    if (element.kind === 'formula') return element.latex ? 'Formula · double-click to edit' : 'Formula · double-click to transcribe';
    if (element.kind === 'table') return 'Table preserved'; if (element.kind === 'picture') return 'Picture preserved'; if (element.kind === 'complex') return 'Complex region preserved';
    return element.editable === false ? 'Preserved text' : 'Double-click to edit';
  }
  function styleCss(style = {}) {
    const family = String(style.fontFamily || 'Helvetica').replace(/["']/g, ''); const size = Math.max(5, Number(style.fontSize) || 11);
    return `font-family:${family};font-size:${size}pt;color:${style.color || '#111318'};font-weight:${style.bold ? '700' : '400'};font-style:${style.italic ? 'italic' : 'normal'};text-align:${style.align || 'left'};line-height:${style.lineHeight || 1.15}`;
  }

  function findElement(id) {
    for (const page of hybrid.model?.pages || []) { const found = (page.elements || []).find((element) => element.id === id); if (found) return found; }
    return hybrid.added.get(id) || null;
  }
  function selectId(id, event = {}) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) { if (hybrid.selectedIds.has(id)) hybrid.selectedIds.delete(id); else hybrid.selectedIds.add(id); }
    else hybrid.selectedIds = new Set([id]); hybrid.activeId = id;
    document.querySelectorAll('#hybrid-edit-layer .hybrid-object').forEach((object) => object.classList.toggle('selected', hybrid.selectedIds.has(object.dataset.hybridId)));
    updateHybridUi();
  }
  function onLayerClick(event) {
    const object = event.target.closest('.hybrid-object');
    if (object) { selectId(object.dataset.hybridId, event); if (event.detail >= 2) { const element = findElement(object.dataset.hybridId); if (element?.kind === 'formula') editFormula(element); else if (element?.editable || element?.id.startsWith('new-')) beginTextEdit(element); } return; }
    if (hybrid.tool === 'text') createTextAt(event);
    else { hybrid.selectedIds.clear(); hybrid.activeId = null; renderHybridLayer(); }
  }
  function onLayerDoubleClick(event) {
    const object = event.target.closest('.hybrid-object');
    if (!object) { createTextAt(event); return; }
    const element = findElement(object.dataset.hybridId); if (!element) return;
    if (element.kind === 'formula') { editFormula(element); return; }
    if (!element.editable && !element.id.startsWith('new-')) { flash(`${labelFor(element)}. Use Accurate analysis or replace the whole region.`); return; }
    beginTextEdit(element);
  }
  function onLayerInput(event) {
    const content = event.target.closest('.hybrid-text-content'); if (!content) return; const object = content.closest('.hybrid-object'); const id = object.dataset.hybridId; const element = findElement(id); if (!element) return;
    const edit = hybrid.added.get(id) || hybrid.edits.get(id); if (!edit) return; edit.text = content.innerText.replace(/\r/g, '');
    if (edit.type === 'add_text') { const page = currentPageModel(); const scale = page.height / Math.max(1, document.querySelector('#hybrid-edit-layer').clientHeight); const needed = Math.max(edit.bbox[3] - edit.bbox[1], content.scrollHeight * scale + 8); edit.bbox[3] = Math.min(page.height - 8, edit.bbox[1] + needed); object.style.height = `${Math.max(object.clientHeight, content.scrollHeight + 8)}px`; }
  }

  function onLayerPointerDown(event) {
    if (event.target !== event.currentTarget || hybrid.tool !== 'select') return;
    const layer = event.currentTarget; const start = { x: event.offsetX, y: event.offsetY }; const marquee = document.createElement('div'); marquee.className = 'hybrid-marquee'; layer.appendChild(marquee); event.preventDefault();
    const move = (next) => { const rect = layer.getBoundingClientRect(); const x = next.clientX - rect.left; const y = next.clientY - rect.top; Object.assign(marquee.style, { left: `${Math.min(start.x, x)}px`, top: `${Math.min(start.y, y)}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px` }); };
    const up = () => { const selection = marquee.getBoundingClientRect(); const selected = new Set(); layer.querySelectorAll('.hybrid-object:not(.deleted)').forEach((object) => { const rect = object.getBoundingClientRect(); if (rect.right >= selection.left && rect.left <= selection.right && rect.bottom >= selection.top && rect.top <= selection.bottom) selected.add(object.dataset.hybridId); }); marquee.remove(); hybrid.selectedIds = selected; hybrid.activeId = [...selected][0] || null; renderHybridLayer(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  }

  function beginTextEdit(element) {
    if (!hybrid.added.has(element.id) && !hybrid.edits.has(element.id)) { pushHistory(); hybrid.edits.set(element.id, { type: 'replace_text', elementId: element.id, text: element.text || '', style: clone(element.style || {}) }); }
    hybrid.selectedIds = new Set([element.id]); hybrid.activeId = element.id; renderHybridLayer();
    setTimeout(() => { const content = document.querySelector(`[data-hybrid-id="${CSS.escape(element.id)}"] .hybrid-text-content`); content?.focus(); const selection = window.getSelection(); if (content && selection) { const range = document.createRange(); range.selectNodeContents(content); selection.removeAllRanges(); selection.addRange(range); } }, 0);
  }

  function createTextAt(event, text = '') {
    const page = currentPageModel(); const layer = document.querySelector('#hybrid-edit-layer'); if (!page || !layer) return; pushHistory();
    const rect = layer.getBoundingClientRect(); const x = Math.max(8, Math.min(page.width - 160, (event.clientX - rect.left) * page.width / rect.width)); const y = Math.max(8, Math.min(page.height - 60, (event.clientY - rect.top) * page.height / rect.height)); const id = `new-${makeId('text')}`;
    hybrid.added.set(id, { id, type: 'add_text', kind: 'text', page: page.index, bbox: [x, y, Math.min(page.width - 8, x + 240), Math.min(page.height - 8, y + 64)], text, editable: true, style: { fontFamily: 'Helvetica', fontSize: 11, color: '#111318', align: 'left', lineHeight: 1.15 } });
    hybrid.selectedIds = new Set([id]); hybrid.activeId = id; hybrid.tool = 'select'; renderHybridLayer(); setTimeout(() => document.querySelector(`[data-hybrid-id="${CSS.escape(id)}"] .hybrid-text-content`)?.focus(), 0);
  }

  async function editFormula(element) {
    const existing = hybrid.edits.get(element.id); const value = window.prompt('Enter LaTeX for this whole formula region:', existing?.latex || element.latex || ''); if (value === null) return; pushHistory();
    let assetDataUrl = ''; try { if (typeof latexToSvgDataUrl === 'function') assetDataUrl = await latexToSvgDataUrl(value); } catch (_) { assetDataUrl = ''; }
    hybrid.edits.set(element.id, { type: 'replace_formula', elementId: element.id, latex: value, assetDataUrl }); hybrid.selectedIds = new Set([element.id]); hybrid.activeId = element.id; renderHybridLayer();
  }

  function selectedElements() { return [...hybrid.selectedIds].map(findElement).filter(Boolean); }
  function ensureEdit(element) {
    if (hybrid.added.has(element.id)) return hybrid.added.get(element.id);
    if (!hybrid.edits.has(element.id)) hybrid.edits.set(element.id, { type: 'replace_text', elementId: element.id, text: element.text || '', style: clone(element.style || {}) });
    return hybrid.edits.get(element.id);
  }
  function applyStyle(changes) {
    const elements = selectedElements().filter((element) => element.kind === 'text' || element.kind === 'heading' || hybrid.added.has(element.id)); if (!elements.length) return; pushHistory();
    elements.forEach((element) => { const edit = ensureEdit(element); if (edit.type === 'delete') return; edit.style = { ...(edit.style || element.style || {}), ...changes }; }); renderHybridLayer();
  }
  function deleteSelected() {
    const elements = selectedElements(); if (!elements.length) return; pushHistory();
    elements.forEach((element) => { if (hybrid.added.has(element.id)) hybrid.added.delete(element.id); else hybrid.edits.set(element.id, { type: 'delete', elementId: element.id }); }); hybrid.selectedIds.clear(); hybrid.activeId = null; renderHybridLayer();
  }
  function duplicateSelected() {
    const page = currentPageModel(); const elements = selectedElements(); if (!page || !elements.length) return; pushHistory(); const ids = [];
    elements.forEach((element) => { const source = hybrid.added.get(element.id) || hybrid.edits.get(element.id); if (!source || source.type !== 'add_text') return; const id = `new-${makeId('text')}`; const copy = clone(source); copy.id = id; copy.bbox = copy.bbox.map((value) => value + 12); hybrid.added.set(id, copy); ids.push(id); }); hybrid.selectedIds = new Set(ids); hybrid.activeId = ids[0] || null; renderHybridLayer();
  }
  function runCommand(command) {
    if (command === 'undo') return undoHybrid(); if (command === 'redo') return redoHybrid(); if (command === 'delete') return deleteSelected(); if (command === 'duplicate') return duplicateSelected(); if (command === 'formula') { const element = selectedElements().find((item) => item.kind === 'formula'); if (element) editFormula(element); else flash('Select one whole formula region first'); return; }
    if (command === 'bold' || command === 'italic') { const element = selectedElements()[0]; const current = hybrid.added.get(element?.id) || hybrid.edits.get(element?.id); applyStyle({ [command]: !Boolean(current?.style?.[command] ?? element?.style?.[command]) }); return; }
    if (command === 'reanalyze') { loadModel({ force: true, activate: true }).catch((error) => flash(error.message)); }
  }

  function renderInspector() {
    const inspector = document.querySelector('#hybrid-inspector'); if (!inspector) return; const elements = selectedElements();
    if (hybrid.mode !== 'edit' || !elements.length) { inspector.classList.add('hidden'); return; }
    inspector.classList.remove('hidden'); const element = elements[0]; const edit = hybrid.added.get(element.id) || hybrid.edits.get(element.id); const confidence = Math.round(Number(element.confidence || 1) * 100);
    inspector.innerHTML = `<div class="hybrid-inspector-head"><b>${escapeText(element.kind)}</b><span>${confidence}% confidence</span></div><p>${escapeText(labelFor(element))}</p><dl><dt>Source</dt><dd>${escapeText(element.source?.backend || (element.id.startsWith('new-') ? 'New content' : 'PDF'))}</dd><dt>State</dt><dd>${escapeText(edit?.type || 'Original preserved')}</dd></dl>${element.text ? `<pre>${escapeText(element.text).slice(0, 900)}</pre>` : ''}`;
  }

  async function compileChanges() {
    const changes = [...hybrid.edits.values(), ...hybrid.added.values(), ...hybrid.appended];
    for (const change of changes) {
      if (change.type === 'replace_formula' && change.latex && !change.assetDataUrl && typeof latexToSvgDataUrl === 'function') {
        try { change.assetDataUrl = await latexToSvgDataUrl(change.latex); } catch (_) { /* plain text fallback */ }
      }
    }
    return changes;
  }
  async function saveAndRead() {
    if (hybrid.busy || !hybrid.model) return; const changes = await compileChanges(); if (!changes.length) { hybrid.mode = 'read'; updateHybridUi(); return; }
    const doc = currentDocument(); if (!doc || doc.id !== hybrid.documentId) { flash('The source document changed while editing.'); return; }
    hybrid.busy = true; updateHybridUi(); setLoading(true, 'Writing approved regions into the original PDF…');
    try {
      const body = new FormData(); body.append('file', new Blob([doc.bytes], { type: 'application/pdf' }), doc.name || 'document.pdf'); body.append('model', JSON.stringify(hybrid.model)); body.append('changes', JSON.stringify(changes));
      const response = await fetch('/api/hybrid/save', { method: 'POST', body }); const payload = await readJsonResponse(response); if (!response.ok) throw new Error(payload.error?.message || 'The approved edits could not be saved.');
      const bytes = bytesFromBase64(payload.pdfBase64); const backups = nativeEngine.backupsByDocument.get(doc.id) || []; backups.push(doc.bytes.slice()); nativeEngine.backupsByDocument.set(doc.id, backups.slice(-10)); await replaceSourceDocumentBytes(doc, bytes);
      hybrid.mode = 'read'; hybrid.model = null; hybrid.documentId = null; hybrid.edits.clear(); hybrid.added.clear(); hybrid.appended = []; hybrid.history = []; hybrid.future = []; hybrid.selectedIds.clear(); hybrid.activeId = null; document.querySelector('#hybrid-edit-layer').innerHTML = ''; updateHybridUi();
      flash(payload.warnings?.[0] || 'Changes saved; untouched PDF content was preserved');
    } catch (error) { flash(`Could not save Smart Edit changes: ${error.message}`); }
    finally { hybrid.busy = false; setLoading(false); updateHybridUi(); }
  }

  function onKeyDown(event) {
    if (hybrid.mode !== 'edit') return; const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); saveAndRead(); return; }
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopImmediatePropagation(); event.shiftKey ? redoHybrid() : undoHybrid(); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopImmediatePropagation(); redoHybrid(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !isTyping(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); deleteSelected(); }
    if (!isTyping(event.target) && event.key.toLowerCase() === 't') { hybrid.tool = 'text'; updateHybridUi(); }
  }

  function contextForAI(limit = 42000) {
    if (!hybrid.model) return '';
    return (hybrid.model.pages || []).flatMap((page) => (page.elements || []).map((element) => `[${element.id} | page ${page.index + 1} | ${element.kind} | editable:${Boolean(element.editable)}]\n${element.text || element.latex || ''}`)).join('\n\n').slice(0, limit);
  }
  function toolSchema(name, description, properties, required) { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }; }
  function hybridToolSchemas() {
    return [
      toolSchema('hybrid_replace_block', 'Replace the text of one editable block by its stable block ID.', { block_id: { type: 'string' }, text: { type: 'string' } }, ['block_id', 'text']),
      toolSchema('hybrid_delete_block', 'Delete one source block or region by stable block ID.', { block_id: { type: 'string' } }, ['block_id']),
      toolSchema('hybrid_insert_after', 'Insert an answer after a source block. Lumina appends a page when the source page lacks safe space.', { block_id: { type: 'string' }, text: { type: 'string' }, heading: { type: 'string' } }, ['block_id', 'text']),
      toolSchema('hybrid_append_page', 'Append a new page containing a title and text.', { title: { type: 'string' }, text: { type: 'string' } }, ['text']),
      toolSchema('hybrid_replace_formula', 'Replace one whole formula region by block ID using LaTeX.', { block_id: { type: 'string' }, latex: { type: 'string' } }, ['block_id', 'latex']),
    ];
  }
  function hybridPrompt() { return 'You edit a source-preserving PDF model. Every item is identified by a stable block ID. Never invent coordinates. Use hybrid_replace_block only for short corrections to editable text blocks. Use hybrid_insert_after or hybrid_append_page for answers and long content. Use hybrid_replace_formula only when the user explicitly requests a formula change and target the whole formula block. Return tool calls when supported; otherwise return JSON with message and actions.'; }
  function parseToolCalls(message) { const actions = []; for (const call of message?.tool_calls || []) { let args = {}; try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) { args = {}; } if (call.function?.name) actions.push({ tool: call.function.name, args }); } return actions; }
  function normalizeHybridAction(action) {
    if (!action?.tool) return action; const args = { ...(action.args || {}) }; let tool = action.tool;
    if (tool === 'edit_text' || tool === 'document_replace_text') { const search = args.search || args.originalText || ''; const found = findByText(search); tool = 'hybrid_replace_block'; args.block_id = args.block_id || found?.id || ''; args.text = args.text ?? args.replacement ?? ''; }
    else if (tool === 'insert_answer' || tool === 'document_insert_after') { const found = findByText(args.anchor || args.after_text || ''); tool = 'hybrid_insert_after'; args.block_id = args.block_id || found?.id || ''; }
    else if (tool === 'document_append' || tool === 'add_native_text') tool = 'hybrid_append_page';
    else if (tool === 'document_insert_equation') { const found = findByText(args.after || ''); tool = 'hybrid_replace_formula'; args.block_id = args.block_id || found?.id || ''; }
    return { tool, args };
  }
  function findByText(text) { const query = String(text || '').trim().toLowerCase(); if (!query) return null; for (const page of hybrid.model?.pages || []) for (const element of page.elements || []) if (String(element.text || '').toLowerCase().includes(query)) return element; return null; }

  async function sendHybridAI() {
    const prompt = el.aiPrompt.value.trim(); if (!prompt) return; if (!aiConfig.baseUrl || !aiConfig.model) { openAIModal(); return; }
    const previousAssistant = [...state.aiConversation].reverse().find((message) => message.role === 'assistant')?.content || ''; addAIMessage('user', prompt); el.aiPrompt.value = ''; document.querySelector('#send-ai').disabled = true;
    const placeholder = document.createElement('div'); placeholder.className = 'ai-message assistant'; placeholder.textContent = 'Reading structured page regions…'; el.aiChat.appendChild(placeholder);
    try {
      if (state.aiUseDocument && aiConfig.permissions.read_document) await loadModel({ activate: false }); const context = state.aiUseDocument && aiConfig.permissions.read_document ? contextForAI() : '';
      const messages = [{ role: 'system', content: hybridPrompt() }, ...state.aiConversation.slice(0, -1).slice(-10).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })), { role: 'user', content: context ? `${prompt}\n\nStructured PDF blocks:\n${context}` : prompt }];
      const headers = { 'Content-Type': 'application/json' }; const key = sessionStorage.getItem('lumina-ai-key'); if (key) headers.Authorization = `Bearer ${key}`; if (aiConfig.provider === 'openrouter') { headers['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin; headers['X-OpenRouter-Title'] = 'Lumina PDF Studio'; }
      const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`; const baseBody = { model: aiConfig.model, messages, temperature: 0.1 };
      let response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...baseBody, tools: hybridToolSchemas(), tool_choice: 'auto' }) }); if (!response.ok && [400, 404, 422].includes(response.status)) response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(baseBody) }); if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 240)}`);
      const data = await response.json(); const message = data.choices?.[0]?.message || data.message || {}; const content = message.content ?? data.output_text ?? ''; const parsed = parseAIResponse(content); let actions = [...parseToolCalls(message), ...(parsed.actions || [])].map(normalizeHybridAction).filter((action) => HYBRID_TOOLS.has(action?.tool));
      if (!actions.length && /\b(add|put|insert|paste)\b[\s\S]*\b(it|this|that|answer|solution)\b[\s\S]*\b(doc|document|pdf)\b/i.test(prompt) && previousAssistant) actions = [{ tool: 'hybrid_append_page', args: { title: 'AI response', text: previousAssistant } }];
      placeholder.remove(); addAIMessage('assistant', parsed.message || (actions.length ? 'I prepared source-preserving edits for review.' : String(content || 'Done.'))); state.pendingAIActions = filterAIActions(actions); renderActionQueue();
    } catch (error) { placeholder.className = 'ai-message error'; placeholder.textContent = `AI request failed: ${error.message}`; }
    finally { document.querySelector('#send-ai').disabled = false; }
  }

  function addAfterBlock(blockId, text, heading = '') {
    const element = findElement(blockId); const page = hybrid.model.pages.find((item) => item.index === element?.page); if (!element || !page) { hybrid.appended.push({ type: 'append_page', title: heading || 'Continued', text }); return; }
    const following = (page.elements || []).filter((item) => item.id !== element.id && item.bbox[1] >= element.bbox[3]).map((item) => item.bbox[1]); const below = following.length ? Math.min(...following) : page.height - 54; const available = below - element.bbox[3] - 10;
    if (available >= 72) {
      const id = `new-${makeId('text')}`; hybrid.added.set(id, { id, type: 'add_text', kind: 'text', page: page.index, bbox: [element.bbox[0], element.bbox[3] + 8, Math.min(page.width - 36, Math.max(element.bbox[2], element.bbox[0] + 360)), Math.min(below - 4, element.bbox[3] + Math.max(72, available))], text: heading ? `${heading}\n${text}` : text, editable: true, style: { fontFamily: 'Helvetica', fontSize: 10.5, color: '#111318', align: 'left', lineHeight: 1.2 } });
    } else hybrid.appended.push({ type: 'append_page', title: heading || 'Continued', text });
  }
  async function applyHybridAction(action) {
    const { tool, args = {} } = normalizeHybridAction(action); const element = findElement(args.block_id);
    if (tool === 'hybrid_replace_block' && element) { hybrid.edits.set(element.id, { type: 'replace_text', elementId: element.id, text: String(args.text || ''), style: clone(element.style || {}) }); return 1; }
    if (tool === 'hybrid_delete_block' && element) { hybrid.edits.set(element.id, { type: 'delete', elementId: element.id }); return 1; }
    if (tool === 'hybrid_insert_after') { addAfterBlock(args.block_id, String(args.text || ''), String(args.heading || '')); return 1; }
    if (tool === 'hybrid_append_page') { hybrid.appended.push({ type: 'append_page', title: String(args.title || 'Continued'), text: String(args.text || '') }); return 1; }
    if (tool === 'hybrid_replace_formula' && element) { let assetDataUrl = ''; try { if (typeof latexToSvgDataUrl === 'function') assetDataUrl = await latexToSvgDataUrl(String(args.latex || '')); } catch (_) { assetDataUrl = ''; } hybrid.edits.set(element.id, { type: 'replace_formula', elementId: element.id, latex: String(args.latex || ''), assetDataUrl }); return 1; }
    return 0;
  }
  async function executeHybridActions() {
    if (!state.pendingAIActions.length) return; const actions = state.pendingAIActions.map(normalizeHybridAction); const ours = actions.filter((action) => HYBRID_TOOLS.has(action.tool)); const others = actions.filter((action) => !HYBRID_TOOLS.has(action.tool)); let applied = 0;
    if (ours.length) { try { await loadModel({ activate: false }); pushHistory(); for (const action of ours) applied += await applyHybridAction(action); activateHybrid(); renderHybridLayer(); flash('AI edits are open in Smart Edit for review'); } catch (error) { addAIMessage('assistant', `Smart Edit actions could not be applied: ${error.message}`); } }
    if (others.length && previousExecutePendingAIActions) { state.pendingAIActions = others; await previousExecutePendingAIActions(); } else { state.pendingAIActions = []; renderActionQueue(); }
    if (applied) addAIMessage('assistant', `${applied} approved source-preserving edit${applied === 1 ? '' : 's'} applied for review.`);
  }

  function installOverrides() {
    if (previousRenderCurrentPage) renderCurrentPage = async function hybridRenderCurrentPage(...args) { const result = await previousRenderCurrentPage(...args); if (hybrid.mode === 'edit') requestAnimationFrame(renderHybridLayer); return result; };
    if (previousPermissionForTool) permissionForTool = function hybridPermission(tool) { if (HYBRID_TOOLS.has(normalizeHybridAction({ tool, args: {} }).tool)) return 'add_content'; return previousPermissionForTool(tool); };
    if (previousSendAIMessage) sendAIMessage = sendHybridAI; if (previousExecutePendingAIActions) executePendingAIActions = executeHybridActions;
  }

  window.LuminaHybridEditor = { state: hybrid, enter: enterHybridMode, saveAndRead, discard: discardHybrid, loadModel, undo: undoHybrid, redo: redoHybrid, applyAIAction: applyHybridAction };
  createUi(); installOverrides(); updateHybridUi();
}());
