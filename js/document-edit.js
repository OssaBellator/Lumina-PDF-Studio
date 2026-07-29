(function () {
  'use strict';

  const clone = (value) => structuredClone(value);
  const EDITABLE_ANNOTATIONS = new Set(['text', 'image']);
  const NATIVE_AI_TOOLS = new Set(['edit_text', 'add_native_text', 'insert_answer', 'insert_equation']);

  const editor = {
    mode: 'read',
    tool: 'select',
    changes: new Map(),
    added: new Map(),
    layoutCache: new Map(),
    currentObjects: [],
    currentViewport: null,
    currentPageWidth: 0,
    currentPageHeight: 0,
    selectedId: null,
    history: [],
    future: [],
    interaction: null,
    activeEditableId: null,
    activeBefore: null,
    renderingToken: 0,
    committing: false,
    equationTarget: null,
    mathJaxPromise: null,
  };

  const sourceObjectId = (documentId, pageIndex, sourceId) => `source:${documentId}:${pageIndex}:${sourceId}`;
  const annotationObjectId = (pageId, annotationId) => `annotation:${pageId}:${annotationId}`;
  const newObjectId = () => `new:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const layoutKey = (documentId, pageIndex) => `${documentId}:${pageIndex}`;

  function relevantObjectState(object) {
    return {
      kind: object.kind,
      rect: object.rect,
      text: object.text,
      latex: object.latex,
      dataUrl: object.dataUrl,
      style: object.style,
      deleted: Boolean(object.deleted),
      rotation: Number(object.rotation) || 0,
    };
  }

  function objectMatchesOriginal(object) {
    if (!object.original) return false;
    return JSON.stringify(relevantObjectState(object)) === JSON.stringify(object.original);
  }

  function currentDraftCount() {
    return editor.changes.size + editor.added.size;
  }

  function snapshot() {
    return {
      changes: [...editor.changes.entries()].map(([key, value]) => [key, clone(value)]),
      added: [...editor.added.entries()].map(([key, value]) => [key, clone(value)]),
      selectedId: editor.selectedId,
      tool: editor.tool,
    };
  }

  function restoreSnapshot(value) {
    editor.changes = new Map(value.changes.map(([key, object]) => [key, clone(object)]));
    editor.added = new Map(value.added.map(([key, object]) => [key, clone(object)]));
    editor.selectedId = value.selectedId;
    editor.tool = value.tool || 'select';
    renderDocumentEditLayer();
    updateDocumentEditorUI();
  }

  function pushEditHistory() {
    if (editor.mode !== 'edit' || editor.committing) return;
    editor.history.push(snapshot());
    editor.history = editor.history.slice(-80);
    editor.future = [];
    updateDocumentEditorUI();
  }

  function undoDocumentEdit() {
    if (!editor.history.length) return;
    finishActiveInlineEdit();
    editor.future.unshift(snapshot());
    restoreSnapshot(editor.history.pop());
  }

  function redoDocumentEdit() {
    if (!editor.future.length) return;
    finishActiveInlineEdit();
    editor.history.push(snapshot());
    restoreSnapshot(editor.future.shift());
  }

  function injectDocumentEditorUI() {
    if (document.querySelector('#document-mode-button')) return;

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = './css/styles-document-edit.css';
    stylesheet.dataset.documentEdit = 'true';
    document.head.appendChild(stylesheet);

    const actions = document.querySelector('.top-actions');
    const modeGroup = document.createElement('div');
    modeGroup.className = 'document-mode-group';
    modeGroup.innerHTML = `
      <button class="button ghost document-mode-button" id="document-mode-button" type="button">
        <i data-lucide="file-pen-line"></i><span id="document-mode-label">Edit PDF</span>
      </button>
      <button class="button ghost document-discard-button hidden" id="document-discard-button" type="button" title="Discard all unsaved document edits">
        <i data-lucide="x"></i><span>Cancel</span>
      </button>`;
    const nativeButton = document.querySelector('#native-engine-button');
    actions.insertBefore(modeGroup, nativeButton || actions.firstChild);

    const ribbon = document.createElement('div');
    ribbon.id = 'document-edit-ribbon';
    ribbon.className = 'document-edit-ribbon hidden';
    ribbon.innerHTML = `
      <div class="ribbon-group history-group">
        <button class="ribbon-button" id="document-undo" title="Undo (Ctrl/Cmd+Z)"><i data-lucide="undo-2"></i></button>
        <button class="ribbon-button" id="document-redo" title="Redo (Ctrl/Cmd+Shift+Z)"><i data-lucide="redo-2"></i></button>
      </div>
      <div class="ribbon-separator"></div>
      <div class="ribbon-group">
        <button class="ribbon-button active" id="document-select-tool" title="Select and move objects"><i data-lucide="mouse-pointer-2"></i><span>Select</span></button>
        <button class="ribbon-button" id="document-add-text" title="Add a text box"><i data-lucide="type"></i><span>Text</span></button>
        <button class="ribbon-button" id="document-add-equation" title="Add or replace an equation"><i data-lucide="sigma"></i><span>Equation</span></button>
        <button class="ribbon-button" id="document-add-image" title="Add or paste an image"><i data-lucide="image-plus"></i><span>Image</span></button>
      </div>
      <div class="ribbon-separator"></div>
      <div class="ribbon-group format-group">
        <select id="document-font-family" class="ribbon-select font-family" title="Font family">
          <option value="original">Original font</option>
          <option value="Helvetica">Helvetica</option>
          <option value="Times">Times</option>
          <option value="Courier">Courier</option>
        </select>
        <input id="document-font-size" class="ribbon-number" type="number" min="4" max="144" step="0.5" value="11" title="Font size" />
        <button class="ribbon-button" id="document-bold" title="Bold"><b>B</b></button>
        <button class="ribbon-button" id="document-italic" title="Italic"><i>I</i></button>
        <button class="ribbon-button" id="document-underline" title="Underline"><u>U</u></button>
        <label class="ribbon-color" title="Text color"><input id="document-text-color" type="color" value="#111318" /><span></span></label>
        <select id="document-align" class="ribbon-select align-select" title="Paragraph alignment">
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option>
        </select>
        <select id="document-line-height" class="ribbon-select line-height-select" title="Line spacing">
          <option value="1">1.0</option><option value="1.15" selected>1.15</option><option value="1.5">1.5</option><option value="2">2.0</option>
        </select>
      </div>
      <div class="ribbon-separator"></div>
      <div class="ribbon-group object-group">
        <button class="ribbon-button" id="document-duplicate" title="Duplicate selected object (Ctrl/Cmd+D)"><i data-lucide="copy"></i></button>
        <button class="ribbon-button danger" id="document-delete" title="Delete selected object"><i data-lucide="trash-2"></i></button>
      </div>`;
    document.querySelector('.editor-shell').appendChild(ribbon);

    const layer = document.createElement('div');
    layer.id = 'document-text-layer';
    layer.className = 'document-text-layer hidden';
    layer.setAttribute('aria-label', 'Editable PDF object layer');
    el.pageStage.appendChild(layer);

    const hint = document.createElement('div');
    hint.id = 'document-edit-hint';
    hint.className = 'document-edit-hint hidden';
    hint.innerHTML = '<span id="document-edit-instruction"><i data-lucide="mouse-pointer-click"></i>Double-click text to edit</span><b id="document-edit-count">No changes</b>';
    document.querySelector('.editor-shell').appendChild(hint);

    const imageInput = document.createElement('input');
    imageInput.id = 'document-image-input';
    imageInput.type = 'file';
    imageInput.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
    imageInput.hidden = true;
    document.body.appendChild(imageInput);

    const equationModal = document.createElement('div');
    equationModal.id = 'document-equation-modal';
    equationModal.className = 'modal-backdrop hidden';
    equationModal.innerHTML = `
      <div class="modal equation-modal" role="dialog" aria-modal="true" aria-labelledby="equation-modal-title">
        <div class="modal-header"><div><h2 id="equation-modal-title">Edit equation</h2><p>Enter LaTeX. Lumina saves it as scalable vector content in the PDF.</p></div><button class="icon-button" id="close-equation-modal"><i data-lucide="x"></i></button></div>
        <div class="modal-body equation-modal-body">
          <label>LaTeX<textarea id="document-equation-latex" rows="5" placeholder="\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}"></textarea></label>
          <div class="equation-preview" id="document-equation-preview"><span>Equation preview</span></div>
          <p class="equation-help">For existing equations that were stored as outlines or unusual fonts, drag over the whole equation and replace it with LaTeX.</p>
        </div>
        <div class="modal-footer"><button class="button ghost" id="cancel-equation">Cancel</button><button class="button primary" id="save-equation"><i data-lucide="check"></i>Insert equation</button></div>
      </div>`;
    document.body.appendChild(equationModal);

    bindDocumentEditorEvents();
    updateDocumentEditorUI();
    if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }

  function bindDocumentEditorEvents() {
    document.querySelector('#document-mode-button').addEventListener('click', async () => {
      if (editor.mode === 'read') await enterDocumentEditMode();
      else await commitDocumentEditsAndRead();
    });
    document.querySelector('#document-discard-button').addEventListener('click', discardDocumentEdits);
    document.querySelector('#document-undo').addEventListener('click', undoDocumentEdit);
    document.querySelector('#document-redo').addEventListener('click', redoDocumentEdit);
    document.querySelector('#document-select-tool').addEventListener('click', () => setDocumentTool('select'));
    document.querySelector('#document-add-text').addEventListener('click', addTextBox);
    document.querySelector('#document-add-equation').addEventListener('click', addOrEditEquation);
    document.querySelector('#document-add-image').addEventListener('click', () => document.querySelector('#document-image-input').click());
    document.querySelector('#document-image-input').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await addImageFile(file);
    });
    document.querySelector('#document-duplicate').addEventListener('click', duplicateSelectedObject);
    document.querySelector('#document-delete').addEventListener('click', deleteSelectedObject);

    document.querySelector('#document-font-family').addEventListener('change', (event) => applySelectedStyle({ fontFamily: event.target.value === 'original' ? null : event.target.value }));
    document.querySelector('#document-font-size').addEventListener('change', (event) => applySelectedStyle({ fontSize: clamp(Number(event.target.value) || 11, 4, 144) }));
    document.querySelector('#document-bold').addEventListener('click', () => toggleSelectedStyle('bold'));
    document.querySelector('#document-italic').addEventListener('click', () => toggleSelectedStyle('italic'));
    document.querySelector('#document-underline').addEventListener('click', () => toggleSelectedStyle('underline'));
    document.querySelector('#document-text-color').addEventListener('input', (event) => applySelectedStyle({ color: event.target.value }));
    document.querySelector('#document-align').addEventListener('change', (event) => applySelectedStyle({ align: event.target.value }));
    document.querySelector('#document-line-height').addEventListener('change', (event) => applySelectedStyle({ lineHeight: Number(event.target.value) || 1.15 }));

    const layer = document.querySelector('#document-text-layer');
    layer.addEventListener('pointerdown', handleLayerPointerDown);
    layer.addEventListener('pointermove', handleLayerPointerMove);
    layer.addEventListener('pointerup', handleLayerPointerUp);
    layer.addEventListener('pointercancel', handleLayerPointerUp);

    document.querySelector('#close-equation-modal').addEventListener('click', closeEquationModal);
    document.querySelector('#cancel-equation').addEventListener('click', closeEquationModal);
    document.querySelector('#save-equation').addEventListener('click', saveEquationFromModal);
    document.querySelector('#document-equation-modal').addEventListener('click', (event) => {
      if (event.target.id === 'document-equation-modal') closeEquationModal();
    });
    let equationPreviewTimer;
    document.querySelector('#document-equation-latex').addEventListener('input', () => {
      clearTimeout(equationPreviewTimer);
      equationPreviewTimer = setTimeout(updateEquationPreview, 180);
    });

    window.addEventListener('paste', handleEditorPaste);
    window.addEventListener('keydown', handleEditorKeyboard, true);
  }

  function updateDocumentEditorUI() {
    const button = document.querySelector('#document-mode-button');
    if (!button) return;
    const editing = editor.mode === 'edit';
    button.classList.toggle('primary', editing);
    button.classList.toggle('ghost', !editing);
    button.disabled = editor.committing;
    button.querySelector('#document-mode-label').textContent = editing ? 'Save & Read' : 'Edit PDF';
    document.querySelector('#document-discard-button').classList.toggle('hidden', !editing);
    document.querySelector('#document-edit-ribbon').classList.toggle('hidden', !editing);
    document.querySelector('#document-edit-hint').classList.toggle('hidden', !editing);
    document.body.classList.toggle('document-edit-mode', editing);

    const count = document.querySelector('#document-edit-count');
    const changes = currentDraftCount();
    count.textContent = changes ? `${changes} unsaved change${changes === 1 ? '' : 's'}` : 'No changes';
    document.querySelector('#document-undo').disabled = !editor.history.length;
    document.querySelector('#document-redo').disabled = !editor.future.length;
    document.querySelector('#document-select-tool').classList.toggle('active', editor.tool === 'select');
    document.querySelector('#document-add-equation').classList.toggle('active', editor.tool === 'equation');
    const instruction = document.querySelector('#document-edit-instruction');
    instruction.innerHTML = editor.tool === 'equation'
      ? '<i data-lucide="box-select"></i>Drag around an equation or area'
      : '<i data-lucide="mouse-pointer-click"></i>Double-click text to edit · paste images with Ctrl/Cmd+V';
    syncRibbonToSelection();
    if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }

  function setDocumentTool(tool) {
    finishActiveInlineEdit();
    editor.tool = tool;
    updateDocumentEditorUI();
  }

  async function ensureDocumentEditable(documentState) {
    if (!documentState) throw new Error('Open a PDF first.');
    if (!nativeEngine.available && !(await checkNativeEngine())) {
      throw new Error('Edit mode needs the local PDF engine. Install requirements and run npm start.');
    }
    const requiredCapabilities = ['layout', 'replace_text_region', 'place_asset'];
    const capabilities = nativeEngine.health?.capabilities || [];
    if (requiredCapabilities.some((capability) => !capabilities.includes(capability))) {
      throw new Error('Your local engine is outdated. Pull the latest code and restart npm start.');
    }
    const analysis = await analyzeDocumentNatively(documentState);
    if (analysis.signatures?.mutationWarning) {
      throw new Error('This PDF is signed. Editing would invalidate its signature, so document edit mode is disabled.');
    }
  }

  async function enterDocumentEditMode() {
    if (!activeDocument()) {
      flash('Open a PDF first');
      return;
    }
    try {
      setLoading(true, 'Preparing rich document edit mode…');
      await ensureDocumentEditable(activeDocument());
      editor.mode = 'edit';
      editor.tool = 'select';
      editor.history = [];
      editor.future = [];
      state.tool = 'select';
      state.selectedAnnotationId = null;
      updateDocumentEditorUI();
      updateUI();
      await renderDocumentEditLayer();
      flash('Edit mode ready: double-click text or paste an image');
    } catch (error) {
      flash(error.message);
    } finally {
      setLoading(false);
    }
  }

  function discardDocumentEdits() {
    finishActiveInlineEdit({ cancel: true });
    editor.changes.clear();
    editor.added.clear();
    editor.history = [];
    editor.future = [];
    editor.selectedId = null;
    editor.mode = 'read';
    editor.tool = 'select';
    updateDocumentEditorUI();
    renderDocumentEditLayer();
    flash('Unsaved document edits discarded');
  }

  async function fetchNativeLayout(documentState, pageState, force = false) {
    const key = layoutKey(documentState.id, pageState.sourceIndex);
    if (!force && editor.layoutCache.has(key)) return editor.layoutCache.get(key);
    const body = new FormData();
    body.append('file', new Blob([documentState.bytes], { type: 'application/pdf' }), documentState.name || 'document.pdf');
    body.append('page', String(pageState.sourceIndex));
    const response = await fetch('/api/pdf/layout', { method: 'POST', body });
    const payload = await response.json();
    if (!response.ok) throw new Error(engineErrorMessage(payload, 'Could not inspect the page layout.'));
    editor.layoutCache.set(key, payload);
    return payload;
  }

  function clearLayoutCacheForDocument(documentId) {
    for (const key of [...editor.layoutCache.keys()]) {
      if (key.startsWith(`${documentId}:`)) editor.layoutCache.delete(key);
    }
  }

  function layoutObjectToEditorObject(item, documentState, pageState) {
    const id = sourceObjectId(documentState.id, pageState.sourceIndex, item.id);
    const style = {
      fontName: item.style?.fontName || 'Helvetica',
      fontXref: item.style?.fontXref ?? null,
      fontFamily: null,
      fontSize: Number(item.style?.fontSize) || 11,
      color: item.style?.color || '#111318',
      bold: Boolean(item.style?.bold),
      italic: Boolean(item.style?.italic),
      underline: false,
      align: item.style?.align || 'left',
      lineHeight: Number(item.style?.lineHeight) || 1.15,
    };
    const object = {
      id,
      sourceId: item.id,
      kind: item.kind,
      docId: documentState.id,
      pageId: pageState.id,
      sourceIndex: pageState.sourceIndex,
      rect: [...item.rect],
      sourceRect: [...item.rect],
      text: item.text || '',
      latex: '',
      dataUrl: item.dataUrl || null,
      mime: item.mime || null,
      editable: item.editable !== false,
      style,
      direction: item.direction || [1, 0],
      rotation: Number(item.rotation) || 0,
      isNew: false,
      isAnnotation: false,
      deleted: false,
    };
    object.original = clone(relevantObjectState(object));
    return object;
  }

  function annotationToEditorObject(annotation, documentState, pageState, pageWidth, pageHeight) {
    const rect = [
      annotation.x * pageWidth,
      annotation.y * pageHeight,
      (annotation.x + (annotation.width || 0.25)) * pageWidth,
      (annotation.y + (annotation.height || 0.08)) * pageHeight,
    ];
    const object = {
      id: annotationObjectId(pageState.id, annotation.id),
      annotationId: annotation.id,
      kind: annotation.type,
      docId: documentState.id,
      pageId: pageState.id,
      sourceIndex: pageState.sourceIndex,
      rect,
      sourceRect: null,
      text: annotation.text || '',
      dataUrl: annotation.dataUrl || null,
      mime: annotation.dataUrl?.slice(5, annotation.dataUrl.indexOf(';')) || null,
      editable: true,
      style: {
        fontName: 'Helvetica', fontXref: null, fontFamily: 'Helvetica',
        fontSize: Number(annotation.size) || 18,
        color: annotation.color || '#111318', bold: false, italic: false,
        underline: false, align: 'left', lineHeight: 1.15,
      },
      rotation: 0,
      isNew: false,
      isAnnotation: true,
      deleted: false,
    };
    object.original = clone(relevantObjectState(object));
    return object;
  }

  function currentPageObjects(layout, documentState, pageState) {
    const base = layout.objects.map((item) => layoutObjectToEditorObject(item, documentState, pageState));
    for (const annotation of pageState.annotations.filter((item) => EDITABLE_ANNOTATIONS.has(item.type))) {
      base.push(annotationToEditorObject(annotation, documentState, pageState, layout.width, layout.height));
    }
    const merged = base.map((object) => clone(editor.changes.get(object.id) || object));
    for (const object of editor.added.values()) {
      if (object.pageId === pageState.id) merged.push(clone(object));
    }
    return merged.filter((object) => !object.deleted);
  }

  function pdfRectToScreen(rect) {
    const viewport = editor.currentViewport;
    const pageHeight = editor.currentPageHeight;
    if (!viewport) return { left: 0, top: 0, width: 1, height: 1 };
    const converted = viewport.convertToViewportRectangle([rect[0], pageHeight - rect[3], rect[2], pageHeight - rect[1]]);
    const left = Math.min(converted[0], converted[2]);
    const top = Math.min(converted[1], converted[3]);
    return {
      left,
      top,
      width: Math.max(4, Math.abs(converted[2] - converted[0])),
      height: Math.max(4, Math.abs(converted[3] - converted[1])),
    };
  }

  function eventToPdfPoint(event) {
    const stageRect = el.pageStage.getBoundingClientRect();
    const screenX = event.clientX - stageRect.left;
    const screenY = event.clientY - stageRect.top;
    const [pdfX, pdfY] = editor.currentViewport.convertToPdfPoint(screenX, screenY);
    return {
      x: clamp(pdfX, 0, editor.currentPageWidth),
      y: clamp(editor.currentPageHeight - pdfY, 0, editor.currentPageHeight),
    };
  }

  async function renderDocumentEditLayer() {
    const layer = document.querySelector('#document-text-layer');
    if (!layer) return;
    const token = ++editor.renderingToken;
    if (editor.mode !== 'edit') {
      layer.classList.add('hidden');
      layer.innerHTML = '';
      editor.currentObjects = [];
      return;
    }
    const pageState = activePage();
    const documentState = activeDocument();
    if (!pageState || !documentState) {
      layer.innerHTML = '';
      return;
    }
    layer.classList.remove('hidden');
    layer.innerHTML = '<div class="text-layer-loading">Mapping text, equations, and images…</div>';
    try {
      const [pdfPage, layout] = await Promise.all([
        documentState.pdfjs.getPage(pageState.sourceIndex + 1),
        fetchNativeLayout(documentState, pageState),
      ]);
      if (token !== editor.renderingToken || editor.mode !== 'edit') return;
      editor.currentViewport = pdfPage.getViewport({ scale: state.zoom, rotation: ((pdfPage.rotate || 0) + pageState.rotation) % 360 });
      editor.currentPageWidth = Number(layout.width) || 612;
      editor.currentPageHeight = Number(layout.height) || 792;
      editor.currentObjects = currentPageObjects(layout, documentState, pageState);
      layer.innerHTML = '';
      if (!editor.currentObjects.length) {
        layer.innerHTML = '<div class="document-edit-empty">No editable text or images were detected. Use Text, Equation, or Image to add new content.</div>';
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const object of editor.currentObjects) fragment.appendChild(createDocumentObjectElement(object));
      if (editor.interaction?.type === 'marquee') fragment.appendChild(createMarqueeElement(editor.interaction.rect));
      layer.appendChild(fragment);
      syncRibbonToSelection();
    } catch (error) {
      console.error(error);
      layer.innerHTML = `<div class="document-edit-empty danger-text">Could not build rich edit mode: ${escapeHtml(error.message)}</div>`;
    }
  }

  function createDocumentObjectElement(object) {
    const element = document.createElement('div');
    const screen = pdfRectToScreen(object.rect);
    const selected = object.id === editor.selectedId;
    const changed = object.isNew || editor.changes.has(object.id);
    element.className = `document-object kind-${object.kind}${selected ? ' selected' : ''}${changed ? ' changed' : ''}${object.isNew ? ' new-object' : ' source-object'}${object.isAnnotation ? ' annotation-object' : ''}`;
    element.dataset.objectId = object.id;
    element.style.left = `${screen.left}px`;
    element.style.top = `${screen.top}px`;
    element.style.width = `${screen.width}px`;
    element.style.height = `${screen.height}px`;

    const content = document.createElement('div');
    content.className = 'document-object-content';
    if (object.kind === 'text') {
      content.classList.add('document-text-content');
      content.textContent = object.text;
      content.style.fontFamily = cssFontFamily(object.style);
      content.style.fontSize = `${Math.max(4, object.style.fontSize * state.zoom)}px`;
      content.style.fontWeight = object.style.bold ? '700' : '400';
      content.style.fontStyle = object.style.italic ? 'italic' : 'normal';
      content.style.textDecoration = object.style.underline ? 'underline' : 'none';
      content.style.color = object.style.color;
      content.style.textAlign = object.style.align;
      content.style.lineHeight = String(object.style.lineHeight || 1.15);
    } else if (object.kind === 'image' || object.kind === 'equation') {
      if (object.dataUrl) {
        const image = document.createElement('img');
        image.src = object.dataUrl;
        image.alt = object.kind === 'equation' ? object.latex || 'Equation' : 'PDF image';
        image.draggable = false;
        content.appendChild(image);
      } else {
        content.innerHTML = '<span class="unavailable-object">Image preview unavailable</span>';
      }
    } else if (object.kind === 'math') {
      content.innerHTML = '<span class="math-object-badge"><i data-lucide="sigma"></i>Equation region</span>';
    }
    element.appendChild(content);

    if (selected) {
      const controls = document.createElement('div');
      controls.className = 'document-object-controls';
      controls.innerHTML = '<button class="object-move-handle" data-move="true" title="Move"><i data-lucide="grip"></i></button>' +
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => `<span class="object-resize-handle handle-${handle}" data-resize-handle="${handle}"></span>`).join('');
      element.appendChild(controls);
    }

    element.addEventListener('click', (event) => {
      event.stopPropagation();
      selectDocumentObject(object.id);
    });
    element.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (object.kind === 'text') beginInlineTextEdit(element, object.id);
      else if (object.kind === 'math' || object.kind === 'equation') openEquationModal(object);
    });
    if (window.lucide) queueMicrotask(() => lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }));
    return element;
  }

  function createMarqueeElement(rect) {
    const element = document.createElement('div');
    const screen = pdfRectToScreen(rect);
    element.className = 'document-region-marquee';
    element.style.left = `${screen.left}px`;
    element.style.top = `${screen.top}px`;
    element.style.width = `${screen.width}px`;
    element.style.height = `${screen.height}px`;
    return element;
  }

  function cssFontFamily(style) {
    if (style.fontFamily === 'Times') return 'Times New Roman, Times, serif';
    if (style.fontFamily === 'Courier') return 'Courier New, monospace';
    if (style.fontFamily === 'Helvetica') return 'Arial, Helvetica, sans-serif';
    const original = String(style.fontName || '').replace(/[,+]/g, ' ');
    return original ? `"${original}", Arial, sans-serif` : 'Arial, sans-serif';
  }

  function selectDocumentObject(id) {
    finishActiveInlineEdit();
    editor.selectedId = id;
    editor.tool = 'select';
    renderDocumentEditLayer();
    updateDocumentEditorUI();
  }

  function findCurrentObject(id = editor.selectedId) {
    return editor.currentObjects.find((object) => object.id === id) || editor.added.get(id) || editor.changes.get(id) || null;
  }

  function storeObject(object) {
    if (object.isNew) {
      editor.added.set(object.id, clone(object));
    } else if (objectMatchesOriginal(object)) {
      editor.changes.delete(object.id);
    } else {
      editor.changes.set(object.id, clone(object));
    }
    const index = editor.currentObjects.findIndex((item) => item.id === object.id);
    if (index >= 0) editor.currentObjects[index] = clone(object);
    updateDocumentEditorUI();
  }

  function syncRibbonToSelection() {
    const object = findCurrentObject();
    const textObject = object && object.kind === 'text';
    const controls = [
      '#document-font-family', '#document-font-size', '#document-bold', '#document-italic', '#document-underline',
      '#document-text-color', '#document-align', '#document-line-height',
    ];
    controls.forEach((selector) => { document.querySelector(selector).disabled = !textObject; });
    document.querySelector('#document-duplicate').disabled = !object;
    document.querySelector('#document-delete').disabled = !object;
    if (!textObject) return;
    document.querySelector('#document-font-family').value = object.style.fontFamily || 'original';
    document.querySelector('#document-font-size').value = String(Math.round(object.style.fontSize * 10) / 10);
    document.querySelector('#document-bold').classList.toggle('active', Boolean(object.style.bold));
    document.querySelector('#document-italic').classList.toggle('active', Boolean(object.style.italic));
    document.querySelector('#document-underline').classList.toggle('active', Boolean(object.style.underline));
    document.querySelector('#document-text-color').value = /^#[0-9a-f]{6}$/i.test(object.style.color || '') ? object.style.color : '#111318';
    document.querySelector('#document-align').value = object.style.align || 'left';
    document.querySelector('#document-line-height').value = String(object.style.lineHeight || 1.15);
  }

  function applySelectedStyle(changes) {
    const object = findCurrentObject();
    if (!object || object.kind !== 'text') return;
    pushEditHistory();
    object.style = { ...object.style, ...changes };
    storeObject(object);
    renderDocumentEditLayer();
  }

  function toggleSelectedStyle(property) {
    const object = findCurrentObject();
    if (!object || object.kind !== 'text') return;
    applySelectedStyle({ [property]: !object.style[property] });
  }

  function beginInlineTextEdit(element, objectId) {
    if (editor.mode !== 'edit') return;
    finishActiveInlineEdit();
    const object = findCurrentObject(objectId);
    if (!object || object.kind !== 'text') return;
    pushEditHistory();
    editor.activeEditableId = objectId;
    editor.activeBefore = clone(object);
    const content = element.querySelector('.document-text-content');
    element.classList.add('is-editing');
    content.contentEditable = 'true';
    content.spellcheck = true;
    content.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
    content.addEventListener('input', handleInlineTextInput);
    content.addEventListener('blur', () => finishActiveInlineEdit(), { once: true });
    content.addEventListener('keydown', handleInlineTextKeydown);
  }

  function handleInlineTextInput(event) {
    const object = findCurrentObject(editor.activeEditableId);
    if (!object) return;
    object.text = event.currentTarget.textContent ?? '';
    storeObject(object);
  }

  function handleInlineTextKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finishActiveInlineEdit({ cancel: true });
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      finishActiveInlineEdit();
    }
  }

  function finishActiveInlineEdit({ cancel = false } = {}) {
    if (!editor.activeEditableId) return;
    const element = document.querySelector(`[data-object-id="${CSS.escape(editor.activeEditableId)}"]`);
    const content = element?.querySelector('.document-text-content');
    if (content) {
      content.removeEventListener('input', handleInlineTextInput);
      content.removeEventListener('keydown', handleInlineTextKeydown);
      content.contentEditable = 'false';
      element.classList.remove('is-editing');
    }
    if (cancel && editor.activeBefore) storeObject(clone(editor.activeBefore));
    editor.activeEditableId = null;
    editor.activeBefore = null;
    renderDocumentEditLayer();
  }

  function defaultRect(width = 260, height = 72) {
    const pageWidth = editor.currentPageWidth || 612;
    const pageHeight = editor.currentPageHeight || 792;
    const actualWidth = Math.min(width, pageWidth - 72);
    const actualHeight = Math.min(height, pageHeight - 72);
    return [
      (pageWidth - actualWidth) / 2,
      (pageHeight - actualHeight) / 2,
      (pageWidth + actualWidth) / 2,
      (pageHeight + actualHeight) / 2,
    ];
  }

  function addTextBox() {
    if (editor.mode !== 'edit' || !activePage()) return;
    finishActiveInlineEdit();
    pushEditHistory();
    const pageState = activePage();
    const object = {
      id: newObjectId(), kind: 'text', docId: pageState.docId, pageId: pageState.id, sourceIndex: pageState.sourceIndex,
      rect: defaultRect(300, 84), sourceRect: null, text: 'Type here', dataUrl: null,
      style: { fontName: 'Helvetica', fontXref: null, fontFamily: 'Helvetica', fontSize: 12, color: '#111318', bold: false, italic: false, underline: false, align: 'left', lineHeight: 1.15 },
      rotation: 0, isNew: true, isAnnotation: false, deleted: false,
    };
    editor.added.set(object.id, clone(object));
    editor.selectedId = object.id;
    editor.tool = 'select';
    renderDocumentEditLayer().then(() => {
      const element = document.querySelector(`[data-object-id="${CSS.escape(object.id)}"]`);
      if (element) beginInlineTextEdit(element, object.id);
    });
    updateDocumentEditorUI();
  }

  async function addImageFile(file) {
    if (editor.mode !== 'edit' || !activePage()) return;
    if (!/^image\//.test(file.type)) {
      flash('Choose an image file');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    await addImageDataUrl(dataUrl, file.type);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read the image.'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  function imageDimensions(dataUrl) {
    return new Promise((resolve) => {
      if (dataUrl.startsWith('data:image/svg+xml')) {
        resolve({ width: 800, height: 300 });
        return;
      }
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth || 800, height: image.naturalHeight || 600 });
      image.onerror = () => resolve({ width: 800, height: 600 });
      image.src = dataUrl;
    });
  }

  async function addImageDataUrl(dataUrl, mime = 'image/png') {
    const dimensions = await imageDimensions(dataUrl);
    const pageState = activePage();
    if (!pageState) return;
    const pageWidth = editor.currentPageWidth || 612;
    const maxWidth = Math.min(280, pageWidth * 0.42);
    const width = Math.max(60, maxWidth);
    const height = Math.max(40, width / Math.max(0.1, dimensions.width / dimensions.height));
    pushEditHistory();
    const object = {
      id: newObjectId(), kind: 'image', docId: pageState.docId, pageId: pageState.id, sourceIndex: pageState.sourceIndex,
      rect: defaultRect(width, height), sourceRect: null, text: '', dataUrl, mime,
      editable: true, rotation: 0, isNew: true, isAnnotation: false, deleted: false,
      style: {},
    };
    editor.added.set(object.id, clone(object));
    editor.selectedId = object.id;
    editor.tool = 'select';
    await renderDocumentEditLayer();
    updateDocumentEditorUI();
    flash('Image added. Drag the centre handle to move it and any edge handle to resize.');
  }

  async function handleEditorPaste(event) {
    if (editor.mode !== 'edit') return;
    const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault();
    const file = item.getAsFile();
    if (file) await addImageFile(file);
  }

  function duplicateSelectedObject() {
    const object = findCurrentObject();
    if (!object) return;
    pushEditHistory();
    const copy = clone(object);
    copy.id = newObjectId();
    copy.isNew = true;
    copy.isAnnotation = false;
    copy.annotationId = null;
    copy.sourceRect = null;
    copy.deleted = false;
    const dx = Math.min(18, Math.max(0, editor.currentPageWidth - copy.rect[2]));
    const dy = Math.min(18, Math.max(0, editor.currentPageHeight - copy.rect[3]));
    copy.rect = [copy.rect[0] + dx, copy.rect[1] + dy, copy.rect[2] + dx, copy.rect[3] + dy];
    delete copy.original;
    editor.added.set(copy.id, copy);
    editor.selectedId = copy.id;
    renderDocumentEditLayer();
    updateDocumentEditorUI();
  }

  function deleteSelectedObject() {
    const object = findCurrentObject();
    if (!object) return;
    pushEditHistory();
    if (object.isNew) editor.added.delete(object.id);
    else {
      object.deleted = true;
      editor.changes.set(object.id, clone(object));
    }
    editor.selectedId = null;
    renderDocumentEditLayer();
    updateDocumentEditorUI();
  }

  function handleLayerPointerDown(event) {
    if (editor.mode !== 'edit' || !editor.currentViewport) return;
    const handle = event.target.closest?.('[data-resize-handle]');
    const moveHandle = event.target.closest?.('[data-move]');
    if (handle || moveHandle) {
      const objectElement = event.target.closest('[data-object-id]');
      const object = findCurrentObject(objectElement?.dataset.objectId);
      if (!object || (object.kind === 'image' && object.editable === false)) return;
      event.preventDefault();
      event.stopPropagation();
      pushEditHistory();
      editor.interaction = {
        type: handle ? 'resize' : 'move',
        handle: handle?.dataset.resizeHandle || null,
        objectId: object.id,
        start: eventToPdfPoint(event),
        originalRect: [...object.rect],
        aspect: Math.max(0.01, (object.rect[2] - object.rect[0]) / (object.rect[3] - object.rect[1])),
        lockAspect: ['image', 'equation'].includes(object.kind),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.target.closest?.('[data-object-id]')) return;
    const point = eventToPdfPoint(event);
    if (editor.tool === 'equation') {
      editor.interaction = { type: 'marquee', start: point, rect: [point.x, point.y, point.x, point.y] };
      event.currentTarget.setPointerCapture(event.pointerId);
      renderDocumentEditLayer();
      return;
    }
    editor.selectedId = null;
    renderDocumentEditLayer();
    updateDocumentEditorUI();
  }

  function updateRenderedObjectRect(object) {
    const element = document.querySelector(`[data-object-id="${CSS.escape(object.id)}"]`);
    if (!element) return;
    const screen = pdfRectToScreen(object.rect);
    element.style.left = `${screen.left}px`;
    element.style.top = `${screen.top}px`;
    element.style.width = `${screen.width}px`;
    element.style.height = `${screen.height}px`;
  }

  function updateRenderedMarquee(rect) {
    let element = document.querySelector('.document-region-marquee');
    if (!element) {
      element = createMarqueeElement(rect);
      document.querySelector('#document-text-layer').appendChild(element);
    }
    const screen = pdfRectToScreen(rect);
    element.style.left = `${screen.left}px`;
    element.style.top = `${screen.top}px`;
    element.style.width = `${screen.width}px`;
    element.style.height = `${screen.height}px`;
  }

  function handleLayerPointerMove(event) {
    const interaction = editor.interaction;
    if (!interaction || !editor.currentViewport) return;
    const point = eventToPdfPoint(event);
    if (interaction.type === 'marquee') {
      interaction.rect = [
        Math.min(interaction.start.x, point.x), Math.min(interaction.start.y, point.y),
        Math.max(interaction.start.x, point.x), Math.max(interaction.start.y, point.y),
      ];
      updateRenderedMarquee(interaction.rect);
      return;
    }
    const object = findCurrentObject(interaction.objectId);
    if (!object) return;
    if (interaction.type === 'move') {
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      const width = interaction.originalRect[2] - interaction.originalRect[0];
      const height = interaction.originalRect[3] - interaction.originalRect[1];
      const x0 = clamp(interaction.originalRect[0] + dx, 0, editor.currentPageWidth - width);
      const y0 = clamp(interaction.originalRect[1] + dy, 0, editor.currentPageHeight - height);
      object.rect = [x0, y0, x0 + width, y0 + height];
    } else {
      object.rect = resizedRect(interaction, point, event.shiftKey);
    }
    storeObject(object);
    updateRenderedObjectRect(object);
  }

  function resizedRect(interaction, point, shiftKey) {
    let [x0, y0, x1, y1] = interaction.originalRect;
    const handle = interaction.handle;
    if (handle.includes('w')) x0 = point.x;
    if (handle.includes('e')) x1 = point.x;
    if (handle.includes('n')) y0 = point.y;
    if (handle.includes('s')) y1 = point.y;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const minWidth = 8;
    const minHeight = 8;
    if (x1 - x0 < minWidth) x1 = x0 + minWidth;
    if (y1 - y0 < minHeight) y1 = y0 + minHeight;
    if (interaction.lockAspect && !shiftKey && /^(nw|ne|se|sw)$/.test(handle)) {
      const width = x1 - x0;
      const height = y1 - y0;
      if (width / height > interaction.aspect) {
        const desiredHeight = width / interaction.aspect;
        if (handle.includes('n')) y0 = y1 - desiredHeight; else y1 = y0 + desiredHeight;
      } else {
        const desiredWidth = height * interaction.aspect;
        if (handle.includes('w')) x0 = x1 - desiredWidth; else x1 = x0 + desiredWidth;
      }
    }
    return [
      clamp(x0, 0, editor.currentPageWidth - minWidth),
      clamp(y0, 0, editor.currentPageHeight - minHeight),
      clamp(x1, minWidth, editor.currentPageWidth),
      clamp(y1, minHeight, editor.currentPageHeight),
    ];
  }

  function handleLayerPointerUp(event) {
    const interaction = editor.interaction;
    if (!interaction) return;
    editor.interaction = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (_) { /* no-op */ }
    if (interaction.type === 'marquee') {
      const width = interaction.rect[2] - interaction.rect[0];
      const height = interaction.rect[3] - interaction.rect[1];
      const rect = width >= 8 && height >= 8 ? interaction.rect : defaultRect(220, 70);
      openEquationModal(null, rect);
    }
    renderDocumentEditLayer();
  }

  function addOrEditEquation() {
    const object = findCurrentObject();
    if (object && ['text', 'math', 'equation'].includes(object.kind)) {
      openEquationModal(object);
      return;
    }
    setDocumentTool('equation');
    flash('Drag around the equation or area you want to insert');
  }

  function openEquationModal(object = null, rect = null) {
    if (editor.mode !== 'edit') return;
    finishActiveInlineEdit();
    editor.equationTarget = { object: object ? clone(object) : null, rect: rect ? [...rect] : object ? [...object.rect] : defaultRect(240, 80) };
    const modal = document.querySelector('#document-equation-modal');
    const input = document.querySelector('#document-equation-latex');
    input.value = object?.latex || (object?.kind === 'math' ? object.text : '') || '';
    modal.classList.remove('hidden');
    input.focus();
    updateEquationPreview();
  }

  function closeEquationModal() {
    document.querySelector('#document-equation-modal').classList.add('hidden');
    editor.equationTarget = null;
    if (editor.tool === 'equation') setDocumentTool('select');
  }

  async function ensureMathJax() {
    if (window.MathJax?.tex2svgPromise || window.MathJax?.tex2svg) return window.MathJax;
    if (editor.mathJaxPromise) return editor.mathJaxPromise;
    editor.mathJaxPromise = new Promise((resolve, reject) => {
      window.MathJax = {
        tex: { packages: { '[+]': ['ams'] } },
        svg: { fontCache: 'none' },
        startup: { typeset: false },
      };
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';
      script.async = true;
      script.onload = async () => {
        try {
          if (window.MathJax.startup?.promise) await window.MathJax.startup.promise;
          resolve(window.MathJax);
        } catch (error) { reject(error); }
      };
      script.onerror = () => reject(new Error('Could not load the equation renderer. Check your internet connection.'));
      document.head.appendChild(script);
    });
    return editor.mathJaxPromise;
  }

  async function latexToSvgDataUrl(latex) {
    const mathJax = await ensureMathJax();
    const wrapper = mathJax.tex2svgPromise ? await mathJax.tex2svgPromise(latex || '\\square', { display: true }) : mathJax.tex2svg(latex || '\\square', { display: true });
    const svg = wrapper.querySelector('svg');
    if (!svg) throw new Error('The equation renderer did not produce SVG.');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.removeAttribute('style');
    const serialized = new XMLSerializer().serializeToString(svg);
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(serialized)))}`;
  }

  async function updateEquationPreview() {
    const preview = document.querySelector('#document-equation-preview');
    const latex = document.querySelector('#document-equation-latex').value.trim();
    preview.innerHTML = '<span>Rendering…</span>';
    try {
      const dataUrl = await latexToSvgDataUrl(latex || '\\square');
      preview.innerHTML = `<img src="${dataUrl}" alt="Equation preview" />`;
    } catch (error) {
      preview.innerHTML = `<span class="danger-text">${escapeHtml(error.message)}</span>`;
    }
  }

  async function saveEquationFromModal() {
    const latex = document.querySelector('#document-equation-latex').value.trim();
    if (!latex) {
      flash('Enter a LaTeX equation');
      return;
    }
    const target = editor.equationTarget;
    if (!target) return;
    const saveButton = document.querySelector('#save-equation');
    saveButton.disabled = true;
    try {
      const dataUrl = await latexToSvgDataUrl(latex);
      pushEditHistory();
      if (target.object) {
        const object = findCurrentObject(target.object.id) || target.object;
        object.kind = 'equation';
        object.latex = latex;
        object.dataUrl = dataUrl;
        object.mime = 'image/svg+xml';
        object.rect = [...target.rect];
        object.editable = true;
        storeObject(object);
        editor.selectedId = object.id;
      } else {
        const pageState = activePage();
        const object = {
          id: newObjectId(), kind: 'equation', docId: pageState.docId, pageId: pageState.id, sourceIndex: pageState.sourceIndex,
          rect: [...target.rect], sourceRect: null, text: '', latex, dataUrl, mime: 'image/svg+xml', editable: true,
          style: {}, rotation: 0, isNew: true, isAnnotation: false, deleted: false,
        };
        editor.added.set(object.id, object);
        editor.selectedId = object.id;
      }
      closeEquationModal();
      await renderDocumentEditLayer();
      updateDocumentEditorUI();
    } catch (error) {
      flash(error.message);
    } finally {
      saveButton.disabled = false;
    }
  }

  function handleEditorKeyboard(event) {
    if (editor.mode !== 'edit') return;
    const modifier = event.ctrlKey || event.metaKey;
    const typing = event.target.closest?.('[contenteditable="true"],input,textarea,select');
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      commitDocumentEditsAndRead();
      return;
    }
    if (!typing && modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redoDocumentEdit() : undoDocumentEdit();
      return;
    }
    if (!typing && modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redoDocumentEdit();
      return;
    }
    if (!typing && modifier && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelectedObject();
      return;
    }
    if (!typing && (event.key === 'Delete' || event.key === 'Backspace') && editor.selectedId) {
      event.preventDefault();
      deleteSelectedObject();
      return;
    }
    if (event.key === 'Escape') {
      if (editor.activeEditableId) finishActiveInlineEdit({ cancel: true });
      else if (!document.querySelector('#document-equation-modal').classList.contains('hidden')) closeEquationModal();
      else {
        editor.tool = 'select';
        editor.selectedId = null;
        renderDocumentEditLayer();
        updateDocumentEditorUI();
      }
    }
  }

  function styleOperation(object) {
    const originalStyle = object.original?.style || {};
    const unchangedWeight = object.style.bold === originalStyle.bold && object.style.italic === originalStyle.italic;
    const preserveOriginalFont = !object.style.fontFamily && unchangedWeight && Boolean(object.style.fontXref);
    const operation = {
      fontSize: object.style.fontSize,
      color: object.style.color,
      align: object.style.align,
      lineHeight: object.style.lineHeight,
      underline: Boolean(object.style.underline),
      minimumFontSize: 4,
      fitMode: 'reflow',
      preserveOriginalFont,
      rotation: Number(object.rotation) || 0,
    };
    if (preserveOriginalFont) operation.fontXref = object.style.fontXref;
    else {
      operation.fontFamily = object.style.fontFamily || object.style.fontName || 'Helvetica';
      operation.bold = Boolean(object.style.bold);
      operation.italic = Boolean(object.style.italic);
    }
    return operation;
  }

  function operationForObject(object) {
    if (object.isAnnotation) {
      if (object.deleted) return null;
      if (object.kind === 'text') return { type: 'add_text_box', page: object.sourceIndex, rect: object.rect, text: object.text, ...styleOperation(object) };
      if (object.kind === 'image') return { type: 'place_asset', page: object.sourceIndex, targetRect: object.rect, dataUrl: object.dataUrl, mime: object.mime, keepProportion: false, rotation: Number(object.rotation) || 0 };
    }
    if (object.deleted) {
      return {
        type: 'delete_region', page: object.sourceIndex, sourceRect: object.sourceRect || object.rect,
        removeText: ['text', 'math'].includes(object.kind), removeImages: object.kind === 'image', removeGraphics: object.kind === 'equation',
      };
    }
    if (object.kind === 'text') {
      if (object.isNew) return { type: 'add_text_box', page: object.sourceIndex, rect: object.rect, text: object.text, ...styleOperation(object) };
      return {
        type: 'replace_text_region', page: object.sourceIndex,
        sourceRect: object.sourceRect, targetRect: object.rect,
        originalText: object.original?.text || '', replacement: object.text,
        ...styleOperation(object), redactionColor: 'transparent',
      };
    }
    if (object.kind === 'image' || object.kind === 'equation') {
      return {
        type: 'place_asset', page: object.sourceIndex,
        sourceRect: object.isNew || object.isAnnotation ? undefined : object.sourceRect,
        targetRect: object.rect, dataUrl: object.dataUrl, mime: object.mime || (object.kind === 'equation' ? 'image/svg+xml' : 'image/png'),
        keepProportion: false, rotation: Number(object.rotation) || 0,
        removeImages: object.kind === 'image', removeText: object.kind === 'equation', removeGraphics: object.kind === 'equation',
      };
    }
    if (object.kind === 'math' && editor.changes.has(object.id)) {
      return { type: 'delete_region', page: object.sourceIndex, sourceRect: object.sourceRect, removeText: true, removeGraphics: true, removeImages: false };
    }
    return null;
  }

  async function replaceSourceDocumentBytesFlexible(documentState, bytes) {
    const previousCount = documentState.pdfjs.numPages;
    const nextPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    documentState.bytes = bytes;
    documentState.size = bytes.byteLength;
    documentState.pdfjs = nextPdf;
    documentState.textCache = {};
    nativeEngine.analysisByDocument.delete(documentState.id);
    clearLayoutCacheForDocument(documentState.id);

    if (nextPdf.numPages > previousCount) {
      let insertionIndex = state.pages.reduce((last, page, index) => page.docId === documentState.id ? index : last, -1) + 1;
      for (let sourceIndex = previousCount; sourceIndex < nextPdf.numPages; sourceIndex += 1) {
        state.pages.splice(insertionIndex, 0, { id: uid('page'), docId: documentState.id, sourceIndex, rotation: 0, annotations: [] });
        insertionIndex += 1;
      }
    } else if (nextPdf.numPages < previousCount) {
      throw new Error('The native edit unexpectedly removed source pages.');
    }
    await refreshWorkspace();
  }

  async function performRichDocumentOperations(documentState, operations) {
    if (!documentState) throw new Error('The source PDF is no longer available.');
    if (!operations.length) return null;
    if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('The native PDF engine is offline.');
    const body = new FormData();
    body.append('file', new Blob([documentState.bytes], { type: 'application/pdf' }), documentState.name || 'document.pdf');
    body.append('operations', new Blob([JSON.stringify({ operations })], { type: 'application/json' }), 'operations.json');
    const response = await fetch('/api/pdf/edit', { method: 'POST', body });
    const payload = await response.json();
    if (!response.ok) throw new Error(engineErrorMessage(payload));
    const bytes = bytesToBase64Bytes(payload.pdfBase64);
    const backups = nativeEngine.backupsByDocument.get(documentState.id) || [];
    backups.push(documentState.bytes.slice());
    nativeEngine.backupsByDocument.set(documentState.id, backups.slice(-10));
    await replaceSourceDocumentBytesFlexible(documentState, bytes);
    return payload.report;
  }

  async function commitDocumentEditsAndRead() {
    if (editor.committing) return;
    finishActiveInlineEdit();
    if (!currentDraftCount()) {
      editor.mode = 'read';
      editor.selectedId = null;
      updateDocumentEditorUI();
      await renderDocumentEditLayer();
      return;
    }
    editor.committing = true;
    updateDocumentEditorUI();
    setLoading(true, 'Writing text, equations, and images into the PDF…');

    const objects = [...editor.changes.values(), ...editor.added.values()];
    const grouped = new Map();
    const annotationRemovals = [];
    for (const object of objects) {
      if (!grouped.has(object.docId)) grouped.set(object.docId, []);
      const operation = operationForObject(object);
      if (operation) grouped.get(object.docId).push(operation);
      if (object.isAnnotation) annotationRemovals.push({ pageId: object.pageId, annotationId: object.annotationId });
    }

    try {
      for (const [documentId, operations] of grouped) {
        if (!operations.length) continue;
        await performRichDocumentOperations(state.documents.get(documentId), operations);
      }
      for (const removal of annotationRemovals) {
        const page = state.pages.find((item) => item.id === removal.pageId);
        if (page) page.annotations = page.annotations.filter((annotation) => annotation.id !== removal.annotationId);
      }
      editor.changes.clear();
      editor.added.clear();
      editor.history = [];
      editor.future = [];
      editor.selectedId = null;
      editor.mode = 'read';
      editor.tool = 'select';
      await refreshWorkspace();
      await renderDocumentEditLayer();
      updateDocumentEditorUI();
      flash('Document saved and returned to read mode');
    } catch (error) {
      editor.mode = 'edit';
      await renderDocumentEditLayer();
      flash(`Could not save document edits: ${error.message}`);
    } finally {
      editor.committing = false;
      setLoading(false);
      updateDocumentEditorUI();
    }
  }

  async function normalizedRectForPage(pageState, args) {
    const documentState = state.documents.get(pageState.docId);
    const page = await documentState.pdfjs.getPage(pageState.sourceIndex + 1);
    const view = page.view || [0, 0, 612, 792];
    const width = view[2] - view[0];
    const height = view[3] - view[1];
    const x = clamp(Number(args.x) || 0.1, 0, 0.98);
    const y = clamp(Number(args.y) || 0.1, 0, 0.98);
    const w = clamp(Number(args.width) || 0.35, 0.02, 1 - x);
    const h = clamp(Number(args.height) || 0.08, 0.02, 1 - y);
    return [x * width, y * height, (x + w) * width, (y + h) * height];
  }

  async function findAnswerPlacement(pageState, afterText, textLength = 500) {
    const documentState = state.documents.get(pageState.docId);
    const layout = await fetchNativeLayout(documentState, pageState);
    const margin = Math.max(30, layout.width * 0.08);
    const targetWidth = layout.width - margin * 2;
    const estimatedLines = Math.max(4, Math.ceil(textLength / Math.max(45, targetWidth / 5.5)));
    const targetHeight = Math.min(layout.height * 0.42, Math.max(80, estimatedLines * 14));
    const occupied = layout.objects.map((object) => object.rect).sort((a, b) => a[1] - b[1]);
    let startY = margin;
    if (afterText) {
      const query = String(afterText).toLowerCase();
      const anchor = layout.objects.find((object) => object.text && object.text.toLowerCase().includes(query));
      if (anchor) startY = anchor.rect[3] + 12;
    }
    let y = startY;
    while (y + targetHeight <= layout.height - margin) {
      const candidate = [margin, y, margin + targetWidth, y + targetHeight];
      const collision = occupied.find((rect) => rect[2] > candidate[0] && rect[0] < candidate[2] && rect[3] > candidate[1] && rect[1] < candidate[3]);
      if (!collision) return { layout, rect: candidate };
      y = Math.max(y + 8, collision[3] + 10);
    }
    return { layout, rect: null };
  }

  function nativeToolSchemas() {
    return [
      {
        type: 'function',
        function: {
          name: 'edit_text',
          description: 'Change existing words in the PDF while preserving the nearby font and size. Use this only for corrections or short rewrites, never to overwrite a question with its answer.',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 }, search: { type: 'string' }, replacement: { type: 'string' },
              occurrence: { anyOf: [{ type: 'string', enum: ['first', 'all'] }, { type: 'integer', minimum: 0 }] },
            },
            required: ['page', 'search', 'replacement'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'insert_answer',
          description: 'Add an answer, explanation, or solution to available space without deleting the original question. If the page has no space, Lumina adds a new page.',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 }, after_text: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' },
            },
            required: ['page', 'text'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'add_native_text',
          description: 'Insert a text box at a specific normalized page rectangle.',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 }, x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
              width: { type: 'number', minimum: 0.02, maximum: 1 }, height: { type: 'number', minimum: 0.02, maximum: 1 },
              text: { type: 'string' }, size: { type: 'number', minimum: 4, maximum: 96 }, color: { type: 'string' },
            },
            required: ['page', 'x', 'y', 'width', 'height', 'text'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'insert_equation',
          description: 'Insert a LaTeX equation as scalable vector content.',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 }, latex: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, after_text: { type: 'string' },
            },
            required: ['page', 'latex'],
          },
        },
      },
    ];
  }

  function parseToolCalls(message) {
    const actions = [];
    for (const call of message?.tool_calls || []) {
      const name = call?.function?.name;
      if (!name) continue;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { args = {}; }
      actions.push({ tool: name, args });
    }
    return actions;
  }

  function normalizeAIAction(action) {
    if (!action || typeof action.tool !== 'string') return action;
    const args = { ...(action.args || {}) };
    if (args.afterText !== undefined && args.after_text === undefined) args.after_text = args.afterText;
    if (args.font_size !== undefined && args.size === undefined) args.size = args.font_size;
    let tool = action.tool;
    if (tool === 'replace_text') tool = 'edit_text';
    if (tool === 'add_answer') tool = 'insert_answer';
    return { tool, args };
  }

  function deduplicateActions(actions) {
    const unique = new Map();
    for (const action of actions) {
      const key = `${action.tool}:${JSON.stringify(action.args || {})}`;
      if (!unique.has(key)) unique.set(key, action);
    }
    return [...unique.values()];
  }

  const basePermissionForTool = permissionForTool;
  permissionForTool = function enhancedPermissionForTool(tool) {
    if (NATIVE_AI_TOOLS.has(tool) || ['replace_text', 'add_answer'].includes(tool)) return 'add_content';
    return basePermissionForTool(tool);
  };

  aiSystemPrompt = function enhancedAISystemPrompt() {
    return `You are Lumina's document assistant. Page numbers are 1-based. Use edit_text only for correcting or briefly rewriting existing source words. Preserve questions and instructions. When the user asks to add a solution, answer, explanation, or your previous response to the PDF, use insert_answer so Lumina places it in blank space or on a new page. Use insert_equation for LaTeX mathematics and add_native_text only for an explicitly positioned text box. Never claim an edit happened before approval. Other Lumina actions are add_highlight, add_comment, add_rectangle, rotate_page, duplicate_page, move_page, delete_page, and export_pdf. If tool calls are unavailable, return valid JSON only: {"message":"helpful response","actions":[{"tool":"insert_answer","args":{"page":1,"after_text":"Question 1","text":"Solution…"}}]}.`;
  };

  sendAIMessage = async function enhancedSendAIMessage() {
    const prompt = el.aiPrompt.value.trim();
    if (!prompt) return;
    if (!aiConfig.baseUrl || !aiConfig.model) {
      openAIModal();
      return;
    }
    const previousAssistant = [...state.aiConversation].reverse().find((message) => message.role === 'assistant')?.content || '';
    addAIMessage('user', prompt);
    el.aiPrompt.value = '';
    document.querySelector('#send-ai').disabled = true;
    const placeholder = document.createElement('div');
    placeholder.className = 'ai-message assistant';
    placeholder.textContent = 'Thinking…';
    el.aiChat.appendChild(placeholder);
    try {
      const context = state.aiUseDocument && aiConfig.permissions.read_document ? await documentContext(36000) : '';
      const messages = [
        { role: 'system', content: aiSystemPrompt() },
        ...state.aiConversation.slice(0, -1).slice(-10).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
        { role: 'user', content: context ? `${prompt}\n\nDocument context:\n${context}` : prompt },
      ];
      const headers = { 'Content-Type': 'application/json' };
      const key = sessionStorage.getItem('lumina-ai-key');
      if (key) headers.Authorization = `Bearer ${key}`;
      if (aiConfig.provider === 'openrouter') {
        headers['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin;
        headers['X-OpenRouter-Title'] = 'Lumina PDF Studio';
      }
      const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const baseBody = { model: aiConfig.model, messages, temperature: 0.12 };
      let response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...baseBody, tools: nativeToolSchemas(), tool_choice: 'auto' }) });
      if (!response.ok && [400, 404, 422].includes(response.status)) {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(baseBody) });
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${response.status}: ${body.slice(0, 240)}`);
      }
      const data = await response.json();
      const message = data.choices?.[0]?.message || data.message || {};
      const content = message.content ?? data.output_text ?? '';
      const parsed = parseAIResponse(content);
      let actions = deduplicateActions([...parseToolCalls(message), ...parsed.actions].map(normalizeAIAction));
      if (!actions.length && /\b(add|put|insert|paste)\b[\s\S]*\b(it|this|that|answer|solution)\b[\s\S]*\b(doc|document|pdf)\b/i.test(prompt) && previousAssistant) {
        actions = [{ tool: 'insert_answer', args: { page: state.activePageIndex + 1, text: previousAssistant } }];
      }
      placeholder.remove();
      addAIMessage('assistant', parsed.message || (actions.length ? 'I prepared document edits for review.' : String(content || 'Done.')));
      state.pendingAIActions = filterAIActions(actions);
      const blocked = actions.length - state.pendingAIActions.length;
      if (blocked > 0) addAIMessage('assistant', `${blocked} proposed action${blocked === 1 ? ' was' : 's were'} blocked by permissions or an unsupported tool.`);
      renderActionQueue();
    } catch (error) {
      placeholder.className = 'ai-message error';
      placeholder.textContent = `AI request failed: ${error.message}`;
    } finally {
      document.querySelector('#send-ai').disabled = false;
    }
  };

  const baseExecutePendingAIActions = executePendingAIActions;
  executePendingAIActions = async function enhancedExecutePendingAIActions() {
    if (!state.pendingAIActions.length) return;
    const all = state.pendingAIActions.map(normalizeAIAction);
    const nativeActions = all.filter((action) => NATIVE_AI_TOOLS.has(action.tool));
    const otherActions = all.filter((action) => !NATIVE_AI_TOOLS.has(action.tool));
    state.pendingAIActions = otherActions;
    let applied = 0;
    const failures = [];

    if (nativeActions.length) {
      setLoading(true, 'Applying AI edits to the source PDF…');
      try {
        if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('The local PDF engine is offline. Run npm start, not npm run start:static.');
        const groups = new Map();
        for (const action of nativeActions) {
          const args = action.args || {};
          const index = pageFromNumber(args.page);
          const pageState = state.pages[index];
          if (!pageState) {
            failures.push(`${action.tool}: page ${args.page} was not found.`);
            continue;
          }
          const documentState = state.documents.get(pageState.docId);
          if (!groups.has(documentState.id)) groups.set(documentState.id, { documentState, operations: [] });
          const operations = groups.get(documentState.id).operations;

          if (action.tool === 'edit_text') {
            if (!String(args.search || '').trim()) {
              failures.push(`edit_text on page ${index + 1}: the model did not include exact source text.`);
              continue;
            }
            operations.push({
              type: 'replace_text', search: String(args.search), replacement: String(args.replacement ?? ''),
              pages: [pageState.sourceIndex], occurrence: args.occurrence ?? 'first', requireMatch: true,
              fitMode: 'expand', preserveOriginalFont: true, redactionColor: 'transparent', minimumFontSize: 4,
            });
          } else if (action.tool === 'add_native_text') {
            operations.push({
              type: 'add_text_box', page: pageState.sourceIndex, rect: await normalizedRectForPage(pageState, args),
              text: String(args.text || ''), fontFamily: 'Helvetica', fontSize: clamp(Number(args.size) || 11, 4, 96),
              color: /^#[0-9a-f]{6}$/i.test(args.color || '') ? args.color : '#111318', lineHeight: 1.2, fitMode: 'reflow', minimumFontSize: 5,
            });
          } else if (action.tool === 'insert_answer') {
            const text = String(args.text || '').trim();
            if (!text) {
              failures.push(`insert_answer on page ${index + 1}: no answer text was provided.`);
              continue;
            }
            const placement = await findAnswerPlacement(pageState, args.after_text, text.length);
            if (placement.rect) {
              operations.push({
                type: 'add_text_box', page: pageState.sourceIndex, rect: placement.rect,
                text: args.title ? `${args.title}\n${text}` : text,
                fontFamily: 'Helvetica', fontSize: 10.5, color: '#111318', lineHeight: 1.25,
                fitMode: 'reflow', minimumFontSize: 6,
              });
            } else {
              operations.push({
                type: 'append_text_page', title: String(args.title || 'Solution'), text,
                fontFamily: 'Helvetica', fontSize: 11, lineHeight: 1.25,
                width: placement.layout.width, height: placement.layout.height,
              });
            }
          } else if (action.tool === 'insert_equation') {
            const latex = String(args.latex || '').trim();
            if (!latex) {
              failures.push(`insert_equation on page ${index + 1}: no LaTeX was provided.`);
              continue;
            }
            let rect;
            if ([args.x, args.y, args.width, args.height].every((value) => Number.isFinite(Number(value)))) rect = await normalizedRectForPage(pageState, args);
            else {
              const placement = await findAnswerPlacement(pageState, args.after_text, 100);
              rect = placement.rect ? [placement.rect[0], placement.rect[1], placement.rect[0] + Math.min(320, placement.rect[2] - placement.rect[0]), placement.rect[1] + 72] : [54, placement.layout.height - 150, placement.layout.width - 54, placement.layout.height - 70];
            }
            operations.push({ type: 'place_asset', page: pageState.sourceIndex, targetRect: rect, dataUrl: await latexToSvgDataUrl(latex), mime: 'image/svg+xml', keepProportion: true });
          }
        }
        for (const { documentState, operations } of groups.values()) {
          if (!operations.length) continue;
          const report = await performRichDocumentOperations(documentState, operations);
          applied += report?.operations?.length || operations.length;
        }
      } catch (error) {
        failures.push(error.message);
      } finally {
        setLoading(false);
      }
    }

    if (otherActions.length) {
      state.pendingAIActions = otherActions;
      await baseExecutePendingAIActions();
      applied += otherActions.length;
    } else {
      state.pendingAIActions = [];
      renderActionQueue();
    }
    if (applied) addAIMessage('assistant', `${applied} approved edit${applied === 1 ? '' : 's'} applied to the PDF.`);
    if (failures.length) addAIMessage('assistant', `Some edits could not be applied:\n${failures.map((item) => `• ${item}`).join('\n')}`);
  };

  const baseRenderCurrentPage = renderCurrentPage;
  renderCurrentPage = async function renderCurrentPageWithRichEditor() {
    await baseRenderCurrentPage();
    await renderDocumentEditLayer();
  };

  const baseReplaceSourceDocumentBytes = replaceSourceDocumentBytes;
  replaceSourceDocumentBytes = async function replaceSourceDocumentBytesWithLayoutInvalidation(documentState, bytes) {
    const result = await baseReplaceSourceDocumentBytes(documentState, bytes);
    clearLayoutCacheForDocument(documentState.id);
    return result;
  };

  window.LuminaDocumentEditor = {
    enter: enterDocumentEditMode,
    saveAndRead: commitDocumentEditsAndRead,
    discard: discardDocumentEdits,
    undo: undoDocumentEdit,
    redo: redoDocumentEdit,
    render: renderDocumentEditLayer,
    state: editor,
  };

  injectDocumentEditorUI();
})();
