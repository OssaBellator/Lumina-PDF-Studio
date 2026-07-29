(function () {
  'use strict';

  if (typeof replaceSourceDocumentBytes !== 'function' || window.__luminaFlexibleRevisionReplacement) return;

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

  replaceSourceDocumentBytes = replaceSourceDocumentBytesAcrossPageCounts;
  window.__luminaFlexibleRevisionReplacement = true;
  window.LuminaFlexibleRevisionReplacement = {
    version: '1.0.0',
    replace: replaceSourceDocumentBytesAcrossPageCounts,
  };
})();
