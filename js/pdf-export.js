function syncInspector() {
  const annotation = selectedAnnotation();
  el.emptyInspector.classList.toggle('hidden', Boolean(annotation));
  el.annotationInspector.classList.toggle('hidden', !annotation);
  if (!annotation) return;
  el.selectedType.textContent = annotation.type[0].toUpperCase() + annotation.type.slice(1);
  const hasText = ['text', 'comment'].includes(annotation.type);
  el.textControls.classList.toggle('hidden', !hasText);
  el.annotationText.value = annotation.text || '';
  el.fontSize.value = annotation.size || 18;
  el.annotationOpacity.value = annotation.opacity ?? 1;
  el.annotationWidth.value = annotation.type === 'draw' ? (annotation.width || 4) : annotation.type === 'rectangle' ? (annotation.strokeWidth || 3) : 4;
  $$('#color-row button').forEach((button) => button.classList.toggle('active', button.dataset.color.toLowerCase() === String(annotation.color || '').toLowerCase()));
}

function mutateSelectedAnnotation(mutator) {
  const annotation = selectedAnnotation();
  if (!annotation) return;
  pushHistory();
  mutator(annotation);
  renderAnnotations();
  updateUI();
}

function deleteSelectedAnnotation() {
  const page = activePage();
  if (!page || !state.selectedAnnotationId) return;
  pushHistory();
  page.annotations = page.annotations.filter((item) => item.id !== state.selectedAnnotationId);
  state.selectedAnnotationId = null;
  renderAnnotations();
  updateUI();
}

async function rotatePage(delta) {
  if (!activePage()) return;
  pushHistory();
  activePage().rotation = ((activePage().rotation + delta) % 360 + 360) % 360;
  await refreshWorkspace();
}

async function duplicatePage() {
  if (!activePage()) return;
  pushHistory();
  const copy = deepClone(activePage());
  copy.id = uid('page');
  copy.annotations.forEach((item) => { item.id = uid('ann'); });
  state.pages.splice(state.activePageIndex + 1, 0, copy);
  state.activePageIndex += 1;
  state.selectedPageIds = new Set([copy.id]);
  await refreshWorkspace();
}

async function deletePage(index = state.activePageIndex) {
  if (!state.pages[index]) return;
  if (!window.confirm(`Delete page ${index + 1}?`)) return;
  pushHistory();
  const [removed] = state.pages.splice(index, 1);
  state.selectedPageIds.delete(removed.id);
  state.activePageIndex = clamp(index, 0, Math.max(0, state.pages.length - 1));
  if (activePage()) state.selectedPageIds = new Set([activePage().id]);
  state.selectedAnnotationId = null;
  await refreshWorkspace();
}

async function movePage(delta) {
  const from = state.activePageIndex;
  const to = clamp(from + delta, 0, state.pages.length - 1);
  if (from === to) return;
  pushHistory();
  const [page] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, page);
  state.activePageIndex = to;
  await refreshWorkspace();
}

async function extractPageText(index) {
  const pageState = state.pages[index];
  const doc = pageState && state.documents.get(pageState.docId);
  if (!pageState || !doc) return '';
  if (Object.prototype.hasOwnProperty.call(doc.textCache, pageState.sourceIndex)) return doc.textCache[pageState.sourceIndex];
  const page = await doc.pdfjs.getPage(pageState.sourceIndex + 1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
  doc.textCache[pageState.sourceIndex] = text;
  return text;
}

async function runSearch() {
  const query = el.searchInput.value.trim();
  if (!query) return;
  el.searchResults.innerHTML = '<div class="search-empty">Searching…</div>';
  const matches = [];
  for (let index = 0; index < state.pages.length; index += 1) {
    const text = await extractPageText(index);
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at >= 0) {
      const start = Math.max(0, at - 70);
      const end = Math.min(text.length, at + query.length + 90);
      matches.push({ index, snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` });
    }
    if (matches.length >= 100) break;
  }
  el.searchResults.innerHTML = matches.length ? matches.map((match) => `<button class="search-result" data-index="${match.index}"><b>Page ${match.index + 1}</b><span>${escapeHtml(match.snippet)}</span></button>`).join('') : '<div class="search-empty">No matches. Scanned PDFs require OCR.</div>';
  $$('.search-result').forEach((button) => button.addEventListener('click', async () => {
    await setPage(Number(button.dataset.index));
    el.searchPopover.classList.add('hidden');
  }));
}

async function documentContext(maxCharacters = 24000) {
  if (!state.pages.length) return '';
  let context = '';
  for (let index = 0; index < state.pages.length; index += 1) {
    const text = await extractPageText(index);
    if (!text) continue;
    const chunk = `\n\n[Page ${index + 1}]\n${text}`;
    if (context.length + chunk.length > maxCharacters) {
      context += chunk.slice(0, Math.max(0, maxCharacters - context.length));
      break;
    }
    context += chunk;
  }
  return context.trim();
}

async function exportPdf(pageIds = state.pages.map((page) => page.id), filenameSuffix = 'lumina') {
  if (!pageIds.length) return;
  setLoading(true, 'Building PDF…');
  try {
    const output = await PDFDocument.create();
    const sourceDocs = new Map();
    const font = await output.embedFont(StandardFonts.Helvetica);
    const orderedPages = state.pages.filter((page) => pageIds.includes(page.id));
    for (const pageState of orderedPages) {
      if (!sourceDocs.has(pageState.docId)) {
        const doc = state.documents.get(pageState.docId);
        sourceDocs.set(pageState.docId, await PDFDocument.load(doc.bytes, { ignoreEncryption: true }));
      }
      const source = sourceDocs.get(pageState.docId);
      const [copied] = await output.copyPages(source, [pageState.sourceIndex]);
      output.addPage(copied);
      const baseRotation = copied.getRotation()?.angle || 0;
      copied.setRotation(degrees((baseRotation + pageState.rotation) % 360));
      const { width, height } = copied.getSize();
      for (const annotation of pageState.annotations) {
        const colorValue = hexToRgb(annotation.color);
        const color = rgb(colorValue.r, colorValue.g, colorValue.b);
        const opacity = annotation.opacity ?? 1;
        if (annotation.type === 'highlight' || annotation.type === 'whiteout') {
          copied.drawRectangle({
            x: annotation.x * width,
            y: height - (annotation.y + annotation.height) * height,
            width: annotation.width * width,
            height: annotation.height * height,
            color: annotation.type === 'whiteout' ? rgb(1, 1, 1) : color,
            opacity: annotation.type === 'highlight' ? opacity * .38 : opacity,
          });
        } else if (annotation.type === 'rectangle') {
          copied.drawRectangle({
            x: annotation.x * width,
            y: height - (annotation.y + annotation.height) * height,
            width: annotation.width * width,
            height: annotation.height * height,
            borderColor: color,
            borderWidth: annotation.strokeWidth || 2,
            opacity,
          });
        } else if (annotation.type === 'text') {
          copied.drawText(annotation.text || '', {
            x: annotation.x * width,
            y: height - annotation.y * height - (annotation.size || 18),
            size: annotation.size || 18,
            font,
            color,
            opacity,
            maxWidth: Math.max(30, annotation.width * width),
            lineHeight: (annotation.size || 18) * 1.2,
          });
        } else if (annotation.type === 'draw') {
          for (let i = 1; i < annotation.points.length; i += 1) {
            const from = annotation.points[i - 1];
            const to = annotation.points[i];
            copied.drawLine({
              start: { x: from.x * width, y: height - from.y * height },
              end: { x: to.x * width, y: height - to.y * height },
              thickness: annotation.width || 3,
              color,
              opacity,
            });
          }
        } else if (annotation.type === 'comment') {
          copied.drawCircle({ x: annotation.x * width, y: height - annotation.y * height, size: 8, color, opacity });
        } else if (annotation.type === 'image') {
          const imageBytes = dataUriToBytes(annotation.dataUrl);
          const embedded = annotation.dataUrl.startsWith('data:image/png') ? await output.embedPng(imageBytes) : await output.embedJpg(imageBytes);
          copied.drawImage(embedded, {
            x: annotation.x * width,
            y: height - (annotation.y + annotation.height) * height,
            width: annotation.width * width,
            height: annotation.height * height,
            opacity,
          });
        }
      }
    }
    const bytes = await output.save();
    const baseName = (el.workspaceName.value.trim() || 'document').replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-');
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-${filenameSuffix}.pdf`);
    flash('PDF exported');
  } catch (error) {
    console.error(error);
    flash('Export failed. Encrypted or unusual PDFs may need preprocessing.');
  } finally {
    setLoading(false);
  }
}

function dataUriToBytes(dataUri) {
  const base64 = dataUri.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1200);
}
