async function refreshWorkspace() {
  renderDocumentStrip();
  updateUI();
  await renderThumbnails();
  await renderCurrentPage();
}

async function renderCurrentPage() {
  const pageState = activePage();
  const doc = activeDocument();
  if (!pageState || !doc) {
    updateUI();
    return;
  }
  if (state.renderTask) {
    try { state.renderTask.cancel(); } catch (_) { /* no-op */ }
  }
  const page = await doc.pdfjs.getPage(pageState.sourceIndex + 1);
  const viewport = page.getViewport({ scale: state.zoom, rotation: ((page.rotate || 0) + pageState.rotation) % 360 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  el.canvas.width = Math.floor(viewport.width * ratio);
  el.canvas.height = Math.floor(viewport.height * ratio);
  el.canvas.style.width = `${viewport.width}px`;
  el.canvas.style.height = `${viewport.height}px`;
  el.pageStage.style.width = `${viewport.width}px`;
  el.pageStage.style.height = `${viewport.height}px`;
  const context = el.canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  state.renderTask = page.render({ canvasContext: context, viewport });
  try {
    await state.renderTask.promise;
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') console.error(error);
  }
  renderAnnotations();
  updateUI();
}

function annotationBounds(annotation) {
  if (annotation.type === 'draw') {
    const xs = annotation.points.map((p) => p.x);
    const ys = annotation.points.map((p) => p.y);
    const x = Math.min(...xs); const y = Math.min(...ys);
    return { x, y, width: Math.max(.02, Math.max(...xs) - x), height: Math.max(.02, Math.max(...ys) - y) };
  }
  if (annotation.type === 'comment') return { x: annotation.x - .016, y: annotation.y - .02, width: .038, height: .05 };
  return { x: annotation.x, y: annotation.y, width: annotation.width || .22, height: annotation.height || .06 };
}

function renderAnnotations() {
  const page = activePage();
  if (!page) {
    el.annotationLayer.innerHTML = '';
    return;
  }
  const all = [...page.annotations];
  if (state.draft && state.draft.pageId === page.id) all.push({ ...state.draft.annotation, id: '__draft__' });
  el.annotationLayer.innerHTML = all.map((annotation) => annotationMarkup(annotation, annotation.id === state.selectedAnnotationId)).join('');
}

function annotationMarkup(annotation, selected) {
  const opacity = annotation.opacity ?? 1;
  const color = annotation.color || '#5d42e8';
  const bounds = annotationBounds(annotation);
  const x = bounds.x * 1000; const y = bounds.y * 1000; const w = bounds.width * 1000; const h = bounds.height * 1000;
  let content = '';
  if (annotation.type === 'highlight') {
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${color}" opacity="${opacity * .42}" />`;
  } else if (annotation.type === 'whiteout') {
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" opacity="${opacity}" stroke="#d4d5db" stroke-width="1" vector-effect="non-scaling-stroke" />`;
  } else if (annotation.type === 'rectangle') {
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="none" stroke="${color}" stroke-width="${annotation.strokeWidth || 3}" opacity="${opacity}" vector-effect="non-scaling-stroke" />`;
  } else if (annotation.type === 'draw') {
    const points = annotation.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ');
    content = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${annotation.width || 4}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`;
  } else if (annotation.type === 'text') {
    content = `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="annotation-text" style="font-size:${annotation.size || 18}px;color:${color};opacity:${opacity};">${escapeHtml(annotation.text).replace(/\n/g, '<br>')}</div></foreignObject>`;
  } else if (annotation.type === 'comment') {
    const cx = annotation.x * 1000; const cy = annotation.y * 1000;
    content = `<g class="comment-badge"><circle cx="${cx}" cy="${cy}" r="18" fill="${color}" opacity="${opacity}"/><path d="M${cx - 7} ${cy - 4}h14M${cx - 7} ${cy + 2}h10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></g>`;
  } else if (annotation.type === 'image') {
    content = `<image href="${annotation.dataUrl}" x="${x}" y="${y}" width="${w}" height="${h}" opacity="${opacity}" preserveAspectRatio="none" />`;
  }
  if (annotation.id === '__draft__') return `<g>${content}</g>`;
  const selection = `<rect class="selection-box" x="${x - 5}" y="${y - 5}" width="${w + 10}" height="${h + 10}"/><rect class="resize-handle" data-resize="true" x="${x + w - 9}" y="${y + h - 9}" width="18" height="18" rx="3"/>`;
  return `<g class="annotation-object${selected ? ' selected' : ''}" data-annotation-id="${annotation.id}">${content}${selection}</g>`;
}

async function renderThumbnails() {
  el.thumbnailList.innerHTML = state.pages.map((page, index) => {
    const doc = state.documents.get(page.docId);
    return `<div class="thumbnail-card${index === state.activePageIndex ? ' active' : ''}${state.selectedPageIds.has(page.id) ? ' selected' : ''}" draggable="true" data-page-id="${page.id}" data-page-index="${index}">
      <div class="thumbnail-drag"><i data-lucide="grip-vertical"></i></div>
      <div class="thumbnail-canvas-wrap"><canvas id="thumb-${page.id}"></canvas></div>
      <div class="thumbnail-meta"><b>${index + 1}</b><span class="thumbnail-source" title="${escapeHtml(doc?.name || '')}">${escapeHtml(doc?.name || '')}</span></div>
    </div>`;
  }).join('');
  icons();
  bindThumbnailEvents();
  for (let index = 0; index < state.pages.length; index += 1) {
    const pageState = state.pages[index];
    const canvas = document.getElementById(`thumb-${pageState.id}`);
    const doc = state.documents.get(pageState.docId);
    if (!canvas || !doc) continue;
    try {
      const page = await doc.pdfjs.getPage(pageState.sourceIndex + 1);
      const rotation = ((page.rotate || 0) + pageState.rotation) % 360;
      const unscaled = page.getViewport({ scale: 1, rotation });
      const scale = 118 / unscaled.width;
      const viewport = page.getViewport({ scale, rotation });
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
    } catch (error) {
      console.warn('Thumbnail render failed', error);
    }
  }
}

function bindThumbnailEvents() {
  $$('.thumbnail-card').forEach((card) => {
    card.addEventListener('click', async (event) => {
      const index = Number(card.dataset.pageIndex);
      selectPage(index, event);
      await renderCurrentPage();
      await renderThumbnails();
    });
    card.addEventListener('dragstart', (event) => {
      state.dragPageId = card.dataset.pageId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', state.dragPageId);
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('drop', async (event) => {
      event.preventDefault();
      const draggedId = state.dragPageId || event.dataTransfer.getData('text/plain');
      const targetId = card.dataset.pageId;
      if (!draggedId || draggedId === targetId) return;
      const from = state.pages.findIndex((page) => page.id === draggedId);
      const to = state.pages.findIndex((page) => page.id === targetId);
      if (from < 0 || to < 0) return;
      pushHistory();
      const [moved] = state.pages.splice(from, 1);
      state.pages.splice(to, 0, moved);
      state.activePageIndex = state.pages.findIndex((page) => page.id === moved.id);
      await refreshWorkspace();
    });
  });
}

function selectPage(index, event = {}) {
  if (index < 0 || index >= state.pages.length) return;
  const id = state.pages[index].id;
  if (event.shiftKey && state.lastSelectedPageIndex !== null) {
    const start = Math.min(state.lastSelectedPageIndex, index);
    const end = Math.max(state.lastSelectedPageIndex, index);
    state.selectedPageIds = new Set(state.pages.slice(start, end + 1).map((page) => page.id));
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selectedPageIds.has(id)) state.selectedPageIds.delete(id); else state.selectedPageIds.add(id);
    state.lastSelectedPageIndex = index;
  } else {
    state.selectedPageIds = new Set([id]);
    state.lastSelectedPageIndex = index;
  }
  state.activePageIndex = index;
  state.selectedAnnotationId = null;
  updateUI();
}

async function setPage(index) {
  if (!state.pages.length) return;
  state.activePageIndex = clamp(index, 0, state.pages.length - 1);
  state.selectedPageIds = new Set([activePage().id]);
  state.lastSelectedPageIndex = state.activePageIndex;
  state.selectedAnnotationId = null;
  await renderCurrentPage();
  await renderThumbnails();
}

async function fitPage() {
  const pageState = activePage();
  const doc = activeDocument();
  if (!pageState || !doc || el.viewport.classList.contains('hidden')) return;
  const page = await doc.pdfjs.getPage(pageState.sourceIndex + 1);
  const viewport = page.getViewport({ scale: 1, rotation: ((page.rotate || 0) + pageState.rotation) % 360 });
  const availableWidth = Math.max(260, el.viewport.clientWidth - 110);
  const availableHeight = Math.max(300, el.viewport.clientHeight - 165);
  state.zoom = clamp(Math.min(availableWidth / viewport.width, availableHeight / viewport.height), .35, 2.4);
  await renderCurrentPage();
}

function normalizedPoint(event) {
  const rect = el.pageStage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function findAnnotationByTarget(target) {
  const group = target.closest?.('[data-annotation-id]');
  if (!group) return null;
  return activePage()?.annotations.find((item) => item.id === group.dataset.annotationId) || null;
}

function handlePointerDown(event) {
  if (!activePage()) return;
  const point = normalizedPoint(event);
  if (state.tool === 'hand') {
    state.interaction = { type: 'pan', startX: event.clientX, startY: event.clientY, scrollLeft: el.viewport.scrollLeft, scrollTop: el.viewport.scrollTop };
    el.pageStage.setPointerCapture(event.pointerId);
    return;
  }
  if (state.tool === 'select') {
    const annotation = findAnnotationByTarget(event.target);
    if (!annotation) {
      state.selectedAnnotationId = null;
      renderAnnotations();
      updateUI();
      return;
    }
    state.selectedAnnotationId = annotation.id;
    pushHistory();
    const isResize = event.target.matches?.('[data-resize]');
    state.interaction = {
      type: isResize ? 'resize' : 'drag',
      annotationId: annotation.id,
      start: point,
      original: deepClone(annotation),
    };
    el.pageStage.setPointerCapture(event.pointerId);
    renderAnnotations();
    updateUI();
    return;
  }
  if (state.tool === 'text') {
    const text = window.prompt('Text to place on this page:');
    if (!text) return;
    pushHistory();
    activePage().annotations.push({ id: uid('ann'), type: 'text', x: point.x, y: point.y, width: .32, height: .1, text, size: 18, color: '#111318', opacity: 1 });
    state.selectedAnnotationId = activePage().annotations.at(-1).id;
    state.tool = 'select';
    renderAnnotations(); updateUI();
    return;
  }
  if (state.tool === 'comment') {
    const text = window.prompt('Comment:');
    if (!text) return;
    pushHistory();
    activePage().annotations.push({ id: uid('ann'), type: 'comment', x: point.x, y: point.y, text, color: '#5d42e8', opacity: 1 });
    state.selectedAnnotationId = activePage().annotations.at(-1).id;
    state.tool = 'select';
    renderAnnotations(); updateUI();
    return;
  }
  if (state.tool === 'image' && state.pendingImage) {
    pushHistory();
    const width = .28;
    const height = width / state.pendingImage.aspect;
    activePage().annotations.push({ id: uid('ann'), type: 'image', x: clamp(point.x - width / 2, 0, 1 - width), y: clamp(point.y - height / 2, 0, 1 - height), width, height, dataUrl: state.pendingImage.dataUrl, opacity: 1 });
    state.selectedAnnotationId = activePage().annotations.at(-1).id;
    state.pendingImage = null;
    state.tool = 'select';
    renderAnnotations(); updateUI();
    return;
  }
  if (state.tool === 'draw') {
    state.interaction = { type: 'draw' };
    state.draft = { pageId: activePage().id, annotation: { type: 'draw', points: [point], width: 4, color: '#ef476f', opacity: 1 } };
    el.pageStage.setPointerCapture(event.pointerId);
    renderAnnotations();
    return;
  }
  if (['highlight', 'whiteout', 'rectangle'].includes(state.tool)) {
    state.interaction = { type: 'box', start: point };
    state.draft = { pageId: activePage().id, annotation: { type: state.tool, x: point.x, y: point.y, width: 0, height: 0, strokeWidth: state.tool === 'rectangle' ? 3 : undefined, color: state.tool === 'highlight' ? '#f3c623' : '#5d42e8', opacity: 1 } };
    el.pageStage.setPointerCapture(event.pointerId);
    renderAnnotations();
  }
}

function handlePointerMove(event) {
  if (!state.interaction || !activePage()) return;
  if (state.interaction.type === 'pan') {
    el.viewport.scrollLeft = state.interaction.scrollLeft - (event.clientX - state.interaction.startX);
    el.viewport.scrollTop = state.interaction.scrollTop - (event.clientY - state.interaction.startY);
    return;
  }
  const point = normalizedPoint(event);
  if (state.interaction.type === 'drag' || state.interaction.type === 'resize') {
    const annotation = activePage().annotations.find((item) => item.id === state.interaction.annotationId);
    if (!annotation) return;
    const original = state.interaction.original;
    const dx = point.x - state.interaction.start.x;
    const dy = point.y - state.interaction.start.y;
    if (state.interaction.type === 'drag') {
      if (annotation.type === 'draw') {
        annotation.points = original.points.map((p) => ({ x: clamp(p.x + dx, 0, 1), y: clamp(p.y + dy, 0, 1) }));
      } else {
        const bounds = annotationBounds(original);
        annotation.x = clamp(original.x + dx, annotation.type === 'comment' ? .02 : 0, 1 - Math.min(bounds.width, .98));
        annotation.y = clamp(original.y + dy, annotation.type === 'comment' ? .02 : 0, 1 - Math.min(bounds.height, .98));
      }
    } else if (!['draw', 'comment'].includes(annotation.type)) {
      annotation.width = clamp((original.width || .2) + dx, .025, 1 - original.x);
      annotation.height = clamp((original.height || .06) + dy, .02, 1 - original.y);
    }
    renderAnnotations();
    syncInspector();
    return;
  }
  if (state.interaction.type === 'draw' && state.draft) {
    state.draft.annotation.points.push(point);
    renderAnnotations();
    return;
  }
  if (state.interaction.type === 'box' && state.draft) {
    const start = state.interaction.start;
    state.draft.annotation.x = Math.min(start.x, point.x);
    state.draft.annotation.y = Math.min(start.y, point.y);
    state.draft.annotation.width = Math.abs(point.x - start.x);
    state.draft.annotation.height = Math.abs(point.y - start.y);
    renderAnnotations();
  }
}

function handlePointerUp(event) {
  if (!state.interaction) return;
  if (['draw', 'box'].includes(state.interaction.type) && state.draft) {
    const draft = state.draft.annotation;
    const valid = draft.type === 'draw' ? draft.points.length > 2 : draft.width > .008 && draft.height > .008;
    if (valid) {
      pushHistory();
      const annotation = { ...draft, id: uid('ann') };
      activePage().annotations.push(annotation);
      state.selectedAnnotationId = annotation.id;
      state.tool = 'select';
    }
    state.draft = null;
  }
  state.interaction = null;
  try { el.pageStage.releasePointerCapture(event.pointerId); } catch (_) { /* no-op */ }
  renderAnnotations();
  updateUI();
}
