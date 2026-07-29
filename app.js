function bindEvents() {
  const openPdfPicker = () => el.pdfInput.click();
  $('#welcome-open').addEventListener('click', openPdfPicker);
  $('#add-pdfs-button').addEventListener('click', openPdfPicker);
  $('#merge-button').addEventListener('click', openPdfPicker);
  el.pdfInput.addEventListener('change', () => importPdfFiles(el.pdfInput.files));
  $('#sample-button').addEventListener('click', createSample);
  $('#add-blank-button').addEventListener('click', addBlankPage);
  el.workspaceName.addEventListener('change', saveWorkspaceName);

  el.exportButton.addEventListener('click', () => exportPdf());
  el.exportSelectedButton.addEventListener('click', () => exportPdf([...state.selectedPageIds], 'selected-pages'));
  el.undoButton.addEventListener('click', undo);
  el.redoButton.addEventListener('click', redo);

  $$('.tool[data-tool]').forEach((button) => button.addEventListener('click', () => {
    state.tool = button.dataset.tool;
    state.pendingImage = null;
    updateUI();
  }));
  $('#image-tool').addEventListener('click', () => el.imageInput.click());
  el.imageInput.addEventListener('change', () => {
    const file = el.imageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        state.pendingImage = { dataUrl: reader.result, aspect: image.width / image.height };
        state.tool = 'image';
        updateUI();
        flash('Click the page to place the image');
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
    el.imageInput.value = '';
  });

  el.pageStage.addEventListener('pointerdown', handlePointerDown);
  el.pageStage.addEventListener('pointermove', handlePointerMove);
  el.pageStage.addEventListener('pointerup', handlePointerUp);
  el.pageStage.addEventListener('pointercancel', handlePointerUp);
  el.pageStage.addEventListener('dblclick', (event) => {
    const annotation = findAnnotationByTarget(event.target);
    if (!annotation || !['text', 'comment'].includes(annotation.type)) return;
    const next = window.prompt(annotation.type === 'text' ? 'Edit text:' : 'Edit comment:', annotation.text || '');
    if (next === null) return;
    mutateSelectedAnnotation((selected) => { selected.text = next; });
  });

  $('#delete-annotation').addEventListener('click', deleteSelectedAnnotation);
  el.annotationText.addEventListener('change', () => mutateSelectedAnnotation((annotation) => { annotation.text = el.annotationText.value; }));
  el.fontSize.addEventListener('change', () => mutateSelectedAnnotation((annotation) => { annotation.size = clamp(Number(el.fontSize.value) || 18, 6, 96); }));
  el.annotationOpacity.addEventListener('change', () => mutateSelectedAnnotation((annotation) => { annotation.opacity = clamp(Number(el.annotationOpacity.value) || 1, .1, 1); }));
  el.annotationWidth.addEventListener('change', () => mutateSelectedAnnotation((annotation) => {
    if (annotation.type === 'draw') annotation.width = clamp(Number(el.annotationWidth.value) || 4, 1, 30);
    if (annotation.type === 'rectangle') annotation.strokeWidth = clamp(Number(el.annotationWidth.value) || 3, 1, 30);
  }));
  el.annotationLayerOrder.addEventListener('change', () => {
    const page = activePage(); const annotation = selectedAnnotation();
    if (!page || !annotation) return;
    pushHistory();
    page.annotations = page.annotations.filter((item) => item.id !== annotation.id);
    if (el.annotationLayerOrder.value === 'back') page.annotations.unshift(annotation); else page.annotations.push(annotation);
    renderAnnotations();
  });
  $$('#color-row button').forEach((button) => button.addEventListener('click', () => mutateSelectedAnnotation((annotation) => { annotation.color = button.dataset.color; })));

  $('#prev-page').addEventListener('click', () => setPage(state.activePageIndex - 1));
  $('#next-page').addEventListener('click', () => setPage(state.activePageIndex + 1));
  el.pageInput.addEventListener('change', () => setPage(Number(el.pageInput.value) - 1));
  $('#zoom-out').addEventListener('click', async () => { state.zoom = clamp(state.zoom - .12, .35, 3); await renderCurrentPage(); });
  $('#zoom-in').addEventListener('click', async () => { state.zoom = clamp(state.zoom + .12, .35, 3); await renderCurrentPage(); });
  $('#fit-button').addEventListener('click', fitPage);
  el.zoomLabel.addEventListener('click', fitPage);

  $('#rotate-left').addEventListener('click', () => rotatePage(-90));
  $('#rotate-right').addEventListener('click', () => rotatePage(90));
  $('#duplicate-page').addEventListener('click', duplicatePage);
  $('#delete-page').addEventListener('click', () => deletePage());
  $('#move-up').addEventListener('click', () => movePage(-1));
  $('#move-down').addEventListener('click', () => movePage(1));

  $('#search-button').addEventListener('click', () => { el.searchPopover.classList.toggle('hidden'); if (!el.searchPopover.classList.contains('hidden')) el.searchInput.focus(); });
  $('#close-search').addEventListener('click', () => el.searchPopover.classList.add('hidden'));
  $('#run-search').addEventListener('click', runSearch);
  el.searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(); });

  $$('.right-tabs button').forEach((button) => button.addEventListener('click', () => setRightTab(button.dataset.rightTab)));
  $('#ai-button').addEventListener('click', () => setRightTab('ai'));
  $('#ai-settings').addEventListener('click', openAIModal);
  const cancelAISettings = () => { aiConfig = loadAIConfig(); el.aiModal.classList.add('hidden'); updateAIStatus(); };
  $('#close-ai-modal').addEventListener('click', cancelAISettings);
  $('#cancel-ai-settings').addEventListener('click', cancelAISettings);
  $$('#provider-grid button').forEach((button) => button.addEventListener('click', () => selectProvider(button.dataset.provider)));
  $('#save-ai-settings').addEventListener('click', saveAISettings);
  $('#test-ai').addEventListener('click', testAIConnection);
  $('#send-ai').addEventListener('click', () => sendAIMessage());
  el.aiPrompt.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') sendAIMessage(); });
  $('#ai-context-button').addEventListener('click', () => {
    state.aiUseDocument = !state.aiUseDocument;
    $('#ai-context-button').classList.toggle('primary', state.aiUseDocument);
    $('#ai-context-button').classList.toggle('ghost', !state.aiUseDocument);
    flash(state.aiUseDocument ? 'Document context enabled' : 'Document context disabled');
  });

  window.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'o') { event.preventDefault(); openPdfPicker(); }
    if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); el.searchPopover.classList.remove('hidden'); el.searchInput.focus(); }
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (event.key === 'Delete' && !typing && state.selectedAnnotationId) deleteSelectedAnnotation();
    if (!typing) {
      const shortcuts = { v: 'select', h: 'hand', t: 'text', m: 'highlight', p: 'draw', c: 'comment' };
      const tool = shortcuts[event.key.toLowerCase()];
      if (tool) { state.tool = tool; updateUI(); }
      if (event.key === 'ArrowLeft' && !modifier) setPage(state.activePageIndex - 1);
      if (event.key === 'ArrowRight' && !modifier) setPage(state.activePageIndex + 1);
    }
  });

  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    el.dropOverlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth -= 1;
    if (dragDepth <= 0) { dragDepth = 0; el.dropOverlay.classList.add('hidden'); }
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    el.dropOverlay.classList.add('hidden');
    importPdfFiles(event.dataTransfer.files);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.pages.length) fitPage(); }, 160);
  });
}

function init() {
  el.workspaceName.value = localStorage.getItem('lumina-workspace-name') || 'Untitled workspace';
  bindEvents();
  updateUI();
  updateAIStatus();
  icons();
}

aiConfig = loadAIConfig();
init();

const documentEditScript = document.createElement('script');
documentEditScript.src = './js/document-edit.js';
documentEditScript.async = false;
documentEditScript.onerror = () => flash('Document edit mode could not be loaded');
documentEditScript.onload = () => {
  const interactionFixScript = document.createElement('script');
  interactionFixScript.src = './js/document-edit-interaction-fix.js';
  interactionFixScript.async = false;
  interactionFixScript.onerror = () => flash('Inline document editing could not be initialised');
  interactionFixScript.onload = () => {
    const transactionScript = document.createElement('script');
    transactionScript.src = './js/document-edit-transactions.js';
    transactionScript.async = false;
    transactionScript.onerror = () => flash('Transactional document editing could not be initialised');
    transactionScript.onload = () => {
      const revisionScript = document.createElement('script');
      revisionScript.src = './js/document-revision-flex.js';
      revisionScript.async = false;
      revisionScript.onerror = () => flash('Saved PDF revision handling could not be initialised');
      document.head.appendChild(revisionScript);
    };
    document.head.appendChild(transactionScript);
  };
  document.head.appendChild(interactionFixScript);
};
document.head.appendChild(documentEditScript);
