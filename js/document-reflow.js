(function () {
  'use strict';

  const DOC_TOOLS = new Set([
    'document_replace_text', 'document_insert_after', 'document_append', 'document_insert_equation',
    'document_insert_table', 'document_format', 'document_delete', 'document_set_title',
  ]);
  const INLINE_ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'SPAN', 'CODE', 'SUB', 'SUP']);
  const clone = (value) => structuredClone(value);
  const reflow = {
    mode: 'read', model: null, documentId: null, history: [], future: [], selectedIds: new Set(),
    activeId: null, typingBaseline: null, typingChanged: false, busy: false, docxBase64: '', markdown: '', converter: '',
  };

  const previousSendAIMessage = typeof sendAIMessage === 'function' ? sendAIMessage : null;
  const previousExecutePendingAIActions = typeof executePendingAIActions === 'function' ? executePendingAIActions : null;
  const previousPermissionForTool = typeof permissionForTool === 'function' ? permissionForTool : null;
  const previousAISystemPrompt = typeof aiSystemPrompt === 'function' ? aiSystemPrompt : null;

  function uid(prefix = 'block') { return `${prefix}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`; }
  function currentDocument() { return typeof activeDocument === 'function' ? activeDocument() : null; }
  function bytesFromBase64(value) {
    if (typeof bytesToBase64Bytes === 'function') return bytesToBase64Bytes(value);
    const binary = atob(value); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function escapeHtml(value) {
    const div = document.createElement('div'); div.textContent = String(value ?? '');
    return div.innerHTML.replace(/\n/g, '<br>');
  }
  function sanitizeRichHtml(value) {
    const source = document.createElement('div'); source.innerHTML = String(value || '');
    const clean = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
        if (!INLINE_ALLOWED.has(child.tagName)) { child.replaceWith(document.createTextNode(child.textContent || '')); continue; }
        const style = child.getAttribute('style') || '';
        [...child.attributes].forEach((attribute) => child.removeAttribute(attribute.name));
        if (child.tagName === 'SPAN') {
          const allowed = [];
          const color = style.match(/color\s*:\s*(#[0-9a-f]{6})/i)?.[1];
          const fontSize = style.match(/font-size\s*:\s*([0-9.]+)px/i)?.[1];
          const family = style.match(/font-family\s*:\s*([^;]+)/i)?.[1];
          if (color) allowed.push(`color:${color}`);
          if (fontSize) allowed.push(`font-size:${fontSize}px`);
          if (family) allowed.push(`font-family:${family.replace(/["']/g, '')}`);
          if (allowed.length) child.setAttribute('style', allowed.join(';'));
        }
        clean(child);
      }
    };
    clean(source); return source.innerHTML;
  }
  function blockText(block) {
    if (!block) return '';
    if (block.type === 'table') return (block.rows || []).flat().join('\n');
    if (block.type === 'image') return block.alt || '';
    const div = document.createElement('div'); div.innerHTML = block.html || escapeHtml(block.text || '');
    return (div.innerText || div.textContent || '').trim();
  }
  function modelText(limit = 36000) {
    if (!reflow.model) return '';
    return (reflow.model.blocks || []).map((block) => {
      if (block.type === 'page_break') return '\n--- page break ---\n';
      if (block.type === 'table') return (block.rows || []).map((row) => row.join(' | ')).join('\n');
      return blockText(block);
    }).join('\n\n').slice(0, limit);
  }
  function snapshot() { syncModelFromDom(); return clone(reflow.model); }
  function pushHistory(before = null) {
    if (!reflow.model || reflow.busy) return;
    reflow.history.push(before || snapshot()); reflow.history = reflow.history.slice(-100); reflow.future = []; updateChrome();
  }
  function undoReflow() {
    commitTypingHistory(); if (!reflow.history.length) return;
    reflow.future.unshift(snapshot()); reflow.model = reflow.history.pop(); reflow.selectedIds.clear(); reflow.activeId = null; renderModel(); updateChrome();
  }
  function redoReflow() {
    commitTypingHistory(); if (!reflow.future.length) return;
    reflow.history.push(snapshot()); reflow.model = reflow.future.shift(); reflow.selectedIds.clear(); reflow.activeId = null; renderModel(); updateChrome();
  }
  function beginTypingHistory() {
    if (!reflow.typingBaseline) { reflow.typingBaseline = clone(reflow.model); reflow.typingChanged = false; }
  }
  function commitTypingHistory() {
    if (reflow.typingBaseline && reflow.typingChanged) {
      reflow.history.push(reflow.typingBaseline); reflow.history = reflow.history.slice(-100); reflow.future = [];
    }
    reflow.typingBaseline = null; reflow.typingChanged = false; updateChrome();
  }

  function createUi() {
    if (document.querySelector('#reflow-editor-shell')) return;
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = './css/styles-document-reflow.css'; stylesheet.dataset.reflowEditor = 'true'; document.head.appendChild(stylesheet);
    const oldModeButton = document.querySelector('#document-mode-button'); if (!oldModeButton) return;
    const modeButton = oldModeButton.cloneNode(true); oldModeButton.replaceWith(modeButton);
    modeButton.querySelector('#document-mode-label').textContent = 'Edit document';
    modeButton.title = 'Convert the PDF into a flowing DOCX-style document for editing';
    modeButton.addEventListener('click', () => { if (reflow.mode === 'edit') saveAndRead(); else enterReflowMode(); });
    const oldDiscard = document.querySelector('#document-discard-button');
    const discard = oldDiscard.cloneNode(true); oldDiscard.replaceWith(discard); discard.addEventListener('click', discardReflowEdits);
    const layoutButton = document.createElement('button'); layoutButton.type = 'button'; layoutButton.id = 'layout-edit-button'; layoutButton.className = 'button ghost layout-edit-button';
    layoutButton.title = 'Use the legacy page-coordinate editor for exact placement'; layoutButton.innerHTML = '<i data-lucide="scan-text"></i><span>Layout</span>';
    modeButton.parentElement.appendChild(layoutButton);
    layoutButton.addEventListener('click', async () => { if (reflow.mode === 'edit') discardReflowEdits(); await window.LuminaDocumentEditor?.enter?.(); });

    const shell = document.createElement('section'); shell.id = 'reflow-editor-shell'; shell.className = 'reflow-editor-shell hidden';
    shell.innerHTML = `
      <div class="reflow-ribbon" role="toolbar" aria-label="Document editing tools">
        <div class="reflow-group"><button type="button" data-reflow-command="undo" title="Undo"><i data-lucide="undo-2"></i></button><button type="button" data-reflow-command="redo" title="Redo"><i data-lucide="redo-2"></i></button></div>
        <span class="reflow-separator"></span>
        <div class="reflow-group">
          <select id="reflow-block-style" title="Paragraph style"><option value="paragraph">Normal</option><option value="heading:1">Title</option><option value="heading:2">Heading 1</option><option value="heading:3">Heading 2</option><option value="quote">Quote</option><option value="equation">Equation</option><option value="list_item:bullet">Bulleted list</option><option value="list_item:number">Numbered list</option></select>
          <select id="reflow-font-family" title="Font family"><option>Arial</option><option>Calibri</option><option>Times New Roman</option><option>Cambria Math</option><option>Courier New</option></select>
          <input id="reflow-font-size" type="number" min="6" max="96" step="1" value="11" title="Font size" />
          <button type="button" data-reflow-command="bold" title="Bold"><b>B</b></button><button type="button" data-reflow-command="italic" title="Italic"><i>I</i></button><button type="button" data-reflow-command="underline" title="Underline"><u>U</u></button>
          <label class="reflow-color" title="Text colour"><input id="reflow-color" type="color" value="#111318" /></label>
        </div>
        <span class="reflow-separator"></span>
        <div class="reflow-group"><button type="button" data-reflow-align="left" title="Align left"><i data-lucide="align-left"></i></button><button type="button" data-reflow-align="center" title="Align centre"><i data-lucide="align-center"></i></button><button type="button" data-reflow-align="right" title="Align right"><i data-lucide="align-right"></i></button><button type="button" data-reflow-align="justify" title="Justify"><i data-lucide="align-justify"></i></button></div>
        <span class="reflow-separator"></span>
        <div class="reflow-group"><button type="button" data-reflow-insert="paragraph" title="Insert paragraph"><i data-lucide="pilcrow"></i><span>Text</span></button><button type="button" data-reflow-insert="equation" title="Insert equation"><i data-lucide="sigma"></i><span>Math</span></button><button type="button" data-reflow-insert="table" title="Insert table"><i data-lucide="table-2"></i><span>Table</span></button><button type="button" data-reflow-insert="image" title="Insert image"><i data-lucide="image-plus"></i><span>Image</span></button><button type="button" data-reflow-insert="page_break" title="Insert page break"><i data-lucide="file-plus-2"></i></button></div>
        <span class="reflow-separator"></span>
        <div class="reflow-group"><button type="button" data-reflow-command="move_up" title="Move block up"><i data-lucide="arrow-up"></i></button><button type="button" data-reflow-command="move_down" title="Move block down"><i data-lucide="arrow-down"></i></button><button type="button" data-reflow-command="duplicate" title="Duplicate block"><i data-lucide="copy"></i></button><button type="button" class="danger" data-reflow-command="delete" title="Delete block"><i data-lucide="trash-2"></i></button></div>
        <span class="reflow-spacer"></span>
        <div class="reflow-group reflow-export-group"><button type="button" id="reflow-download-docx"><i data-lucide="file-type-2"></i><span>DOCX</span></button><button type="button" id="reflow-download-md"><i data-lucide="file-text"></i><span>Markdown</span></button><span id="reflow-status">Reflow edit</span></div>
      </div>
      <div class="reflow-workspace"><aside class="reflow-outline"><h3>Document</h3><div id="reflow-outline-list" class="reflow-outline-list"></div><button type="button" id="reflow-add-end"><i data-lucide="plus"></i>Add paragraph</button></aside><div class="reflow-scroll"><article id="reflow-document" class="reflow-document" aria-label="Editable flowing document"></article></div></div>
      <input id="reflow-image-input" type="file" accept="image/png,image/jpeg,image/webp" hidden />`;
    document.querySelector('.editor-shell').appendChild(shell); bindUi(); updateChrome();
    if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }

  function bindUi() {
    document.querySelectorAll('[data-reflow-command]').forEach((button) => button.addEventListener('click', () => runCommand(button.dataset.reflowCommand)));
    document.querySelectorAll('[data-reflow-align]').forEach((button) => button.addEventListener('click', () => applyBlockStyle({ align: button.dataset.reflowAlign })));
    document.querySelectorAll('[data-reflow-insert]').forEach((button) => button.addEventListener('click', () => insertBlock(button.dataset.reflowInsert)));
    document.querySelector('#reflow-block-style').addEventListener('change', (event) => changeBlockType(event.target.value));
    document.querySelector('#reflow-font-family').addEventListener('change', (event) => applyBlockStyle({ fontFamily: event.target.value }));
    document.querySelector('#reflow-font-size').addEventListener('change', (event) => applyBlockStyle({ fontSize: Math.max(6, Math.min(96, Number(event.target.value) || 11)) }));
    document.querySelector('#reflow-color').addEventListener('input', (event) => applyBlockStyle({ color: event.target.value }));
    document.querySelector('#reflow-download-docx').addEventListener('click', downloadDocx); document.querySelector('#reflow-download-md').addEventListener('click', downloadMarkdown);
    document.querySelector('#reflow-add-end').addEventListener('click', () => insertBlock('paragraph', true)); document.querySelector('#reflow-image-input').addEventListener('change', handleImageInput);
    const documentElement = document.querySelector('#reflow-document');
    documentElement.addEventListener('click', handleDocumentClick); documentElement.addEventListener('focusin', handleFocusIn); documentElement.addEventListener('focusout', () => setTimeout(commitTypingHistory, 0));
    documentElement.addEventListener('beforeinput', beginTypingHistory); documentElement.addEventListener('input', handleDocumentInput); documentElement.addEventListener('keydown', handleDocumentKeydown);
    window.addEventListener('keydown', handleGlobalKeydown, true);
  }

  function updateChrome() {
    const modeButton = document.querySelector('#document-mode-button'); if (!modeButton) return;
    const editing = reflow.mode === 'edit'; modeButton.classList.toggle('primary', editing); modeButton.classList.toggle('ghost', !editing); modeButton.disabled = reflow.busy;
    modeButton.querySelector('#document-mode-label').textContent = editing ? 'Save & Read' : 'Edit document';
    document.querySelector('#document-discard-button')?.classList.toggle('hidden', !editing); document.querySelector('#layout-edit-button')?.classList.toggle('hidden', editing);
    document.querySelector('#reflow-editor-shell')?.classList.toggle('hidden', !editing); document.body.classList.toggle('reflow-edit-mode', editing);
    const undo = document.querySelector('[data-reflow-command="undo"]'); const redo = document.querySelector('[data-reflow-command="redo"]');
    if (undo) undo.disabled = !reflow.history.length; if (redo) redo.disabled = !reflow.future.length;
    const status = document.querySelector('#reflow-status');
    if (status) { const blocks = reflow.model?.blocks?.filter((block) => block.type !== 'page_break').length || 0; status.textContent = reflow.busy ? 'Converting…' : `${blocks} blocks${reflow.converter ? ` · ${reflow.converter}` : ''}`; }
  }

  async function loadModel({ activate = false, force = false } = {}) {
    const documentState = currentDocument(); if (!documentState) throw new Error('Open a PDF first.');
    if (!force && reflow.model && reflow.documentId === documentState.id) { if (activate) activateEditor(); return reflow.model; }
    if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('Reflow editing needs the local engine. Run npm start.');
    if (!(nativeEngine.health?.capabilities || []).includes('reflow_document')) throw new Error('The local engine is outdated. Pull the latest code and restart npm start.');
    setLoading(true, 'Converting PDF into an editable document…');
    try {
      const body = new FormData(); body.append('file', new Blob([documentState.bytes], { type: 'application/pdf' }), documentState.name || 'document.pdf'); body.append('title', documentState.name?.replace(/\.pdf$/i, '') || 'Document');
      const response = await fetch('/api/document/import', { method: 'POST', body }); const payload = await response.json();
      if (!response.ok) throw new Error(engineErrorMessage(payload, 'The PDF could not be converted to an editable document.'));
      reflow.model = payload.model; reflow.markdown = payload.markdown || ''; reflow.documentId = documentState.id; reflow.history = []; reflow.future = []; reflow.selectedIds.clear(); reflow.activeId = null;
      if (activate) activateEditor(); return reflow.model;
    } finally { setLoading(false); }
  }
  async function enterReflowMode() {
    if (reflow.busy) return;
    try { if (window.LuminaDocumentEditor?.state?.mode === 'edit') window.LuminaDocumentEditor.discard?.(); await loadModel({ activate: true }); flash('Reflow edit mode: the PDF is now a flowing DOCX-style document'); }
    catch (error) { flash(error.message); }
  }
  function activateEditor() { reflow.mode = 'edit'; renderModel(); updateChrome(); }
  function discardReflowEdits() {
    commitTypingHistory(); reflow.mode = 'read'; reflow.model = null; reflow.documentId = null; reflow.history = []; reflow.future = []; reflow.selectedIds.clear(); reflow.activeId = null; updateChrome(); flash('Reflow edits discarded; the source PDF was not changed');
  }
  function styleString(style = {}) {
    const family = String(style.fontFamily || 'Arial').replace(/["']/g, ''); const size = Math.max(6, Number(style.fontSize) || 11);
    return `font-family:${family};font-size:${size}pt;color:${style.color || '#111318'};font-weight:${style.bold ? '700' : '400'};font-style:${style.italic ? 'italic' : 'normal'};text-decoration:${style.underline ? 'underline' : 'none'};text-align:${style.align || 'left'};line-height:${style.lineHeight || 1.2}`;
  }
  function renderModel() {
    const container = document.querySelector('#reflow-document'); if (!container || !reflow.model) return; container.innerHTML = '';
    for (const block of reflow.model.blocks || []) container.appendChild(renderBlock(block));
    if (!container.children.length) { const block = newParagraph('Start typing…'); reflow.model.blocks = [block]; container.appendChild(renderBlock(block)); }
    renderOutline(); syncToolbar(); if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }
  function renderBlock(block) {
    const wrapper = document.createElement('section'); wrapper.className = `reflow-block type-${block.type}${reflow.selectedIds.has(block.id) ? ' selected' : ''}`; wrapper.dataset.blockId = block.id; wrapper.dataset.blockType = block.type;
    if (block.type === 'page_break') { wrapper.innerHTML = '<div class="reflow-page-break"><span>Page break</span></div>'; return wrapper; }
    if (block.type === 'table') {
      const table = document.createElement('table'); table.className = 'reflow-table';
      for (const row of block.rows || []) { const tr = document.createElement('tr'); for (const cellValue of row) { const cell = document.createElement('td'); cell.contentEditable = 'true'; cell.textContent = cellValue; tr.appendChild(cell); } table.appendChild(tr); }
      wrapper.appendChild(table); return wrapper;
    }
    if (block.type === 'image') {
      const figure = document.createElement('figure'); const image = document.createElement('img'); image.src = block.dataUrl || ''; image.alt = block.alt || 'Document image'; image.style.width = `${Math.max(80, Number(block.width) || 320)}px`; figure.appendChild(image);
      const caption = document.createElement('figcaption'); caption.contentEditable = 'true'; caption.textContent = block.alt || ''; figure.appendChild(caption); wrapper.appendChild(figure); return wrapper;
    }
    const content = document.createElement(block.type === 'heading' ? `h${Math.max(1, Math.min(6, Number(block.level) || 2))}` : block.type === 'quote' ? 'blockquote' : block.type === 'list_item' ? 'div' : 'p');
    content.className = 'reflow-editable'; content.contentEditable = 'true'; content.spellcheck = true; content.style.cssText = styleString(block.style);
    if (block.type === 'list_item') content.dataset.marker = block.listType === 'number' ? '1.' : '•'; if (block.type === 'equation') content.classList.add('reflow-equation');
    content.innerHTML = sanitizeRichHtml(block.html || escapeHtml(block.text || '')) || '<br>'; wrapper.appendChild(content); return wrapper;
  }
  function renderOutline() {
    const outline = document.querySelector('#reflow-outline-list'); if (!outline || !reflow.model) return;
    outline.innerHTML = (reflow.model.blocks || []).filter((block) => block.type === 'heading').map((block) => `<button type="button" data-outline-id="${block.id}" style="padding-left:${Math.max(0, (Number(block.level) || 1) - 1) * 12 + 8}px">${escapeHtml(blockText(block) || 'Untitled heading')}</button>`).join('') || '<p>No headings yet</p>';
    outline.querySelectorAll('[data-outline-id]').forEach((button) => button.addEventListener('click', () => document.querySelector(`[data-block-id="${CSS.escape(button.dataset.outlineId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })));
  }
  function syncModelFromDom() {
    const container = document.querySelector('#reflow-document'); if (!container || !reflow.model || reflow.mode !== 'edit') return;
    const oldById = new Map((reflow.model.blocks || []).map((block) => [block.id, block])); const blocks = [];
    for (const wrapper of container.querySelectorAll(':scope > .reflow-block')) {
      const old = oldById.get(wrapper.dataset.blockId) || { id: wrapper.dataset.blockId, type: wrapper.dataset.blockType, style: {} }; const block = clone(old); block.type = wrapper.dataset.blockType || block.type;
      if (block.type === 'table') block.rows = [...wrapper.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('td,th')].map((cell) => cell.innerText));
      else if (block.type === 'image') { block.alt = wrapper.querySelector('figcaption')?.innerText || block.alt || ''; block.width = Number.parseFloat(wrapper.querySelector('img')?.style.width) || block.width || 320; }
      else if (block.type !== 'page_break') { const editable = wrapper.querySelector('.reflow-editable'); block.html = sanitizeRichHtml(editable?.innerHTML || ''); block.text = editable?.innerText || ''; }
      blocks.push(block);
    }
    reflow.model.blocks = blocks;
  }
  function handleDocumentClick(event) {
    const wrapper = event.target.closest?.('.reflow-block'); if (!wrapper) return; const id = wrapper.dataset.blockId;
    if (event.shiftKey || event.ctrlKey || event.metaKey) { if (reflow.selectedIds.has(id)) reflow.selectedIds.delete(id); else reflow.selectedIds.add(id); }
    else if (!reflow.selectedIds.has(id)) reflow.selectedIds = new Set([id]);
    reflow.activeId = id; document.querySelectorAll('.reflow-block').forEach((element) => element.classList.toggle('selected', reflow.selectedIds.has(element.dataset.blockId))); syncToolbar();
  }
  function handleFocusIn(event) {
    const wrapper = event.target.closest?.('.reflow-block'); if (!wrapper) return; reflow.activeId = wrapper.dataset.blockId;
    if (!reflow.selectedIds.has(reflow.activeId)) reflow.selectedIds = new Set([reflow.activeId]);
    document.querySelectorAll('.reflow-block').forEach((element) => element.classList.toggle('selected', reflow.selectedIds.has(element.dataset.blockId))); syncToolbar();
  }
  function handleDocumentInput() { reflow.typingChanged = true; syncModelFromDom(); renderOutline(); updateChrome(); }
  function handleDocumentKeydown(event) {
    if (event.key === 'Tab' && event.target.closest('td')) { event.preventDefault(); const cells = [...document.querySelectorAll('#reflow-document td')]; const index = cells.indexOf(event.target); cells[(index + (event.shiftKey ? -1 : 1) + cells.length) % cells.length]?.focus(); }
  }
  function handleGlobalKeydown(event) {
    if (reflow.mode !== 'edit') return; const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); saveAndRead(); return; }
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopImmediatePropagation(); event.shiftKey ? redoReflow() : undoReflow(); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopImmediatePropagation(); redoReflow(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.target.closest?.('[contenteditable="true"],input,textarea,select')) { event.preventDefault(); deleteSelectedBlocks(); }
  }
  function selectedBlocks() {
    syncModelFromDom(); const ids = reflow.selectedIds.size ? reflow.selectedIds : reflow.activeId ? new Set([reflow.activeId]) : new Set();
    return (reflow.model?.blocks || []).filter((block) => ids.has(block.id));
  }
  function syncToolbar() {
    const block = selectedBlocks()[0]; if (!block) return; const style = block.style || {}; const typeSelect = document.querySelector('#reflow-block-style');
    if (typeSelect) typeSelect.value = block.type === 'heading' ? `heading:${block.level || 2}` : block.type === 'list_item' ? `list_item:${block.listType || 'bullet'}` : block.type;
    const family = document.querySelector('#reflow-font-family'); if (family && [...family.options].some((option) => option.value === (style.fontFamily || 'Arial'))) family.value = style.fontFamily || 'Arial';
    const size = document.querySelector('#reflow-font-size'); if (size) size.value = String(Math.round(Number(style.fontSize) || 11)); const color = document.querySelector('#reflow-color'); if (color && /^#[0-9a-f]{6}$/i.test(style.color || '')) color.value = style.color;
  }
  function runCommand(command) {
    if (command === 'undo') return undoReflow(); if (command === 'redo') return redoReflow(); if (command === 'delete') return deleteSelectedBlocks(); if (command === 'duplicate') return duplicateSelectedBlocks(); if (command === 'move_up' || command === 'move_down') return moveSelectedBlocks(command === 'move_up' ? -1 : 1);
    if (['bold', 'italic', 'underline'].includes(command)) {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode?.parentElement?.closest('#reflow-document')) { beginTypingHistory(); document.execCommand(command, false); reflow.typingChanged = true; syncModelFromDom(); }
      else { const blocks = selectedBlocks(); if (!blocks.length) return; pushHistory(); const next = !Boolean(blocks[0].style?.[command]); blocks.forEach((block) => { block.style = { ...(block.style || {}), [command]: next }; }); renderModel(); }
    }
  }
  function applyBlockStyle(changes) { const blocks = selectedBlocks(); if (!blocks.length) return; pushHistory(); blocks.forEach((block) => { block.style = { ...(block.style || {}), ...changes }; }); renderModel(); }
  function changeBlockType(value) {
    const blocks = selectedBlocks(); if (!blocks.length) return; pushHistory(); const [type, extra] = String(value).split(':');
    blocks.forEach((block) => { if (['table', 'image', 'page_break'].includes(block.type)) return; block.type = type; if (type === 'heading') block.level = Number(extra) || 2; if (type === 'list_item') block.listType = extra || 'bullet'; if (type === 'equation') block.style = { ...(block.style || {}), fontFamily: 'Cambria Math', align: 'center' }; }); renderModel();
  }
  function insertionIndex(atEnd = false) { if (atEnd || !reflow.activeId) return reflow.model.blocks.length; const index = reflow.model.blocks.findIndex((block) => block.id === reflow.activeId); return index < 0 ? reflow.model.blocks.length : index + 1; }
  function newParagraph(text = '') { return { id: uid('paragraph'), type: 'paragraph', html: escapeHtml(text), text, style: { fontFamily: 'Arial', fontSize: 11, color: '#111318', align: 'left', lineHeight: 1.2 } }; }
  async function insertBlock(type, atEnd = false) {
    if (!reflow.model) return; if (type === 'image') { document.querySelector('#reflow-image-input').click(); return; } pushHistory(); let block;
    if (type === 'paragraph') block = newParagraph('');
    else if (type === 'equation') { const value = window.prompt('Enter LaTeX or editable equation text:', '\\begin{bmatrix} a & b \\ c & d \\end{bmatrix}'); if (value === null) { reflow.history.pop(); updateChrome(); return; } block = { id: uid('equation'), type: 'equation', html: escapeHtml(value), text: value, latex: value, style: { fontFamily: 'Cambria Math', fontSize: 12, color: '#111318', align: 'center', lineHeight: 1.2 } }; }
    else if (type === 'table') { const rows = Math.max(1, Math.min(20, Number(window.prompt('Rows:', '3')) || 3)); const columns = Math.max(1, Math.min(12, Number(window.prompt('Columns:', '3')) || 3)); block = { id: uid('table'), type: 'table', rows: Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => row === 0 ? `Header ${column + 1}` : '')), style: { fontFamily: 'Arial', fontSize: 10, color: '#111318' } }; }
    else if (type === 'page_break') block = { id: uid('break'), type: 'page_break' }; if (!block) return;
    const index = insertionIndex(atEnd); reflow.model.blocks.splice(index, 0, block); reflow.selectedIds = new Set([block.id]); reflow.activeId = block.id; renderModel(); setTimeout(() => document.querySelector(`[data-block-id="${CSS.escape(block.id)}"] [contenteditable="true"]`)?.focus(), 0);
  }
  async function handleImageInput(event) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error || new Error('Could not read image')); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
    const dimensions = await new Promise((resolve) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth || 640, height: image.naturalHeight || 480 }); image.onerror = () => resolve({ width: 640, height: 480 }); image.src = dataUrl; });
    pushHistory(); const width = Math.min(520, dimensions.width); const block = { id: uid('image'), type: 'image', dataUrl, mime: file.type, width, height: width / Math.max(0.1, dimensions.width / dimensions.height), alt: file.name };
    reflow.model.blocks.splice(insertionIndex(), 0, block); reflow.selectedIds = new Set([block.id]); reflow.activeId = block.id; renderModel();
  }
  function deleteSelectedBlocks() { const blocks = selectedBlocks(); if (!blocks.length) return; pushHistory(); const ids = new Set(blocks.map((block) => block.id)); reflow.model.blocks = reflow.model.blocks.filter((block) => !ids.has(block.id)); reflow.selectedIds.clear(); reflow.activeId = null; renderModel(); }
  function duplicateSelectedBlocks() { const blocks = selectedBlocks(); if (!blocks.length) return; pushHistory(); const lastIndex = Math.max(...blocks.map((block) => reflow.model.blocks.findIndex((item) => item.id === block.id))); const copies = blocks.map((block) => ({ ...clone(block), id: uid(block.type) })); reflow.model.blocks.splice(lastIndex + 1, 0, ...copies); reflow.selectedIds = new Set(copies.map((block) => block.id)); reflow.activeId = copies[0]?.id || null; renderModel(); }
  function moveSelectedBlocks(direction) {
    const blocks = selectedBlocks(); if (!blocks.length) return; pushHistory(); const ids = new Set(blocks.map((block) => block.id)); const remaining = reflow.model.blocks.filter((block) => !ids.has(block.id)); const indices = blocks.map((block) => reflow.model.blocks.findIndex((item) => item.id === block.id)); const target = Math.max(0, Math.min(remaining.length, direction < 0 ? Math.min(...indices) - 1 : Math.max(...indices) - blocks.length + 2)); remaining.splice(target, 0, ...blocks); reflow.model.blocks = remaining; renderModel();
  }
  async function renderCurrentModel() {
    syncModelFromDom(); const response = await fetch('/api/document/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: reflow.model, preferOffice: true }) }); const payload = await response.json();
    if (!response.ok) throw new Error(engineErrorMessage(payload, 'The editable document could not be rendered.')); reflow.docxBase64 = payload.docxBase64 || ''; reflow.markdown = payload.markdown || ''; reflow.converter = payload.converter || ''; return payload;
  }
  async function saveAndRead() {
    if (reflow.busy || !reflow.model) return; commitTypingHistory(); reflow.busy = true; updateChrome(); setLoading(true, 'Creating DOCX and regenerating the PDF…');
    try {
      const documentState = currentDocument(); if (!documentState || documentState.id !== reflow.documentId) throw new Error('The source document changed while editing.');
      const payload = await renderCurrentModel(); const nextBytes = bytesFromBase64(payload.pdfBase64); const backups = nativeEngine.backupsByDocument.get(documentState.id) || []; backups.push(documentState.bytes.slice()); nativeEngine.backupsByDocument.set(documentState.id, backups.slice(-10)); await replaceSourceDocumentBytes(documentState, nextBytes);
      reflow.mode = 'read'; reflow.history = []; reflow.future = []; reflow.selectedIds.clear(); reflow.activeId = null; updateChrome(); flash(`Document regenerated from DOCX-style content${payload.converter ? ` using ${payload.converter}` : ''}`);
    } catch (error) { flash(`Could not regenerate the PDF: ${error.message}`); }
    finally { reflow.busy = false; setLoading(false); updateChrome(); }
  }
  function downloadBlob(bytes, filename, type) { const blob = new Blob([bytes], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function downloadDocx() { try { if (!reflow.model) await loadModel({ activate: false }); if (!reflow.docxBase64 || reflow.mode === 'edit') await renderCurrentModel(); const documentState = currentDocument(); downloadBlob(bytesFromBase64(reflow.docxBase64), `${(documentState?.name || 'document').replace(/\.pdf$/i, '')}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); } catch (error) { flash(error.message); } }
  async function downloadMarkdown() { try { if (!reflow.model) await loadModel({ activate: false }); if (!reflow.markdown || reflow.mode === 'edit') await renderCurrentModel(); const documentState = currentDocument(); downloadBlob(new TextEncoder().encode(reflow.markdown), `${(documentState?.name || 'document').replace(/\.pdf$/i, '')}.md`, 'text/markdown'); } catch (error) { flash(error.message); } }

  function normalizeDocumentAction(action) {
    if (!action || typeof action.tool !== 'string') return action; const args = { ...(action.args || {}) }; let tool = action.tool;
    if (tool === 'edit_text' || tool === 'replace_text') { tool = 'document_replace_text'; args.search = args.search || args.originalText || ''; args.replacement = args.replacement ?? args.text ?? ''; }
    else if (tool === 'insert_answer' || tool === 'add_answer') { tool = 'document_insert_after'; args.anchor = args.anchor || args.after_text || args.afterText || ''; }
    else if (tool === 'add_native_text' || tool === 'add_text') tool = 'document_append';
    return { tool, args };
  }
  function toolSchema(name, description, properties, required) { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }; }
  function documentToolSchemas() {
    return [
      toolSchema('document_replace_text', 'Replace text in the flowing document. This is not constrained to the original PDF rectangle.', { search: { type: 'string' }, replacement: { type: 'string' }, all: { type: 'boolean' } }, ['search', 'replacement']),
      toolSchema('document_insert_after', 'Insert one or more paragraphs after text already in the document.', { anchor: { type: 'string' }, text: { type: 'string' }, heading: { type: 'string' } }, ['text']),
      toolSchema('document_append', 'Append a section or paragraphs to the end of the document.', { heading: { type: 'string' }, text: { type: 'string' } }, ['text']),
      toolSchema('document_insert_equation', 'Insert an editable equation block using LaTeX or plain mathematical text.', { latex: { type: 'string' }, after: { type: 'string' } }, ['latex']),
      toolSchema('document_insert_table', 'Insert an editable table.', { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, after: { type: 'string' } }, ['rows']),
      toolSchema('document_format', 'Apply a paragraph style to blocks containing the search text.', { search: { type: 'string' }, type: { type: 'string', enum: ['paragraph', 'heading', 'quote', 'equation', 'list_item'] }, level: { type: 'integer', minimum: 1, maximum: 6 }, align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] }, bold: { type: 'boolean' }, italic: { type: 'boolean' } }, ['search']),
      toolSchema('document_delete', 'Delete text or whole blocks from the flowing document.', { search: { type: 'string' }, whole_block: { type: 'boolean' }, all: { type: 'boolean' } }, ['search']),
      toolSchema('document_set_title', 'Set the editable document title.', { title: { type: 'string' } }, ['title']),
    ];
  }
  function parseToolCalls(message) {
    const actions = [];
    for (const call of message?.tool_calls || []) { let args = {}; try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) { args = {}; } if (call.function?.name) actions.push({ tool: call.function.name, args }); }
    return actions;
  }
  function reflowPrompt() {
    return `You edit Lumina's flowing DOCX-style document model, not fixed PDF rectangles. Use document_replace_text for corrections, document_insert_after or document_append for answers and long content, document_insert_equation for mathematics, and document_insert_table for tabular data. Preserve the source meaning unless the user asks for a rewrite. Never claim an edit occurred before approval. Return tool calls when supported. Otherwise return JSON only: {"message":"helpful response","actions":[{"tool":"document_insert_after","args":{"anchor":"Question 1","text":"Solution..."}}]}.`;
  }
  async function sendReflowAI() {
    const prompt = el.aiPrompt.value.trim(); if (!prompt) return; if (!aiConfig.baseUrl || !aiConfig.model) { openAIModal(); return; }
    const previousAssistant = [...state.aiConversation].reverse().find((message) => message.role === 'assistant')?.content || ''; addAIMessage('user', prompt); el.aiPrompt.value = ''; document.querySelector('#send-ai').disabled = true;
    const placeholder = document.createElement('div'); placeholder.className = 'ai-message assistant'; placeholder.textContent = 'Thinking in document mode…'; el.aiChat.appendChild(placeholder);
    try {
      if (state.aiUseDocument && aiConfig.permissions.read_document) await loadModel({ activate: false }); const context = state.aiUseDocument && aiConfig.permissions.read_document ? modelText() : '';
      const messages = [{ role: 'system', content: reflowPrompt() }, ...state.aiConversation.slice(0, -1).slice(-10).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })), { role: 'user', content: context ? `${prompt}\n\nEditable document content:\n${context}` : prompt }];
      const headers = { 'Content-Type': 'application/json' }; const key = sessionStorage.getItem('lumina-ai-key'); if (key) headers.Authorization = `Bearer ${key}`;
      if (aiConfig.provider === 'openrouter') { headers['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin; headers['X-OpenRouter-Title'] = 'Lumina PDF Studio'; }
      const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`; const baseBody = { model: aiConfig.model, messages, temperature: 0.12 };
      let response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...baseBody, tools: documentToolSchemas(), tool_choice: 'auto' }) });
      if (!response.ok && [400, 404, 422].includes(response.status)) response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(baseBody) });
      if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 240)}`);
      const data = await response.json(); const message = data.choices?.[0]?.message || data.message || {}; const content = message.content ?? data.output_text ?? ''; const parsed = parseAIResponse(content);
      let actions = [...parseToolCalls(message), ...(parsed.actions || [])].map(normalizeDocumentAction).filter((action) => action?.tool);
      if (!actions.length && /\b(add|put|insert|paste)\b[\s\S]*\b(it|this|that|answer|solution)\b[\s\S]*\b(doc|document|pdf)\b/i.test(prompt) && previousAssistant) actions = [{ tool: 'document_append', args: { text: previousAssistant } }];
      placeholder.remove(); addAIMessage('assistant', parsed.message || (actions.length ? 'I prepared document-model edits for review.' : String(content || 'Done.'))); state.pendingAIActions = filterAIActions(actions); const blocked = actions.length - state.pendingAIActions.length;
      if (blocked) addAIMessage('assistant', `${blocked} action${blocked === 1 ? ' was' : 's were'} blocked by permissions.`); renderActionQueue();
    } catch (error) { placeholder.className = 'ai-message error'; placeholder.textContent = `AI request failed: ${error.message}`; }
    finally { document.querySelector('#send-ai').disabled = false; }
  }
  function findBlockIndex(anchor) { const query = String(anchor || '').trim().toLowerCase(); if (!query) return -1; return (reflow.model?.blocks || []).findIndex((block) => blockText(block).toLowerCase().includes(query)); }
  function paragraphBlocks(text) { return String(text || '').split(/\n\s*\n/).filter((part) => part.trim()).map((part) => newParagraph(part.trim())); }
  function applyDocumentAction(action) {
    const { tool, args = {} } = normalizeDocumentAction(action); const blocks = reflow.model.blocks;
    if (tool === 'document_set_title') { reflow.model.title = String(args.title || 'Document'); return 1; }
    if (tool === 'document_append') { if (args.heading) blocks.push({ id: uid('heading'), type: 'heading', level: 2, html: escapeHtml(args.heading), text: String(args.heading), style: { fontFamily: 'Arial', fontSize: 18, bold: true, color: '#111318', align: 'left', lineHeight: 1.15 } }); blocks.push(...paragraphBlocks(args.text)); return 1; }
    if (tool === 'document_insert_after') { const index = findBlockIndex(args.anchor); const inserted = []; if (args.heading) inserted.push({ id: uid('heading'), type: 'heading', level: 3, html: escapeHtml(args.heading), text: String(args.heading), style: { fontFamily: 'Arial', fontSize: 15, bold: true, color: '#111318', align: 'left', lineHeight: 1.15 } }); inserted.push(...paragraphBlocks(args.text)); blocks.splice(index < 0 ? blocks.length : index + 1, 0, ...inserted); return 1; }
    if (tool === 'document_insert_equation') { const index = findBlockIndex(args.after); const value = String(args.latex || ''); blocks.splice(index < 0 ? blocks.length : index + 1, 0, { id: uid('equation'), type: 'equation', html: escapeHtml(value), text: value, latex: value, style: { fontFamily: 'Cambria Math', fontSize: 12, color: '#111318', align: 'center', lineHeight: 1.2 } }); return 1; }
    if (tool === 'document_insert_table') { const index = findBlockIndex(args.after); const rows = []; if (Array.isArray(args.headers) && args.headers.length) rows.push(args.headers.map(String)); if (Array.isArray(args.rows)) rows.push(...args.rows.map((row) => Array.isArray(row) ? row.map(String) : [String(row)])); blocks.splice(index < 0 ? blocks.length : index + 1, 0, { id: uid('table'), type: 'table', rows, style: { fontFamily: 'Arial', fontSize: 10, color: '#111318' } }); return 1; }
    if (tool === 'document_replace_text') {
      const search = String(args.search || ''); if (!search) return 0; let count = 0;
      for (const block of blocks) {
        if (block.type === 'table') { for (const row of block.rows || []) for (let index = 0; index < row.length; index += 1) if (String(row[index]).includes(search)) { row[index] = String(row[index]).replace(search, String(args.replacement ?? '')); count += 1; if (!args.all) return count; } }
        else if (!['image', 'page_break'].includes(block.type)) { const text = blockText(block); if (text.includes(search)) { const next = text.replace(search, String(args.replacement ?? '')); block.text = next; block.html = escapeHtml(next); count += 1; if (!args.all) return count; } }
      }
      return count;
    }
    if (tool === 'document_delete') {
      const search = String(args.search || ''); let count = 0;
      for (let index = blocks.length - 1; index >= 0; index -= 1) { const block = blocks[index]; if (!blockText(block).includes(search)) continue; if (args.whole_block) blocks.splice(index, 1); else { const next = blockText(block).replace(search, ''); block.text = next; block.html = escapeHtml(next); } count += 1; if (!args.all) break; }
      return count;
    }
    if (tool === 'document_format') {
      let count = 0; for (const block of blocks) { if (!blockText(block).toLowerCase().includes(String(args.search || '').toLowerCase())) continue; if (args.type) block.type = args.type; if (args.level) block.level = args.level; block.style = { ...(block.style || {}) }; for (const key of ['align', 'bold', 'italic']) if (args[key] !== undefined) block.style[key] = args[key]; count += 1; } return count;
    }
    return 0;
  }
  async function executeReflowActions() {
    if (!state.pendingAIActions.length) return; const all = state.pendingAIActions.map(normalizeDocumentAction); const documentActions = all.filter((action) => DOC_TOOLS.has(action.tool)); const otherActions = all.filter((action) => !DOC_TOOLS.has(action.tool)); let applied = 0;
    if (documentActions.length) {
      try { await loadModel({ activate: false }); pushHistory(); for (const action of documentActions) applied += applyDocumentAction(action) ? 1 : 0; activateEditor(); flash('AI edits were applied to the editable document for review'); }
      catch (error) { addAIMessage('assistant', `Document edits could not be applied: ${error.message}`); }
    }
    if (otherActions.length && previousExecutePendingAIActions) { state.pendingAIActions = otherActions; await previousExecutePendingAIActions(); }
    else { state.pendingAIActions = []; renderActionQueue(); }
    if (applied) addAIMessage('assistant', `${applied} approved document edit${applied === 1 ? '' : 's'} applied in Reflow Edit mode. Review them, then choose Save & Read.`);
  }
  function installAIOverrides() {
    if (previousPermissionForTool) permissionForTool = function reflowPermissionForTool(tool) { if (DOC_TOOLS.has(normalizeDocumentAction({ tool, args: {} }).tool)) return 'add_content'; return previousPermissionForTool(tool); };
    if (previousAISystemPrompt) aiSystemPrompt = reflowPrompt; if (previousSendAIMessage) sendAIMessage = sendReflowAI; if (previousExecutePendingAIActions) executePendingAIActions = executeReflowActions;
  }

  window.LuminaReflowEditor = { state: reflow, enter: enterReflowMode, saveAndRead, discard: discardReflowEdits, loadModel, undo: undoReflow, redo: redoReflow, applyAIAction: applyDocumentAction };
  createUi(); installAIOverrides();
})();
