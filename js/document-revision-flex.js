(function () {
  'use strict';

  if (typeof replaceSourceDocumentBytes !== 'function' || window.__luminaFlexibleRevisionReplacement) return;

  const clone = (value) => structuredClone(value);

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

  function storeParagraphText(object, text) {
    const documentEditor = window.LuminaDocumentEditor?.state;
    if (!documentEditor || !object) return;
    object.text = text;
    if (object.isNew) documentEditor.added.set(object.id, clone(object));
    else if (object.original && JSON.stringify(relevantObjectState(object)) === JSON.stringify(object.original)) {
      documentEditor.changes.delete(object.id);
    } else {
      documentEditor.changes.set(object.id, clone(object));
    }
    const index = documentEditor.currentObjects.findIndex((item) => item.id === object.id);
    if (index >= 0) documentEditor.currentObjects[index] = clone(object);
  }

  function preserveEditableParagraphs(event) {
    const content = event.target.closest?.('.document-text-content[contenteditable="true"]');
    if (!content) return;
    queueMicrotask(() => {
      const documentEditor = window.LuminaDocumentEditor?.state;
      const objectId = content.closest('[data-object-id]')?.dataset.objectId;
      const object = documentEditor?.currentObjects.find((item) => item.id === objectId)
        || documentEditor?.added.get(objectId)
        || documentEditor?.changes.get(objectId);
      if (!object) return;
      const text = String(content.innerText ?? content.textContent ?? '')
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ');
      storeParagraphText(object, text);
    });
  }

  async function replaceSourceDocumentBytesAcrossPageCounts(documentState, bytes) {
    if (!documentState) throw new Error('The source PDF is no longer available.');
    const previousPageCount = Number(documentState.pdfjs?.numPages || 0);
    const nextPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const nextPageCount = Number(nextPdf.numPages || 0);

    documentState.bytes = bytes;
    documentState.size = bytes.byteLength;
    documentState.pdfjs = nextPdf;
    documentState.textCache = {};
    nativeEngine.analysisByDocument.delete(documentState.id);

    const documentEditor = window.LuminaDocumentEditor?.state;
    if (documentEditor?.layoutCache) {
      for (const key of [...documentEditor.layoutCache.keys()]) {
        if (String(key).startsWith(`${documentState.id}:`)) documentEditor.layoutCache.delete(key);
      }
    }

    if (nextPageCount < previousPageCount) {
      state.pages = state.pages.filter((page) => page.docId !== documentState.id || page.sourceIndex < nextPageCount);
    } else if (nextPageCount > previousPageCount) {
      let insertionIndex = state.pages.reduce(
        (last, page, index) => page.docId === documentState.id ? index : last,
        -1,
      ) + 1;
      for (let sourceIndex = previousPageCount; sourceIndex < nextPageCount; sourceIndex += 1) {
        const alreadyPresent = state.pages.some((page) => page.docId === documentState.id && page.sourceIndex === sourceIndex);
        if (alreadyPresent) continue;
        state.pages.splice(insertionIndex, 0, {
          id: uid('page'),
          docId: documentState.id,
          sourceIndex,
          rotation: 0,
          annotations: [],
        });
        insertionIndex += 1;
      }
    }

    state.activePageIndex = clamp(state.activePageIndex, 0, Math.max(0, state.pages.length - 1));
    state.selectedPageIds = new Set(
      [...state.selectedPageIds].filter((pageId) => state.pages.some((page) => page.id === pageId)),
    );
    await refreshWorkspace();
    return documentState;
  }

  document.addEventListener('input', preserveEditableParagraphs);
  replaceSourceDocumentBytes = replaceSourceDocumentBytesAcrossPageCounts;
  window.__luminaFlexibleRevisionReplacement = true;
  window.LuminaFlexibleRevisionReplacement = {
    version: '1.1.0',
    replace: replaceSourceDocumentBytesAcrossPageCounts,
    preserveEditableParagraphs,
  };
})();
