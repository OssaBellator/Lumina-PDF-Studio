/* global pdfjsLib, PDFLib, lucide */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deepClone = (value) => structuredClone(value);

const state = {
  documents: new Map(),
  pages: [],
  activePageIndex: 0,
  selectedPageIds: new Set(),
  lastSelectedPageIndex: null,
  zoom: 1.15,
  tool: 'select',
  selectedAnnotationId: null,
  history: [],
  future: [],
  renderTask: null,
  dragPageId: null,
  interaction: null,
  draft: null,
  pendingImage: null,
  aiUseDocument: true,
  pendingAIActions: [],
  aiConversation: [],
};

const providerDefaults = {
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  openai: { label: 'OpenAI / Codex', baseUrl: 'https://api.openai.com/v1', model: '' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '' },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '' },
  custom: { label: 'Custom provider', baseUrl: '', model: '' },
};

const defaultAIConfig = {
  provider: 'openrouter',
  baseUrl: providerDefaults.openrouter.baseUrl,
  model: '',
  permissions: {
    read_document: true,
    add_content: true,
    organize_pages: true,
    delete_pages: false,
    export_pdf: false,
  },
};

let aiConfig;

const el = {
  workspaceName: $('#workspace-name'),
  saveState: $('#save-state'),
  pdfInput: $('#pdf-input'),
  imageInput: $('#image-input'),
  welcome: $('#welcome'),
  viewport: $('#viewport'),
  pageStage: $('#page-stage'),
  canvas: $('#pdf-canvas'),
  annotationLayer: $('#annotation-layer'),
  bottomBar: $('#bottom-bar'),
  thumbnailList: $('#thumbnail-list'),
  documentStrip: $('#document-strip'),
  pageCountLabel: $('#page-count-label'),
  pageInput: $('#page-input'),
  pageTotal: $('#page-total'),
  zoomLabel: $('#zoom-label'),
  exportButton: $('#export-button'),
  exportSelectedButton: $('#export-selected-button'),
  undoButton: $('#undo-button'),
  redoButton: $('#redo-button'),
  searchPopover: $('#search-popover'),
  searchInput: $('#search-input'),
  searchResults: $('#search-results'),
  loadingOverlay: $('#loading-overlay'),
  loadingLabel: $('#loading-label'),
  dropOverlay: $('#drop-overlay'),
  toast: $('#toast'),
  rightPanel: $('#right-panel'),
  emptyInspector: $('#empty-inspector'),
  annotationInspector: $('#annotation-inspector'),
  selectedType: $('#selected-type'),
  annotationText: $('#annotation-text'),
  fontSize: $('#font-size'),
  annotationOpacity: $('#annotation-opacity'),
  annotationWidth: $('#annotation-width'),
  annotationLayerOrder: $('#annotation-layer-order'),
  textControls: $('#text-controls'),
  pageSourceName: $('#page-source-name'),
  pageSourceMeta: $('#page-source-meta'),
  aiModal: $('#ai-modal'),
  providerGrid: $('#provider-grid'),
  aiBaseUrl: $('#ai-base-url'),
  aiModel: $('#ai-model'),
  aiKey: $('#ai-key'),
  connectionResult: $('#connection-result'),
  providerLabel: $('#provider-label'),
  modelLabel: $('#model-label'),
  aiChat: $('#ai-chat'),
  aiPrompt: $('#ai-prompt'),
  actionQueue: $('#action-queue'),
};

function icons() {
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function hexToRgb(hex) {
  const clean = String(hex || '#111318').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function activePage() {
  return state.pages[state.activePageIndex] || null;
}

function activeDocument() {
  const page = activePage();
  return page ? state.documents.get(page.docId) : null;
}

function selectedAnnotation() {
  return activePage()?.annotations.find((item) => item.id === state.selectedAnnotationId) || null;
}

let toastTimer;
function flash(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2400);
}

function setLoading(on, label = 'Working…') {
  el.loadingLabel.textContent = label;
  el.loadingOverlay.classList.toggle('hidden', !on);
}

function saveWorkspaceName() {
  localStorage.setItem('lumina-workspace-name', el.workspaceName.value.trim() || 'Untitled workspace');
  el.saveState.textContent = 'Name saved locally';
  setTimeout(() => { el.saveState.textContent = 'Local workspace'; }, 1200);
}

function snapshot() {
  return {
    pages: deepClone(state.pages),
    activePageIndex: state.activePageIndex,
    selectedPageIds: [...state.selectedPageIds],
  };
}

function pushHistory() {
  state.history.push(snapshot());
  state.history = state.history.slice(-40);
  state.future = [];
}

async function restoreSnapshot(value) {
  state.pages = deepClone(value.pages);
  state.activePageIndex = clamp(value.activePageIndex, 0, Math.max(0, state.pages.length - 1));
  state.selectedPageIds = new Set(value.selectedPageIds.filter((id) => state.pages.some((page) => page.id === id)));
  state.selectedAnnotationId = null;
  await refreshWorkspace();
}

async function undo() {
  if (!state.history.length) return;
  state.future.unshift(snapshot());
  await restoreSnapshot(state.history.pop());
}

async function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  await restoreSnapshot(state.future.shift());
}

function updateUI() {
  const hasPages = state.pages.length > 0;
  el.welcome.classList.toggle('hidden', hasPages);
  el.viewport.classList.toggle('hidden', !hasPages);
  el.bottomBar.classList.toggle('hidden', !hasPages);
  el.exportButton.disabled = !hasPages;
  el.exportSelectedButton.disabled = !state.selectedPageIds.size;
  el.undoButton.disabled = !state.history.length;
  el.redoButton.disabled = !state.future.length;
  el.pageCountLabel.textContent = `${state.pages.length} page${state.pages.length === 1 ? '' : 's'}`;
  el.pageInput.value = hasPages ? String(state.activePageIndex + 1) : '1';
  el.pageTotal.textContent = `/ ${state.pages.length}`;
  el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  $$('.tool[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === state.tool));
  el.pageStage.className = `page-stage tool-${state.tool}`;
  const page = activePage();
  const doc = activeDocument();
  el.pageSourceName.textContent = doc?.name || 'No document';
  el.pageSourceMeta.textContent = page ? `Source page ${page.sourceIndex + 1} · ${page.rotation || 0}°` : '';
  syncInspector();
  updateAIStatus();
  icons();
}

function renderDocumentStrip() {
  const counts = new Map();
  state.pages.forEach((page) => counts.set(page.docId, (counts.get(page.docId) || 0) + 1));
  el.documentStrip.innerHTML = [...state.documents.values()]
    .filter((doc) => counts.has(doc.id))
    .map((doc) => `<div class="document-chip" title="${escapeHtml(doc.name)}"><span class="dot"></span><span>${escapeHtml(doc.name)} · ${counts.get(doc.id)}</span></div>`)
    .join('');
}

async function importPdfFiles(fileList, { replace = false } = {}) {
  const files = [...fileList].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (!files.length) {
    flash('Choose one or more PDF files');
    return;
  }
  setLoading(true, files.length > 1 ? `Merging ${files.length} PDFs…` : 'Opening PDF…');
  try {
    if (replace && state.pages.length) pushHistory();
    if (replace) {
      state.pages = [];
      state.selectedPageIds.clear();
    } else if (state.pages.length) {
      pushHistory();
    }

    const imported = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const doc = {
        id: uid('doc'),
        name: file.name,
        size: file.size,
        bytes,
        pdfjs,
        textCache: {},
      };
      state.documents.set(doc.id, doc);
      for (let sourceIndex = 0; sourceIndex < pdfjs.numPages; sourceIndex += 1) {
        const page = { id: uid('page'), docId: doc.id, sourceIndex, rotation: 0, annotations: [] };
        state.pages.push(page);
        imported.push(page.id);
      }
    }
    state.activePageIndex = Math.max(0, state.pages.length - imported.length);
    state.selectedPageIds = new Set(imported.length ? [imported[0]] : []);
    state.lastSelectedPageIndex = state.activePageIndex;
    state.selectedAnnotationId = null;
    if (files.length === 1 && (!el.workspaceName.value || el.workspaceName.value === 'Untitled workspace')) {
      el.workspaceName.value = files[0].name.replace(/\.pdf$/i, '');
    } else if (files.length > 1 && el.workspaceName.value === 'Untitled workspace') {
      el.workspaceName.value = 'Merged document';
    }
    await refreshWorkspace();
    requestAnimationFrame(fitPage);
    flash(`${imported.length} page${imported.length === 1 ? '' : 's'} added`);
  } catch (error) {
    console.error(error);
    flash('One of those PDFs could not be opened');
  } finally {
    setLoading(false);
    el.pdfInput.value = '';
  }
}

async function addBlankPage() {
  setLoading(true, 'Adding blank page…');
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const bytes = await pdf.save();
    const file = new File([bytes], `Blank page ${state.pages.length + 1}.pdf`, { type: 'application/pdf' });
    await importPdfFiles([file]);
  } finally {
    setLoading(false);
  }
}

async function createSample() {
  setLoading(true, 'Creating sample…');
  try {
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const first = pdf.addPage([612, 792]);
    first.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(.97, .97, .98) });
    first.drawText('LUMINA PDF STUDIO', { x: 56, y: 708, size: 12, font: bold, color: rgb(.36, .25, .91) });
    first.drawText('Documents should be easier to change.', { x: 56, y: 626, size: 31, font: bold, color: rgb(.08, .09, .12), maxWidth: 500 });
    first.drawText('Merge PDFs, edit directly on the page, and let your preferred AI propose useful changes without surrendering control.', { x: 56, y: 548, size: 15, font: regular, color: rgb(.32, .33, .39), maxWidth: 490, lineHeight: 23 });
    [['MERGE', 'Combine several source files into one page sequence.'], ['EDIT', 'Place text, whiteout, images, shapes, notes, and ink.'], ['REVIEW', 'Approve AI actions before they modify your document.']].forEach(([title, body], i) => {
      const y = 420 - i * 86;
      first.drawText(title, { x: 56, y, size: 11, font: bold, color: rgb(.36, .25, .91) });
      first.drawText(body, { x: 132, y, size: 13, font: regular, color: rgb(.2, .21, .25), maxWidth: 410 });
    });
    const second = pdf.addPage([612, 792]);
    second.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(.09, .1, .13) });
    second.drawText('TRY THE CANVAS TOOLS', { x: 56, y: 708, size: 11, font: bold, color: rgb(.68, .61, 1) });
    second.drawText('Select, move, resize, and export your additions.', { x: 56, y: 628, size: 29, font: bold, color: rgb(1, 1, 1), maxWidth: 500 });
    second.drawRectangle({ x: 56, y: 430, width: 500, height: 120, color: rgb(.15, .16, .2), borderColor: rgb(.29, .29, .36), borderWidth: 1 });
    second.drawText('Tip: use Whiteout plus Text to visually replace existing PDF content.', { x: 82, y: 490, size: 16, font: regular, color: rgb(.9, .9, .94), maxWidth: 440 });
    const bytes = await pdf.save();
    await importPdfFiles([new File([bytes], 'Lumina sample.pdf', { type: 'application/pdf' })], { replace: true });
  } finally {
    setLoading(false);
  }
}
