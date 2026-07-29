'use strict';

const nativeEngine = {
  available: false,
  health: null,
  analysisByDocument: new Map(),
  backupsByDocument: new Map(),
  busy: false,
};

function nativeEngineElements() {
  return {
    button: document.querySelector('#native-engine-button'),
    statusDot: document.querySelector('#native-engine-status-dot'),
    statusLabel: document.querySelector('#native-engine-status-label'),
    modal: document.querySelector('#native-engine-modal'),
    close: document.querySelector('#close-native-engine'),
    refresh: document.querySelector('#refresh-native-analysis'),
    restore: document.querySelector('#restore-native-source'),
    sourceName: document.querySelector('#native-source-name'),
    summary: document.querySelector('#native-analysis-summary'),
    signatureWarning: document.querySelector('#native-signature-warning'),
    search: document.querySelector('#native-search-text'),
    replacement: document.querySelector('#native-replacement-text'),
    scope: document.querySelector('#native-page-scope'),
    occurrence: document.querySelector('#native-occurrence'),
    replace: document.querySelector('#native-replace-button'),
    formList: document.querySelector('#native-form-list'),
    saveForms: document.querySelector('#native-save-forms'),
    report: document.querySelector('#native-operation-report'),
  };
}

function setNativeEngineStatus(mode, label) {
  const elements = nativeEngineElements();
  if (!elements.button) return;
  elements.button.dataset.engineStatus = mode;
  elements.statusLabel.textContent = label;
  elements.statusDot.className = `engine-status-dot ${mode}`;
}

async function checkNativeEngine() {
  setNativeEngineStatus('checking', 'Checking engine');
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const payload = await response.json();
    nativeEngine.available = Boolean(response.ok && payload.ok);
    nativeEngine.health = payload;
    setNativeEngineStatus(nativeEngine.available ? 'online' : 'offline', nativeEngine.available ? 'Native engine' : 'Browser mode');
  } catch (_) {
    nativeEngine.available = false;
    nativeEngine.health = null;
    setNativeEngineStatus('offline', 'Browser mode');
  }
  return nativeEngine.available;
}

function engineErrorMessage(payload, fallback = 'The native PDF engine could not complete this operation.') {
  return payload?.error?.message || fallback;
}

function currentSourceDocument() {
  if (typeof activeDocument !== 'function') return null;
  return activeDocument();
}

function currentSourcePage() {
  if (typeof activePage !== 'function') return null;
  return activePage();
}

function bytesToBase64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function analyzeDocumentNatively(documentState, force = false) {
  if (!documentState) throw new Error('Open a PDF first.');
  if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('The native engine is offline. Start Lumina with python3 server.py.');
  if (!force && nativeEngine.analysisByDocument.has(documentState.id)) return nativeEngine.analysisByDocument.get(documentState.id);

  const body = new FormData();
  body.append('file', new Blob([documentState.bytes], { type: 'application/pdf' }), documentState.name || 'document.pdf');
  const response = await fetch('/api/pdf/analyze', { method: 'POST', body });
  const payload = await response.json();
  if (!response.ok) throw new Error(engineErrorMessage(payload));
  nativeEngine.analysisByDocument.set(documentState.id, payload);
  return payload;
}

function renderNativeAnalysis(analysis) {
  const elements = nativeEngineElements();
  const formCount = analysis.formFields?.filter((field) => field.typeCode !== 6).length || 0;
  const signatureCount = analysis.signatures?.fields?.length || 0;
  elements.summary.innerHTML = `
    <div><b>${analysis.pageCount}</b><span>source pages</span></div>
    <div><b>${formCount}</b><span>form fields</span></div>
    <div><b>${signatureCount}</b><span>signature fields</span></div>
    <div><b>${analysis.repaired ? 'Yes' : 'No'}</b><span>repaired on open</span></div>`;

  const mutationWarning = Boolean(analysis.signatures?.mutationWarning);
  elements.signatureWarning.classList.toggle('hidden', !mutationWarning);
  elements.replace.disabled = mutationWarning;
  elements.saveForms.disabled = mutationWarning || formCount === 0;
  elements.restore.disabled = !(nativeEngine.backupsByDocument.get(currentSourceDocument()?.id)?.length);

  const editableFields = [...new Map((analysis.formFields || []).filter((field) => field.typeCode !== 6).map((field) => [field.name, field])).values()];
  if (!editableFields.length) {
    elements.formList.innerHTML = '<div class="native-empty">No editable AcroForm fields were found in this source PDF.</div>';
    return;
  }
  elements.formList.innerHTML = editableFields.map((field, index) => {
    const id = `native-field-${index}`;
    const disabled = field.readOnly ? 'disabled' : '';
    const common = `data-field-name="${escapeHtml(field.name)}" data-field-type="${field.typeCode}" ${disabled}`;
    let control = '';
    if ([2, 5].includes(field.typeCode)) {
      control = `<input id="${id}" type="checkbox" ${field.value && field.value !== 'Off' ? 'checked' : ''} ${common} />`;
    } else if ([3, 4].includes(field.typeCode) && field.choices?.length) {
      control = `<select id="${id}" ${common}>${field.choices.map((choice) => `<option ${String(choice) === String(field.value) ? 'selected' : ''}>${escapeHtml(choice)}</option>`).join('')}</select>`;
    } else {
      control = `<input id="${id}" value="${escapeHtml(field.value ?? '')}" ${common} />`;
    }
    return `<label class="native-form-field"><span>${escapeHtml(field.label || field.name)}<small>Page ${field.page + 1} · ${escapeHtml(field.type)}${field.readOnly ? ' · read-only' : ''}</small></span>${control}</label>`;
  }).join('');
}

async function openNativeEngineModal() {
  const elements = nativeEngineElements();
  const documentState = currentSourceDocument();
  const pageState = currentSourcePage();
  elements.modal.classList.remove('hidden');
  elements.report.textContent = '';
  elements.sourceName.textContent = documentState ? `${documentState.name} · source page ${(pageState?.sourceIndex ?? 0) + 1}` : 'No source document';
  if (!documentState) {
    elements.summary.innerHTML = '<div class="native-empty">Open a PDF to inspect native content and form fields.</div>';
    return;
  }
  try {
    elements.summary.innerHTML = '<div class="native-empty">Inspecting PDF structure…</div>';
    const analysis = await analyzeDocumentNatively(documentState);
    renderNativeAnalysis(analysis);
  } catch (error) {
    elements.summary.innerHTML = `<div class="native-empty danger-text">${escapeHtml(error.message)}</div>`;
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

async function replaceSourceDocumentBytes(documentState, bytes) {
  const previousPageCount = documentState.pdfjs.numPages;
  const nextPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  if (nextPdf.numPages !== previousPageCount) throw new Error('The native edit unexpectedly changed the source page count.');
  documentState.bytes = bytes;
  documentState.size = bytes.byteLength;
  documentState.pdfjs = nextPdf;
  documentState.textCache = {};
  nativeEngine.analysisByDocument.delete(documentState.id);
  if (typeof refreshWorkspace === 'function') await refreshWorkspace();
}

async function performNativeOperations(operations) {
  const documentState = currentSourceDocument();
  if (!documentState) throw new Error('Open a PDF first.');
  if (nativeEngine.busy) return null;
  nativeEngine.busy = true;
  setLoading(true, 'Applying native PDF edits…');
  try {
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
    await replaceSourceDocumentBytes(documentState, bytes);
    return payload.report;
  } finally {
    nativeEngine.busy = false;
    setLoading(false);
  }
}

async function runNativeTextReplacement() {
  const elements = nativeEngineElements();
  const pageState = currentSourcePage();
  const search = elements.search.value;
  if (!search.trim()) {
    flash('Enter text to find');
    elements.search.focus();
    return;
  }
  const operation = {
    type: 'replace_text',
    search,
    replacement: elements.replacement.value,
    pages: elements.scope.value === 'all' ? 'all' : [pageState.sourceIndex],
    occurrence: elements.occurrence.value,
    requireMatch: true,
  };
  try {
    const report = await performNativeOperations([operation]);
    const matches = report?.operations?.[0]?.matches ?? 0;
    elements.report.textContent = `${matches} text occurrence${matches === 1 ? '' : 's'} replaced in the source PDF.`;
    flash('Native text replacement applied');
    const analysis = await analyzeDocumentNatively(currentSourceDocument(), true);
    renderNativeAnalysis(analysis);
  } catch (error) {
    elements.report.textContent = error.message;
    flash('Native replacement failed');
  }
}

async function saveNativeFormFields() {
  const elements = nativeEngineElements();
  const controls = [...elements.formList.querySelectorAll('[data-field-name]:not(:disabled)')];
  const operations = controls.map((control) => ({
    type: 'set_form_field',
    name: control.dataset.fieldName,
    value: control.type === 'checkbox' ? control.checked : control.value,
  }));
  if (!operations.length) return;
  try {
    const report = await performNativeOperations(operations);
    elements.report.textContent = `${report?.operations?.length || operations.length} form field update${operations.length === 1 ? '' : 's'} written into the PDF.`;
    flash('Form fields updated');
    const analysis = await analyzeDocumentNatively(currentSourceDocument(), true);
    renderNativeAnalysis(analysis);
  } catch (error) {
    elements.report.textContent = error.message;
    flash('Form update failed');
  }
}

async function restoreNativeSource() {
  const elements = nativeEngineElements();
  const documentState = currentSourceDocument();
  const backups = documentState && nativeEngine.backupsByDocument.get(documentState.id);
  if (!documentState || !backups?.length || nativeEngine.busy) return;
  nativeEngine.busy = true;
  setLoading(true, 'Restoring source PDF…');
  try {
    const previous = backups.pop();
    nativeEngine.backupsByDocument.set(documentState.id, backups);
    await replaceSourceDocumentBytes(documentState, previous);
    const analysis = await analyzeDocumentNatively(documentState, true);
    renderNativeAnalysis(analysis);
    elements.report.textContent = 'The previous source PDF revision was restored.';
    flash('Native source edit restored');
  } catch (error) {
    elements.report.textContent = error.message;
  } finally {
    nativeEngine.busy = false;
    setLoading(false);
  }
}

function initNativeEngine() {
  const elements = nativeEngineElements();
  if (!elements.button || !elements.modal) return;
  elements.button.addEventListener('click', openNativeEngineModal);
  elements.close.addEventListener('click', () => elements.modal.classList.add('hidden'));
  elements.modal.addEventListener('click', (event) => {
    if (event.target === elements.modal) elements.modal.classList.add('hidden');
  });
  elements.restore.addEventListener('click', restoreNativeSource);
  elements.refresh.addEventListener('click', async () => {
    try {
      const analysis = await analyzeDocumentNatively(currentSourceDocument(), true);
      renderNativeAnalysis(analysis);
      elements.report.textContent = 'PDF structure refreshed.';
    } catch (error) {
      elements.report.textContent = error.message;
    }
  });
  elements.replace.addEventListener('click', runNativeTextReplacement);
  elements.saveForms.addEventListener('click', saveNativeFormFields);
  checkNativeEngine();
}

initNativeEngine();
