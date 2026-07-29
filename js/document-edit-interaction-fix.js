(function () {
  'use strict';

  const DOUBLE_CLICK_MS = 650;
  const DOUBLE_CLICK_DISTANCE = 8;
  const PATCH_STYLE_ID = 'lumina-inline-edit-fix-style';
  let lastPointer = null;
  let suppressClick = null;
  let activeHandlers = null;
  let maskFrame = 0;

  const clone = (value) => structuredClone(value);

  function api() {
    return window.LuminaDocumentEditor || null;
  }

  function editor() {
    return api()?.state || null;
  }

  function findObject(id) {
    const current = editor();
    if (!current || !id) return null;
    return current.currentObjects.find((object) => object.id === id)
      || current.added.get(id)
      || current.changes.get(id)
      || null;
  }

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
    current.history = current.history.slice(-80);
    current.future = [];
    refreshChrome();
  }

  function storeObject(object) {
    const current = editor();
    if (!current || !object) return;
    if (object.isNew) current.added.set(object.id, clone(object));
    else if (objectMatchesOriginal(object)) current.changes.delete(object.id);
    else current.changes.set(object.id, clone(object));

    const index = current.currentObjects.findIndex((item) => item.id === object.id);
    if (index >= 0) current.currentObjects[index] = clone(object);
    refreshChrome();
    scheduleMasks();
  }

  function refreshChrome() {
    const current = editor();
    if (!current) return;
    const count = current.changes.size + current.added.size;
    const counter = document.querySelector('#document-edit-count');
    if (counter) counter.textContent = count ? `${count} unsaved change${count === 1 ? '' : 's'}` : 'No changes';
    const undo = document.querySelector('#document-undo');
    const redo = document.querySelector('#document-redo');
    if (undo) undo.disabled = !current.history.length;
    if (redo) redo.disabled = !current.future.length;
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

  function median(values) {
    if (!values.length) return 255;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function sampleBackground(screen) {
    const canvas = document.querySelector('#pdf-canvas');
    if (!canvas || !screen) return 'rgb(255, 255, 255)';
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 'rgb(255, 255, 255)';
    const cssWidth = Number.parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width || canvas.width;
    const cssHeight = Number.parseFloat(canvas.style.height) || canvas.getBoundingClientRect().height || canvas.height;
    const scaleX = canvas.width / Math.max(1, cssWidth);
    const scaleY = canvas.height / Math.max(1, cssHeight);
    const inset = 2;
    const samples = [];
    const fractions = [0, 0.2, 0.4, 0.6, 0.8, 1];
    for (const fraction of fractions) {
      samples.push([screen.left + screen.width * fraction, screen.top - inset]);
      samples.push([screen.left + screen.width * fraction, screen.top + screen.height + inset]);
      samples.push([screen.left - inset, screen.top + screen.height * fraction]);
      samples.push([screen.left + screen.width + inset, screen.top + screen.height * fraction]);
    }
    const red = [];
    const green = [];
    const blue = [];
    try {
      for (const [cssX, cssY] of samples) {
        const x = Math.max(0, Math.min(canvas.width - 1, Math.round(cssX * scaleX)));
        const y = Math.max(0, Math.min(canvas.height - 1, Math.round(cssY * scaleY)));
        const pixel = context.getImageData(x, y, 1, 1).data;
        if (pixel[3] < 180) continue;
        red.push(pixel[0]);
        green.push(pixel[1]);
        blue.push(pixel[2]);
      }
    } catch (_) {
      return 'rgb(255, 255, 255)';
    }
    return `rgb(${median(red)}, ${median(green)}, ${median(blue)})`;
  }

  function syncSourceMasks() {
    maskFrame = 0;
    const current = editor();
    const layer = document.querySelector('#document-text-layer');
    if (!current || !layer) return;
    layer.querySelectorAll('.document-source-mask').forEach((mask) => mask.remove());
    if (current.mode !== 'edit') return;

    const maskedObjects = current.currentObjects.filter((object) => (
      !object.isNew
      && !object.isAnnotation
      && object.kind === 'text'
      && object.sourceRect
      && (current.changes.has(object.id) || current.activeEditableId === object.id)
    ));

    for (const object of maskedObjects) {
      const screen = pdfRectToScreen(object.sourceRect);
      if (!screen) continue;
      const background = sampleBackground(screen);
      const mask = document.createElement('div');
      mask.className = 'document-source-mask';
      mask.dataset.sourceObjectId = object.id;
      mask.style.left = `${screen.left - 2}px`;
      mask.style.top = `${screen.top - 2}px`;
      mask.style.width = `${screen.width + 4}px`;
      mask.style.height = `${screen.height + 4}px`;
      mask.style.background = background;
      layer.prepend(mask);

      const objectElement = layer.querySelector(`[data-object-id="${CSS.escape(object.id)}"]`);
      if (objectElement) objectElement.style.setProperty('--lumina-edit-background', background);
    }
  }

  function scheduleMasks() {
    if (maskFrame) return;
    maskFrame = requestAnimationFrame(syncSourceMasks);
  }

  function finishPatchedInlineEdit({ cancel = false } = {}) {
    const current = editor();
    if (!current?.activeEditableId) return;
    const objectId = current.activeEditableId;
    const object = findObject(objectId);
    const element = document.querySelector(`[data-object-id="${CSS.escape(objectId)}"]`);
    const content = element?.querySelector('.document-text-content');
    if (content && activeHandlers) {
      content.removeEventListener('input', activeHandlers.input);
      content.removeEventListener('blur', activeHandlers.blur);
      content.removeEventListener('keydown', activeHandlers.keydown);
      content.contentEditable = 'false';
      element.classList.remove('is-editing');
    }
    if (cancel && current.activeBefore) storeObject(clone(current.activeBefore));
    else if (object) storeObject(object);
    current.activeEditableId = null;
    current.activeBefore = null;
    activeHandlers = null;
    api()?.render();
    scheduleMasks();
  }

  function beginPatchedInlineEdit(element, objectId) {
    const current = editor();
    const object = findObject(objectId);
    if (!current || current.mode !== 'edit' || !object || object.kind !== 'text') return;
    if (current.activeEditableId === objectId) return;
    if (current.activeEditableId) finishPatchedInlineEdit();

    pushHistory();
    current.selectedId = objectId;
    current.tool = 'select';
    current.activeEditableId = objectId;
    current.activeBefore = clone(object);

    element.classList.add('selected', 'is-editing');
    const content = element.querySelector('.document-text-content');
    if (!content) return;
    content.contentEditable = 'true';
    content.spellcheck = true;

    const input = () => {
      const liveObject = findObject(objectId);
      if (!liveObject) return;
      liveObject.text = content.textContent ?? '';
      storeObject(liveObject);
    };
    const blur = () => finishPatchedInlineEdit();
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finishPatchedInlineEdit({ cancel: true });
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        finishPatchedInlineEdit();
      }
    };
    activeHandlers = { input, blur, keydown };
    content.addEventListener('input', input);
    content.addEventListener('blur', blur, { once: true });
    content.addEventListener('keydown', keydown);
    content.focus({ preventScroll: true });

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
    refreshChrome();
    scheduleMasks();
  }

  function isSecondPointer(event, objectId) {
    if (!lastPointer || lastPointer.objectId !== objectId) return false;
    const elapsed = event.timeStamp - lastPointer.timeStamp;
    const distance = Math.hypot(event.clientX - lastPointer.clientX, event.clientY - lastPointer.clientY);
    return elapsed >= 0 && elapsed <= DOUBLE_CLICK_MS && distance <= DOUBLE_CLICK_DISTANCE;
  }

  function handlePointerDownCapture(event) {
    const current = editor();
    const objectElement = event.target.closest?.('.document-object.kind-text[data-object-id]');
    if (!current || current.mode !== 'edit' || !objectElement) {
      lastPointer = null;
      return;
    }
    const objectId = objectElement.dataset.objectId;
    if (current.activeEditableId === objectId) {
      lastPointer = null;
      return;
    }
    if (isSecondPointer(event, objectId)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = { objectId, until: performance.now() + 500 };
      lastPointer = null;
      beginPatchedInlineEdit(objectElement, objectId);
      return;
    }
    lastPointer = {
      objectId,
      timeStamp: event.timeStamp,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  function handleClickCapture(event) {
    const current = editor();
    const objectElement = event.target.closest?.('.document-object.kind-text[data-object-id]');
    if (!current || !objectElement) return;
    const objectId = objectElement.dataset.objectId;
    if (current.activeEditableId === objectId && event.target.closest?.('.document-text-content')) {
      event.stopImmediatePropagation();
      return;
    }
    if (suppressClick?.objectId === objectId && performance.now() <= suppressClick.until) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = null;
    }
  }

  function handleDoubleClickCapture(event) {
    const objectElement = event.target.closest?.('.document-object.kind-text[data-object-id]');
    if (!objectElement) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = editor();
    if (current?.activeEditableId !== objectElement.dataset.objectId) {
      beginPatchedInlineEdit(objectElement, objectElement.dataset.objectId);
    }
  }

  function injectStyles() {
    if (document.getElementById(PATCH_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PATCH_STYLE_ID;
    style.textContent = `
      .source-object.selected:not(.changed):not(.is-editing) .document-text-content{opacity:0!important;background:transparent!important}
      .document-source-mask{position:absolute;z-index:5;pointer-events:none;box-sizing:border-box;border-radius:1px}
      .document-object.changed .document-text-content,.document-object.is-editing .document-text-content{background:var(--lumina-edit-background,#fff)!important}
      .document-object.is-editing .document-text-content{opacity:1!important;pointer-events:auto!important;user-select:text!important;cursor:text!important}
    `;
    document.head.appendChild(style);
  }

  function init() {
    const layer = document.querySelector('#document-text-layer');
    if (!layer || !api()) return;
    injectStyles();
    layer.classList.add('inline-edit-interaction-fixed');
    layer.addEventListener('pointerdown', handlePointerDownCapture, true);
    layer.addEventListener('click', handleClickCapture, true);
    layer.addEventListener('dblclick', handleDoubleClickCapture, true);

    const observer = new MutationObserver((mutations) => {
      const onlyMasks = mutations.every((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].every(
        (node) => node.nodeType !== Node.ELEMENT_NODE || node.classList?.contains('document-source-mask'),
      ));
      if (!onlyMasks) scheduleMasks();
    });
    observer.observe(layer, { childList: true, subtree: true });
    scheduleMasks();

    window.LuminaEditInteractionFix = {
      version: '1.0.0',
      beginInlineEdit: beginPatchedInlineEdit,
      finishInlineEdit: finishPatchedInlineEdit,
      syncSourceMasks,
      isSecondPointer,
    };
  }

  init();
})();
