(function () {
  'use strict';

  const api = window.LuminaReflowEditor;
  if (!api || window.__luminaReflowRecoveryInstalled) return;
  window.__luminaReflowRecoveryInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const state = api.state;

  function finite(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function safeString(value, limit = 250000) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
  }

  function sanitizeStyle(value) {
    const style = value && typeof value === 'object' ? value : {};
    const align = ['left', 'center', 'right', 'justify'].includes(style.align) ? style.align : 'left';
    return {
      fontFamily: safeString(style.fontFamily || 'Arial', 120),
      fontSize: finite(style.fontSize, 11, 5, 96),
      bold: Boolean(style.bold),
      italic: Boolean(style.italic),
      underline: Boolean(style.underline),
      color: /^#[0-9a-f]{6}$/i.test(style.color || '') ? style.color : '#111318',
      align,
      lineHeight: finite(style.lineHeight, 1.2, 0.8, 3),
    };
  }

  function sanitizeModel(value) {
    const source = value && typeof value === 'object' ? value : {};
    const page = source.page && typeof source.page === 'object' ? source.page : {};
    const width = finite(page.width, 612, 216, 2000);
    const height = finite(page.height, 792, 216, 3000);
    const margin = finite(page.margin, 54, 12, Math.min(width, height) * 0.35);
    const blocks = [];
    for (const raw of (Array.isArray(source.blocks) ? source.blocks : []).slice(0, 5000)) {
      if (!raw || typeof raw !== 'object') continue;
      const id = safeString(raw.id || `block-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`, 160);
      const type = ['paragraph', 'heading', 'quote', 'list_item', 'equation', 'table', 'image', 'page_break'].includes(raw.type) ? raw.type : 'paragraph';
      if (type === 'page_break') { blocks.push({ id, type }); continue; }
      if (type === 'table') {
        const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 200).map((row) => (Array.isArray(row) ? row : [row]).slice(0, 50).map((cell) => safeString(cell, 25000)));
        blocks.push({ id, type, rows: rows.length ? rows : [['']], style: sanitizeStyle(raw.style) });
        continue;
      }
      if (type === 'image') {
        blocks.push({
          id, type,
          dataUrl: safeString(raw.dataUrl, 45 * 1024 * 1024),
          mime: safeString(raw.mime || 'image/png', 80),
          width: finite(raw.width, 320, 24, 1600),
          height: finite(raw.height, 200, 16, 1600),
          alt: safeString(raw.alt || 'Document image', 1000),
          equationText: safeString(raw.equationText, 20000),
          source: raw.source && typeof raw.source === 'object' ? structuredClone(raw.source) : {},
        });
        continue;
      }
      const text = safeString(raw.text || '');
      const block = { id, type, text, html: safeString(raw.html || text, 500000), style: sanitizeStyle(raw.style) };
      if (type === 'heading') block.level = Math.round(finite(raw.level, 2, 1, 6));
      if (type === 'list_item') block.listType = raw.listType === 'number' ? 'number' : 'bullet';
      if (type === 'equation') block.latex = safeString(raw.latex || text);
      blocks.push(block);
    }
    return {
      version: 2,
      title: safeString(source.title || 'Lumina document', 1000),
      page: { width, height, margin },
      blocks,
      warnings: Array.isArray(source.warnings) ? source.warnings.map((item) => safeString(item, 2000)).slice(0, 200) : [],
      source: source.source && typeof source.source === 'object' ? structuredClone(source.source) : {},
    };
  }

  function isRenderRequest(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    return url.endsWith('/api/document/render') && String(init?.method || 'GET').toUpperCase() === 'POST';
  }

  async function jsonOrError(response) {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch (_) { return { error: { code: 'invalid_server_response', message: `The local engine returned ${response.status} without JSON: ${text.slice(0, 240)}` } }; }
  }

  window.fetch = async function luminaRecoveryFetch(input, init) {
    if (!isRenderRequest(input, init)) return originalFetch(input, init);
    let requestPayload;
    try { requestPayload = JSON.parse(String(init.body || '{}')); }
    catch (_) { requestPayload = {}; }
    requestPayload.model = sanitizeModel(requestPayload.model || state.model || {});

    const request = async (preferOffice) => originalFetch(input, {
      ...init,
      headers: { ...(init?.headers || {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestPayload, preferOffice }),
    });

    let response;
    try { response = await request(requestPayload.preferOffice !== false); }
    catch (error) {
      return new Response(JSON.stringify({ error: { code: 'render_network_error', message: error.message } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (!response.ok && requestPayload.preferOffice !== false) {
      try { response = await request(false); } catch (_) { /* Return the first structured failure below. */ }
    }

    const payload = await jsonOrError(response.clone());
    if (response.ok && payload.model && typeof payload.model === 'object') state.model = payload.model;
    if (response.ok && Array.isArray(payload.warnings) && payload.warnings.length) {
      const summary = payload.recovered ? `Recovered document render: ${payload.warnings[0]}` : payload.warnings[0];
      if (typeof flash === 'function') flash(summary);
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      return new Response(JSON.stringify(payload), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  };

  function escapeHtml(value) {
    const element = document.createElement('div'); element.textContent = String(value ?? '');
    return element.innerHTML.replace(/\n/g, '<br>');
  }

  async function replaceEquationSnapshot(blockId) {
    const block = state.model?.blocks?.find((item) => item.id === blockId);
    if (!block || block.source?.kind !== 'equation_snapshot') return;
    const initial = block.equationText && !/[\ufffd\ue000-\uf8ff]/.test(block.equationText) ? block.equationText : '';
    const value = window.prompt('Replace the preserved equation with editable LaTeX or plain mathematical text:', initial);
    if (value === null) return;
    const index = state.model.blocks.indexOf(block);
    state.history.push(structuredClone(state.model)); state.history = state.history.slice(-100); state.future = [];
    state.model.blocks[index] = {
      id: block.id,
      type: 'equation',
      text: value,
      html: escapeHtml(value),
      latex: value,
      style: { fontFamily: 'Cambria Math', fontSize: 12, color: '#111318', align: 'center', lineHeight: 1.2 },
      source: { ...block.source, kind: 'equation_replacement' },
    };
    state.selectedIds = new Set([block.id]); state.activeId = block.id;
    await api.enter();
    if (typeof flash === 'function') flash('Preserved equation replaced with an editable equation block');
  }

  function decorateEquationSnapshots() {
    const documentElement = document.querySelector('#reflow-document');
    if (!documentElement || !state.model) return;
    for (const block of state.model.blocks || []) {
      if (block.type !== 'image' || block.source?.kind !== 'equation_snapshot') continue;
      const wrapper = documentElement.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);
      if (!wrapper || wrapper.querySelector('.reflow-equation-snapshot-label')) continue;
      wrapper.classList.add('equation-snapshot-block');
      const label = document.createElement('button');
      label.type = 'button'; label.className = 'reflow-equation-snapshot-label';
      label.textContent = 'Original equation preserved · replace with editable math';
      label.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); replaceEquationSnapshot(block.id); });
      wrapper.prepend(label);
    }
  }

  const stylesheet = document.createElement('style');
  stylesheet.textContent = `
    .equation-snapshot-block{position:relative;padding-top:34px!important;background:#fbfaff!important}
    .equation-snapshot-block figure{margin:0;text-align:center}
    .equation-snapshot-block img{max-width:100%;height:auto;image-rendering:auto}
    .reflow-equation-snapshot-label{position:absolute;top:6px;left:50%;transform:translateX(-50%);border:1px solid #d9d2ff;background:#fff;color:#5d42e8;border-radius:999px;padding:5px 10px;font:600 11px/1.2 Inter,Arial,sans-serif;cursor:pointer;white-space:nowrap}
  `;
  document.head.appendChild(stylesheet);

  const observer = new MutationObserver(decorateEquationSnapshots);
  const editorShell = document.querySelector('#reflow-editor-shell');
  if (editorShell) observer.observe(editorShell, { childList: true, subtree: true });
  document.addEventListener('dblclick', (event) => {
    const wrapper = event.target.closest?.('.reflow-block');
    if (!wrapper) return;
    const block = state.model?.blocks?.find((item) => item.id === wrapper.dataset.blockId);
    if (block?.source?.kind === 'equation_snapshot') replaceEquationSnapshot(block.id);
  });
  decorateEquationSnapshots();

  window.LuminaReflowRecovery = { sanitizeModel, replaceEquationSnapshot, version: '1.0.0' };
})();
