(function () {
  'use strict';

  const PATCH_VERSION = '1.0.0';
  const STYLE_ID = 'lumina-edit-transactions-style';
  const DRAG_THRESHOLD = 4;
  const savedRedoByDocument = new Map();
  const knownBackupLengths = new Map();
  let revisionBusy = false;
  let selectionDrag = null;
  let groupMove = null;
  let lastInsertionPoint = null;
  let syncFrame = 0;

  const clone = (value) => structuredClone(value);
  const api = () => window.LuminaDocumentEditor || null;
  const editor = () => api()?.state || null;

  function selectedIds() {
    const current = editor();
    if (!current) return new Set();
    if (!(current.selectedIds instanceof Set)) {
      current.selectedIds = new Set(current.selectedId ? [current.selectedId] : []);
    }
    if (current.selectedId && !current.selectedIds.size) current.selectedIds.add(current.selectedId);
    return current.selectedIds;
  }

  function objectById(id) {
    const current = editor();
    if (!current || !id) return null;
    return current.currentObjects.find((object) => object.id === id)
      || current.added.get(id)
      || current.changes.get(id)
      || null;
  }

  function relevantState(object) {
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

  function matchesOriginal(object) {
    return Boolean(object.original)
      && JSON.stringify(relevantState(object)) === JSON.stringify(object.original);
  }

  function persistObject(object) {
    const current = editor();
    if (!current || !object) return;
    if (object.isNew) current.added.set(object.id, clone(object));
    else if (matchesOriginal(object)) current.changes.delete(object.id);
    else current.changes.set(object.id, clone(object));
    const index = current.currentObjects.findIndex((item) => item.id === object.id);
    if (index >= 0) current.currentObjects[index] = clone(object);
  }

  function snapshot() {
    const current = editor();
    return {
      changes: [...current.changes.entries()].map(([key, value]) => [key, clone(value)]),
      added: [...current.added.entries()].map(([key, value]) => [key, clone(value)]),
      selectedId: current.selectedId,
      tool: current.tool,
    };
  }

  function pushHistory() {
    const current = editor();
    if (!current || current.mode !== 'edit' || current.committing) return;
    current.history.push(snapshot());
    current.history = current.history.slice(-120);
    current.future = [];
    refreshControls();
  }

  function currentDocument() {
    return typeof activeDocument === 'function' ? activeDocument() : null;
  }

  function backupsFor(documentState) {
    return documentState ? (nativeEngine.backupsByDocument.get(documentState.id) || []) : [];
  }

  function savedRedoFor(documentState) {
    if (!documentState) return [];
    if (!savedRedoByDocument.has(documentState.id)) savedRedoByDocument.set(documentState.id, []);
    return savedRedoByDocument.get(documentState.id);
  }

  function trackSavedRevisionChanges() {
    for (const documentState of state.documents.values()) {
      const length = backupsFor(documentState).length;
      const previous = knownBackupLengths.get(documentState.id);
      if (!revisionBusy && previous !== undefined && length > previous) savedRedoByDocument.set(documentState.id, []);
      knownBackupLengths.set(documentState.id, length);
    }
  }

  async function refreshAfterRevision(documentState) {
    const current = editor();
    if (current) {
      current.changes.clear();
      current.added.clear();
      current.history = [];
      current.future = [];
      current.selectedId = null;
      current.selectedIds = new Set();
      current.activeEditableId = null;
      current.layoutCache?.delete?.(`${documentState.id}:${activePage()?.sourceIndex ?? 0}`);
    }
    if (current?.mode === 'edit') await api().render();
    refreshControls();
    scheduleSync();
  }

  async function undoSavedRevision() {
    const documentState = currentDocument();
    const backups = backupsFor(documentState);
    if (!documentState || !backups.length || revisionBusy) return false;
    revisionBusy = true;
    try {
      const redo = savedRedoFor(documentState);
      redo.push(documentState.bytes.slice());
      const previous = backups.pop();
      nativeEngine.backupsByDocument.set(documentState.id, backups);
      savedRedoByDocument.set(documentState.id, redo.slice(-20));
      await replaceSourceDocumentBytes(documentState, previous);
      knownBackupLengths.set(documentState.id, backups.length);
      await refreshAfterRevision(documentState);
      flash('Undid the last saved PDF revision');
      return true;
    } finally {
      revisionBusy = false;
    }
  }

  async function redoSavedRevision() {
    const documentState = currentDocument();
    const redo = savedRedoFor(documentState);
    if (!documentState || !redo.length || revisionBusy) return false;
    revisionBusy = true;
    try {
      const backups = backupsFor(documentState);
      backups.push(documentState.bytes.slice());
      const next = redo.pop();
      nativeEngine.backupsByDocument.set(documentState.id, backups.slice(-20));
      savedRedoByDocument.set(documentState.id, redo);
      await replaceSourceDocumentBytes(documentState, next);
      knownBackupLengths.set(documentState.id, backups.length);
      await refreshAfterRevision(documentState);
      flash('Redid the saved PDF revision');
      return true;
    } finally {
      revisionBusy = false;
    }
  }

  function refreshControls() {
    const current = editor();
    const documentState = currentDocument();
    const ids = current ? selectedIds() : new Set();
    const undo = document.querySelector('#document-undo');
    const redo = document.querySelector('#document-redo');
    const baseUndo = document.querySelector('#undo-button');
    const baseRedo = document.querySelector('#redo-button');
    const canUndoSaved = backupsFor(documentState).length > 0;
    const canRedoSaved = savedRedoFor(documentState).length > 0;
    if (undo) {
      undo.disabled = !(current?.history.length || canUndoSaved);
      undo.title = current?.history.length ? 'Undo edit (Ctrl/Cmd+Z)' : canUndoSaved ? 'Undo last saved PDF revision' : 'Nothing to undo';
    }
    if (redo) {
      redo.disabled = !(current?.future.length || canRedoSaved);
      redo.title = current?.future.length ? 'Redo edit (Ctrl/Cmd+Shift+Z)' : canRedoSaved ? 'Redo saved PDF revision' : 'Nothing to redo';
    }
    if (baseUndo && !state.history.length) baseUndo.disabled = !canUndoSaved;
    if (baseRedo && !state.future.length) baseRedo.disabled = !canRedoSaved;
    const deleteButton = document.querySelector('#document-delete');
    const duplicateButton = document.querySelector('#document-duplicate');
    if (deleteButton) deleteButton.disabled = ids.size === 0;
    if (duplicateButton) duplicateButton.disabled = ids.size === 0;
    const count = document.querySelector('#document-edit-count');
    if (count && current) {
      const drafts = current.changes.size + current.added.size;
      const selection = ids.size > 1 ? ` · ${ids.size} selected` : '';
      count.textContent = drafts ? `${drafts} unsaved change${drafts === 1 ? '' : 's'}${selection}` : ids.size > 1 ? `${ids.size} selected` : 'No changes';
    }
  }

  function pdfRectToScreen(rect) {
    const current = editor();
    if (!current?.currentViewport || !rect) return null;
    const converted = current.currentViewport.convertToViewportRectangle([
      rect[0], current.currentPageHeight - rect[3], rect[2], current.currentPageHeight - rect[1],
    ]);
    return {
      left: Math.min(converted[0], converted[2]),
      top: Math.min(converted[1], converted[3]),
      width: Math.max(4, Math.abs(converted[2] - converted[0])),
      height: Math.max(4, Math.abs(converted[3] - converted[1])),
    };
  }

  function eventToPdfPoint(event) {
    const current = editor();
    const stage = document.querySelector('#page-stage');
    if (!current?.currentViewport || !stage) return null;
    const bounds = stage.getBoundingClientRect();
    const [pdfX, pdfY] = current.currentViewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
    return {
      x: Math.max(0, Math.min(current.currentPageWidth, pdfX)),
      y: Math.max(0, Math.min(current.currentPageHeight, current.currentPageHeight - pdfY)),
    };
  }

  function sampleBackground(screen) {
    const canvas = document.querySelector('#pdf-canvas');
    if (!canvas || !screen) return 'rgb(255,255,255)';
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 'rgb(255,255,255)';
    const cssWidth = Number.parseFloat(canvas.style.width) || canvas.clientWidth || canvas.width;
    const cssHeight = Number.parseFloat(canvas.style.height) || canvas.clientHeight || canvas.height;
    const sx = canvas.width / Math.max(1, cssWidth);
    const sy = canvas.height / Math.max(1, cssHeight);
    const points = [
      [screen.left - 2, screen.top - 2], [screen.left + screen.width + 2, screen.top - 2],
      [screen.left - 2, screen.top + screen.height + 2], [screen.left + screen.width + 2, screen.top + screen.height + 2],
      [screen.left + screen.width / 2, screen.top - 2], [screen.left + screen.width / 2, screen.top + screen.height + 2],
    ];
    const channels = [[], [], []];
    try {
      for (const [x, y] of points) {
        const pixel = context.getImageData(
          Math.max(0, Math.min(canvas.width - 1, Math.round(x * sx))),
          Math.max(0, Math.min(canvas.height - 1, Math.round(y * sy))), 1, 1,
        ).data;
        if (pixel[3] < 160) continue;
        channels[0].push(pixel[0]); channels[1].push(pixel[1]); channels[2].push(pixel[2]);
      }
    } catch (_) { return 'rgb(255,255,255)'; }
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 255;
    return `rgb(${median(channels[0])},${median(channels[1])},${median(channels[2])})`;
  }

  function syncDeletedMasks() {
    const current = editor();
    const layer = document.querySelector('#document-text-layer');
    const page = typeof activePage === 'function' ? activePage() : null;
    if (!current || !layer || !page) return;
    layer.querySelectorAll('.document-deletion-mask').forEach((element) => element.remove());
    document.querySelectorAll('.annotation-object.transaction-hidden').forEach((element) => element.classList.remove('transaction-hidden'));
    if (current.mode !== 'edit') return;
    for (const object of current.changes.values()) {
      if (!object.deleted || object.pageId !== page.id) continue;
      if (object.isAnnotation && object.annotationId) {
        document.querySelector(`[data-annotation-id="${CSS.escape(object.annotationId)}"]`)?.classList.add('transaction-hidden');
        continue;
      }
      const screen = pdfRectToScreen(object.sourceRect || object.rect);
      if (!screen) continue;
      const mask = document.createElement('div');
      mask.className = 'document-deletion-mask';
      mask.dataset.deletedObjectId = object.id;
      mask.style.left = `${screen.left - 2}px`;
      mask.style.top = `${screen.top - 2}px`;
      mask.style.width = `${screen.width + 4}px`;
      mask.style.height = `${screen.height + 4}px`;
      mask.style.background = sampleBackground(screen);
      layer.prepend(mask);
    }
  }

  function syncSelectionChrome() {
    const current = editor();
    const layer = document.querySelector('#document-text-layer');
    if (!current || !layer) return;
    const ids = selectedIds();
    if (current.selectedId && !ids.has(current.selectedId)) ids.add(current.selectedId);
    layer.querySelectorAll('.document-object[data-object-id]').forEach((element) => {
      const selected = ids.has(element.dataset.objectId);
      element.classList.toggle('multi-selected', selected);
      if (selected) element.setAttribute('aria-selected', 'true'); else element.removeAttribute('aria-selected');
    });
    refreshControls();
  }

  function syncAll() {
    syncFrame = 0;
    trackSavedRevisionChanges();
    syncDeletedMasks();
    syncSelectionChrome();
  }

  function scheduleSync() {
    if (!syncFrame) syncFrame = requestAnimationFrame(syncAll);
  }

  function setSelection(ids, primary = null) {
    const current = editor();
    if (!current) return;
    current.selectedIds = new Set(ids);
    current.selectedId = primary || [...current.selectedIds].at(-1) || null;
    scheduleSync();
  }

  function intersects(a, b) {
    return a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
  }

  function createMarquee() {
    let element = document.querySelector('.document-multi-marquee');
    if (!element) {
      element = document.createElement('div');
      element.className = 'document-multi-marquee';
      document.querySelector('#document-text-layer')?.appendChild(element);
    }
    return element;
  }

  function drawMarquee(rect) {
    const element = createMarquee();
    const screen = pdfRectToScreen(rect);
    if (!screen) return;
    Object.assign(element.style, {
      left: `${screen.left}px`, top: `${screen.top}px`, width: `${screen.width}px`, height: `${screen.height}px`,
    });
  }

  function removeMarquee() {
    document.querySelector('.document-multi-marquee')?.remove();
  }

  function selectionPointerDown(event) {
    const current = editor();
    const layer = document.querySelector('#document-text-layer');
    if (!current || current.mode !== 'edit' || event.button !== 0 || event.target !== layer || current.tool !== 'select') return;
    const point = eventToPdfPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lastInsertionPoint = point;
    selectionDrag = { pointerId: event.pointerId, start: point, current: point, moved: false, additive: event.shiftKey || event.ctrlKey || event.metaKey };
    layer.setPointerCapture(event.pointerId);
  }

  function selectionPointerMove(event) {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    const point = eventToPdfPoint(event);
    if (!point) return;
    const dx = point.x - selectionDrag.start.x;
    const dy = point.y - selectionDrag.start.y;
    if (!selectionDrag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectionDrag.moved = true;
    selectionDrag.current = point;
    drawMarquee([
      Math.min(selectionDrag.start.x, point.x), Math.min(selectionDrag.start.y, point.y),
      Math.max(selectionDrag.start.x, point.x), Math.max(selectionDrag.start.y, point.y),
    ]);
  }

  function selectionPointerUp(event) {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = editor();
    const drag = selectionDrag;
    selectionDrag = null;
    try { document.querySelector('#document-text-layer')?.releasePointerCapture(event.pointerId); } catch (_) { /* no-op */ }
    removeMarquee();
    if (!drag.moved) {
      if (!drag.additive) setSelection([]);
      return;
    }
    const rect = [
      Math.min(drag.start.x, drag.current.x), Math.min(drag.start.y, drag.current.y),
      Math.max(drag.start.x, drag.current.x), Math.max(drag.start.y, drag.current.y),
    ];
    const hits = current.currentObjects.filter((object) => !object.deleted && intersects(object.rect, rect)).map((object) => object.id);
    const next = drag.additive ? new Set([...selectedIds(), ...hits]) : new Set(hits);
    setSelection(next, hits.at(-1) || [...next].at(-1));
  }

  function objectClickCapture(event) {
    const current = editor();
    const element = event.target.closest?.('.document-object[data-object-id]');
    if (!current || current.mode !== 'edit' || !element) return;
    if (current.activeEditableId === element.dataset.objectId && event.target.closest?.('[contenteditable="true"]')) return;
    const id = element.dataset.objectId;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const next = new Set(selectedIds());
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelection(next, next.has(id) ? id : [...next].at(-1));
      return;
    }
    current.selectedIds = new Set([id]);
    current.selectedId = id;
    scheduleSync();
  }

  function updateElementRect(object) {
    const element = document.querySelector(`[data-object-id="${CSS.escape(object.id)}"]`);
    const screen = pdfRectToScreen(object.rect);
    if (!element || !screen) return;
    Object.assign(element.style, {
      left: `${screen.left}px`, top: `${screen.top}px`, width: `${screen.width}px`, height: `${screen.height}px`,
    });
  }

  function groupMovePointerDown(event) {
    const current = editor();
    const handle = event.target.closest?.('[data-move]');
    const ids = selectedIds();
    if (!current || current.mode !== 'edit' || !handle || ids.size < 2) return;
    const primaryElement = event.target.closest('[data-object-id]');
    if (!primaryElement || !ids.has(primaryElement.dataset.objectId)) return;
    const start = eventToPdfPoint(event);
    if (!start) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pushHistory();
    const objects = [...ids].map(objectById).filter(Boolean);
    groupMove = {
      pointerId: event.pointerId,
      start,
      objects: objects.map((object) => ({ id: object.id, rect: [...object.rect] })),
      bounds: [
        Math.min(...objects.map((object) => object.rect[0])), Math.min(...objects.map((object) => object.rect[1])),
        Math.max(...objects.map((object) => object.rect[2])), Math.max(...objects.map((object) => object.rect[3])),
      ],
    };
    document.querySelector('#document-text-layer')?.setPointerCapture(event.pointerId);
  }

  function groupMovePointerMove(event) {
    if (!groupMove || groupMove.pointerId !== event.pointerId) return;
    const current = editor();
    const point = eventToPdfPoint(event);
    if (!current || !point) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const dx = Math.max(-groupMove.bounds[0], Math.min(current.currentPageWidth - groupMove.bounds[2], point.x - groupMove.start.x));
    const dy = Math.max(-groupMove.bounds[1], Math.min(current.currentPageHeight - groupMove.bounds[3], point.y - groupMove.start.y));
    for (const original of groupMove.objects) {
      const object = objectById(original.id);
      if (!object) continue;
      object.rect = [original.rect[0] + dx, original.rect[1] + dy, original.rect[2] + dx, original.rect[3] + dy];
      persistObject(object);
      updateElementRect(object);
    }
    scheduleSync();
  }

  function groupMovePointerUp(event) {
    if (!groupMove || groupMove.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    groupMove = null;
    try { document.querySelector('#document-text-layer')?.releasePointerCapture(event.pointerId); } catch (_) { /* no-op */ }
    api()?.render();
  }

  function deleteObjects(ids, { recordHistory = true } = {}) {
    const current = editor();
    const objects = [...ids].map(objectById).filter(Boolean);
    if (!current || !objects.length) return;
    if (recordHistory) pushHistory();
    for (const object of objects) {
      if (object.isNew) current.added.delete(object.id);
      else {
        object.deleted = true;
        current.changes.set(object.id, clone(object));
      }
    }
    setSelection([]);
    api().render();
    scheduleSync();
  }

  function duplicateObjects(ids) {
    const current = editor();
    const objects = [...ids].map(objectById).filter(Boolean);
    if (!current || !objects.length) return;
    pushHistory();
    const copies = [];
    for (const object of objects) {
      const copy = clone(object);
      copy.id = `new:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      copy.isNew = true;
      copy.isAnnotation = false;
      copy.annotationId = null;
      copy.sourceRect = null;
      copy.deleted = false;
      delete copy.original;
      const dx = Math.min(18, Math.max(0, current.currentPageWidth - copy.rect[2]));
      const dy = Math.min(18, Math.max(0, current.currentPageHeight - copy.rect[3]));
      copy.rect = [copy.rect[0] + dx, copy.rect[1] + dy, copy.rect[2] + dx, copy.rect[3] + dy];
      current.added.set(copy.id, copy);
      copies.push(copy.id);
    }
    setSelection(copies, copies.at(-1));
    api().render();
  }

  function actionButtonCapture(event) {
    const current = editor();
    const deleteButton = event.target.closest?.('#document-delete');
    const duplicateButton = event.target.closest?.('#document-duplicate');
    const undoButton = event.target.closest?.('#document-undo,#undo-button');
    const redoButton = event.target.closest?.('#document-redo,#redo-button');
    if (undoButton && current && !current.history.length && !current.future.length && backupsFor(currentDocument()).length) {
      event.preventDefault(); event.stopImmediatePropagation(); void undoSavedRevision(); return;
    }
    if (redoButton && current && !current.future.length && savedRedoFor(currentDocument()).length) {
      event.preventDefault(); event.stopImmediatePropagation(); void redoSavedRevision(); return;
    }
    const ids = selectedIds();
    if (deleteButton && ids.size > 1) {
      event.preventDefault(); event.stopImmediatePropagation(); deleteObjects(ids); return;
    }
    if (duplicateButton && ids.size > 1) {
      event.preventDefault(); event.stopImmediatePropagation(); duplicateObjects(ids);
    }
  }

  function applyStyleToSelection(property, value) {
    const objects = [...selectedIds()].map(objectById).filter((object) => object?.kind === 'text');
    if (objects.length < 2) return false;
    pushHistory();
    for (const object of objects) {
      object.style = { ...object.style, [property]: value };
      persistObject(object);
    }
    api().render();
    return true;
  }

  function formattingCapture(event) {
    const target = event.target.closest?.('#document-font-family,#document-font-size,#document-bold,#document-italic,#document-underline,#document-text-color,#document-align,#document-line-height');
    if (!target || selectedIds().size < 2) return;
    const primary = objectById(editor()?.selectedId);
    if (!primary || primary.kind !== 'text') return;
    let property;
    let value;
    if (target.id === 'document-font-family') { property = 'fontFamily'; value = target.value === 'original' ? null : target.value; }
    if (target.id === 'document-font-size') { property = 'fontSize'; value = Math.max(4, Math.min(144, Number(target.value) || 11)); }
    if (target.id === 'document-bold') { property = 'bold'; value = !primary.style.bold; }
    if (target.id === 'document-italic') { property = 'italic'; value = !primary.style.italic; }
    if (target.id === 'document-underline') { property = 'underline'; value = !primary.style.underline; }
    if (target.id === 'document-text-color') { property = 'color'; value = target.value; }
    if (target.id === 'document-align') { property = 'align'; value = target.value; }
    if (target.id === 'document-line-height') { property = 'lineHeight'; value = Number(target.value) || 1.15; }
    if (!property) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    applyStyleToSelection(property, value);
  }

  function autoGrowTextBox(event) {
    const content = event.target.closest?.('.document-text-content[contenteditable="true"]');
    if (!content) return;
    queueMicrotask(() => {
      const current = editor();
      const element = content.closest('[data-object-id]');
      const object = objectById(element?.dataset.objectId);
      if (!current || !element || !object || object.kind !== 'text') return;
      const scale = Number(current.currentViewport?.scale) || Number(state.zoom) || 1;
      const minimumScreenHeight = Math.max(18, (object.style.fontSize || 11) * scale * (object.style.lineHeight || 1.15) + 6);
      const desiredScreenHeight = Math.max(minimumScreenHeight, content.scrollHeight + 6);
      const desiredPdfHeight = desiredScreenHeight / Math.max(0.01, scale);
      const currentHeight = object.rect[3] - object.rect[1];
      if (desiredPdfHeight > currentHeight + 0.5) {
        const available = current.currentPageHeight - object.rect[1];
        object.rect[3] = object.rect[1] + Math.min(available, desiredPdfHeight);
        persistObject(object);
        updateElementRect(object);
        scheduleSync();
      }
    });
  }

  function makeTextObject(point, initialText = '') {
    const current = editor();
    const page = typeof activePage === 'function' ? activePage() : null;
    if (!current || !page) return null;
    const width = Math.min(320, Math.max(120, current.currentPageWidth - point.x - 24));
    const height = 48;
    const x0 = Math.max(0, Math.min(point.x, current.currentPageWidth - width));
    const y0 = Math.max(0, Math.min(point.y, current.currentPageHeight - height));
    return {
      id: `new:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      kind: 'text', docId: page.docId, pageId: page.id, sourceIndex: page.sourceIndex,
      rect: [x0, y0, x0 + width, y0 + height], sourceRect: null, text: initialText, dataUrl: null,
      style: { fontName: 'Helvetica', fontXref: null, fontFamily: 'Helvetica', fontSize: 12, color: '#111318', bold: false, italic: false, underline: false, align: 'left', lineHeight: 1.15 },
      rotation: 0, isNew: true, isAnnotation: false, deleted: false,
    };
  }

  async function createTextAt(point, initialText = '') {
    const current = editor();
    if (!current || current.mode !== 'edit' || !point) return;
    pushHistory();
    const object = makeTextObject(point, initialText);
    if (!object) return;
    current.added.set(object.id, clone(object));
    setSelection([object.id], object.id);
    await api().render();
    const element = document.querySelector(`[data-object-id="${CSS.escape(object.id)}"]`);
    if (element) window.LuminaEditInteractionFix?.beginInlineEdit(element, object.id);
  }

  function blankDoubleClick(event) {
    const current = editor();
    const layer = document.querySelector('#document-text-layer');
    if (!current || current.mode !== 'edit' || event.target !== layer) return;
    const point = eventToPdfPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lastInsertionPoint = point;
    void createTextAt(point);
  }

  function keyboardCapture(event) {
    const current = editor();
    const typing = event.target.closest?.('[contenteditable="true"],input,textarea,select');
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'z' && !typing && current) {
      event.stopPropagation();
      if (!current.history.length && !current.future.length && backupsFor(currentDocument()).length) {
        event.preventDefault(); void undoSavedRevision();
      }
      return;
    }
    if (modifier && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z')) && !typing && current) {
      event.stopPropagation();
      if (!current.future.length && savedRedoFor(currentDocument()).length) {
        event.preventDefault(); void redoSavedRevision();
      }
      return;
    }
    if (!current || current.mode !== 'edit' || typing) return;
    const ids = selectedIds();
    if ((event.key === 'Delete' || event.key === 'Backspace') && ids.size > 1) {
      event.preventDefault(); event.stopPropagation(); deleteObjects(ids, { recordHistory: false }); return;
    }
    if (!modifier && !event.altKey && ids.size === 0 && lastInsertionPoint && (event.key === 'Enter' || event.key.length === 1)) {
      event.preventDefault();
      void createTextAt(lastInsertionPoint, event.key === 'Enter' ? '' : event.key);
    }
  }

  function normalizeLongAIReplacements() {
    state.pendingAIActions = state.pendingAIActions.map((action) => {
      if (action?.tool !== 'edit_text') return action;
      const search = String(action.args?.search || '');
      const replacement = String(action.args?.replacement || '');
      const tooLong = replacement.length > Math.max(120, search.length * 2.5) || replacement.includes('\n');
      if (!tooLong) return action;
      return {
        tool: 'insert_answer',
        args: {
          page: action.args?.page,
          after_text: search,
          title: action.args?.title || 'Answer',
          text: replacement,
        },
      };
    });
  }

  function wrapAIExecution() {
    if (window.__luminaTransactionAIWrapped || typeof executePendingAIActions !== 'function') return;
    const base = executePendingAIActions;
    executePendingAIActions = async function transactionAwareAIExecution() {
      normalizeLongAIReplacements();
      return base();
    };
    window.__luminaTransactionAIWrapped = true;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .document-deletion-mask{position:absolute;z-index:8;pointer-events:none;border-radius:1px}
      .annotation-object.transaction-hidden{display:none!important}
      .document-object.multi-selected{border-color:#6047e8!important;box-shadow:0 0 0 2px rgba(96,71,232,.18)!important}
      .document-object.multi-selected:not(.selected)::after{content:'';position:absolute;inset:-3px;border:1px dashed #6047e8;border-radius:4px;pointer-events:none}
      .document-multi-marquee{position:absolute;z-index:30;border:1.5px dashed #6047e8;background:rgba(96,71,232,.09);pointer-events:none;border-radius:4px}
      .document-object.is-editing .document-text-content{overflow-y:hidden!important;min-height:100%!important}
    `;
    document.head.appendChild(style);
  }

  function init() {
    const layer = document.querySelector('#document-text-layer');
    if (!layer || !api()) return;
    injectStyles();
    wrapAIExecution();
    selectedIds();
    for (const documentState of state.documents.values()) knownBackupLengths.set(documentState.id, backupsFor(documentState).length);

    layer.addEventListener('click', objectClickCapture, true);
    layer.addEventListener('dblclick', blankDoubleClick, true);
    layer.addEventListener('pointerdown', groupMovePointerDown, true);
    layer.addEventListener('pointermove', groupMovePointerMove, true);
    layer.addEventListener('pointerup', groupMovePointerUp, true);
    layer.addEventListener('pointercancel', groupMovePointerUp, true);
    layer.addEventListener('pointerdown', selectionPointerDown, true);
    layer.addEventListener('pointermove', selectionPointerMove, true);
    layer.addEventListener('pointerup', selectionPointerUp, true);
    layer.addEventListener('pointercancel', selectionPointerUp, true);

    document.addEventListener('click', actionButtonCapture, true);
    document.addEventListener('click', formattingCapture, true);
    document.addEventListener('change', formattingCapture, true);
    document.addEventListener('input', (event) => {
      formattingCapture(event);
      autoGrowTextBox(event);
    }, true);
    document.addEventListener('keydown', keyboardCapture, true);

    const observer = new MutationObserver(() => scheduleSync());
    observer.observe(layer, { childList: true, subtree: true });
    observer.observe(document.querySelector('.top-actions') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class'] });
    scheduleSync();

    window.LuminaEditTransactions = {
      version: PATCH_VERSION,
      selectedIds,
      deleteObjects,
      createTextAt,
      undoSavedRevision,
      redoSavedRevision,
      sync: syncAll,
    };
  }

  init();
})();
