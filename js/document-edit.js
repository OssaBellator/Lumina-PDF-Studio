(function () {
  const editor = {
    mode: 'read',
    drafts: new Map(),
    currentBlocks: [],
    renderingToken: 0,
    committing: false,
  };

  function draftKey(block) {
    const rect = block.rect.map((value) => Math.round(value * 10) / 10).join(':');
    return `${block.docId}:${block.sourceIndex}:${rect}:${block.original}`;
  }

  function currentDraftCount() {
    return editor.drafts.size;
  }

  function injectDocumentEditorUI() {
    if (document.querySelector('#document-mode-button')) return;

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = './css/styles-document-edit.css';
    stylesheet.dataset.documentEdit = 'true';
    document.head.appendChild(stylesheet);

    const actions = document.querySelector('.top-actions');
    const modeGroup = document.createElement('div');
    modeGroup.className = 'document-mode-group';
    modeGroup.innerHTML = `
      <button class="button ghost document-mode-button" id="document-mode-button" type="button">
        <i data-lucide="file-pen-line"></i><span id="document-mode-label">Edit PDF</span>
      </button>
      <button class="button ghost document-discard-button hidden" id="document-discard-button" type="button" title="Discard inline edits">
        <i data-lucide="x"></i><span>Cancel</span>
      </button>`;
    const nativeButton = document.querySelector('#native-engine-button');
    actions.insertBefore(modeGroup, nativeButton || actions.firstChild);

    const layer = document.createElement('div');
    layer.id = 'document-text-layer';
    layer.className = 'document-text-layer hidden';
    layer.setAttribute('aria-label', 'Editable PDF text layer');
    el.pageStage.appendChild(layer);

    const hint = document.createElement('div');
    hint.id = 'document-edit-hint';
    hint.className = 'document-edit-hint hidden';
    hint.innerHTML = '<span><i data-lucide="mouse-pointer-click"></i>Double-click text to edit</span><b id="document-edit-count">No changes</b>';
    document.querySelector('.editor-shell').appendChild(hint);

    document.querySelector('#document-mode-button').addEventListener('click', async () => {
      if (editor.mode === 'read') await enterDocumentEditMode();
      else await commitDocumentEditsAndRead();
    });
    document.querySelector('#document-discard-button').addEventListener('click', discardDocumentEdits);

    const originalSendButton = document.querySelector('#send-ai');
    if (originalSendButton) {
      const replacementSendButton = originalSendButton.cloneNode(true);
      originalSendButton.replaceWith(replacementSendButton);
      replacementSendButton.addEventListener('click', () => sendAIMessage());
    }

    window.addEventListener('keydown', async (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 's' && editor.mode === 'edit') {
        event.preventDefault();
        await commitDocumentEditsAndRead();
      }
      if (event.key === 'Escape' && editor.mode === 'edit' && !event.target.closest?.('[contenteditable="true"]')) {
        discardDocumentEdits();
      }
    });

    updateDocumentEditorUI();
    if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }

  function updateDocumentEditorUI() {
    const button = document.querySelector('#document-mode-button');
    if (!button) return;
    const editing = editor.mode === 'edit';
    button.classList.toggle('primary', editing);
    button.classList.toggle('ghost', !editing);
    button.disabled = editor.committing;
    button.querySelector('#document-mode-label').textContent = editing
      ? (currentDraftCount() ? 'Save & Read' : 'Read mode')
      : 'Edit PDF';
    document.querySelector('#document-discard-button').classList.toggle('hidden', !editing);
    const hint = document.querySelector('#document-edit-hint');
    hint.classList.toggle('hidden', !editing);
    const count = document.querySelector('#document-edit-count');
    const changes = currentDraftCount();
    count.textContent = changes ? `${changes} unsaved change${changes === 1 ? '' : 's'}` : 'No changes';
    document.body.classList.toggle('document-edit-mode', editing);
    if (el.annotationLayer) el.annotationLayer.classList.toggle('document-edit-disabled', editing);
  }

  function pageItemRect(item, page) {
    const view = page.view || [0, 0, 612, 792];
    const pageWidth = view[2] - view[0];
    const pageHeight = view[3] - view[1];
    const matrix = item.transform || [1, 0, 0, 1, 0, 0];
    const fontHeight = Math.max(2, Math.hypot(matrix[2], matrix[3]) || Number(item.height) || 10);
    const x0 = Number(matrix[4]) - view[0];
    const baselineFromBottom = Number(matrix[5]) - view[1];
    const top = pageHeight - baselineFromBottom - fontHeight * 0.86;
    const bottom = pageHeight - baselineFromBottom + fontHeight * 0.22;
    const width = Math.max(Number(item.width) || fontHeight * 0.5, fontHeight * 0.35);
    return [
      clamp(x0 - 0.7, 0, pageWidth),
      clamp(top - 0.7, 0, pageHeight),
      clamp(x0 + width + 0.7, 0, pageWidth),
      clamp(bottom + 0.7, 0, pageHeight),
    ];
  }

  function itemScreenGeometry(item, viewport) {
    const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(4, Math.hypot(matrix[2], matrix[3]));
    const angle = Math.atan2(matrix[1], matrix[0]);
    return {
      left: matrix[4],
      top: matrix[5] - fontHeight,
      width: Math.max((Number(item.width) || fontHeight * 0.5) * viewport.scale, fontHeight * 0.45),
      height: fontHeight * 1.18,
      fontSize: fontHeight,
      angle,
    };
  }

  function textColorFromItem(item) {
    const style = item.fontName && editor.currentStyles?.[item.fontName];
    return style?.fontFamily || '';
  }

  function selectEditableText(element) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function beginInlineTextEdit(element, block) {
    if (editor.mode !== 'edit') return;
    document.querySelectorAll('.pdf-text-block.is-editing').forEach((node) => {
      if (node !== element) node.blur();
    });
    element.contentEditable = 'true';
    element.classList.add('is-editing');
    element.spellcheck = true;
    element.focus({ preventScroll: true });
    selectEditableText(element);
    element.dataset.beforeEdit = element.textContent;
    block.editing = true;
  }

  function finishInlineTextEdit(element, block, { cancel = false } = {}) {
    if (!block.editing) return;
    block.editing = false;
    element.contentEditable = 'false';
    element.classList.remove('is-editing');
    if (cancel) element.textContent = element.dataset.beforeEdit || block.value;
    const replacement = element.textContent ?? '';
    const key = draftKey(block);
    if (replacement === block.original) {
      editor.drafts.delete(key);
      block.value = block.original;
      element.classList.remove('is-changed');
    } else {
      const draft = { ...block, replacement };
      editor.drafts.set(key, draft);
      block.value = replacement;
      element.classList.add('is-changed');
    }
    updateDocumentEditorUI();
  }

  function createTextBlockElement(block) {
    const element = document.createElement('div');
    element.className = 'pdf-text-block';
    element.dataset.blockKey = draftKey(block);
    element.textContent = block.value;
    element.title = 'Double-click to edit this PDF text';
    element.style.left = `${block.screen.left}px`;
    element.style.top = `${block.screen.top}px`;
    element.style.width = `${block.screen.width}px`;
    element.style.minHeight = `${block.screen.height}px`;
    element.style.fontSize = `${block.screen.fontSize}px`;
    element.style.lineHeight = `${block.screen.height}px`;
    element.style.transform = `rotate(${block.screen.angle}rad)`;
    element.style.fontFamily = textColorFromItem(block.item) || 'Arial, sans-serif';
    if (block.value !== block.original) element.classList.add('is-changed');

    element.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      beginInlineTextEdit(element, block);
    });
    element.addEventListener('blur', () => finishInlineTextEdit(element, block));
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishInlineTextEdit(element, block, { cancel: true });
        element.blur();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        element.blur();
      }
    });
    return element;
  }

  async function renderDocumentTextLayer() {
    const layer = document.querySelector('#document-text-layer');
    if (!layer) return;
    const token = ++editor.renderingToken;
    if (editor.mode !== 'edit') {
      layer.classList.add('hidden');
      layer.innerHTML = '';
      return;
    }
    const pageState = activePage();
    const documentState = activeDocument();
    if (!pageState || !documentState) {
      layer.innerHTML = '';
      return;
    }

    layer.classList.remove('hidden');
    layer.innerHTML = '<div class="text-layer-loading">Mapping editable text…</div>';
    try {
      const page = await documentState.pdfjs.getPage(pageState.sourceIndex + 1);
      const viewport = page.getViewport({ scale: state.zoom, rotation: ((page.rotate || 0) + pageState.rotation) % 360 });
      const content = await page.getTextContent({ includeMarkedContent: true });
      if (token !== editor.renderingToken || editor.mode !== 'edit') return;
      editor.currentStyles = content.styles || {};
      editor.currentBlocks = content.items
        .filter((item) => typeof item.str === 'string' && item.str.trim())
        .map((item, index) => {
          const base = {
            item,
            itemIndex: index,
            docId: documentState.id,
            pageId: pageState.id,
            sourceIndex: pageState.sourceIndex,
            original: item.str,
            rect: pageItemRect(item, page),
            screen: itemScreenGeometry(item, viewport),
            fontSize: Math.max(5, Math.hypot(item.transform[2], item.transform[3]) || 11),
          };
          const saved = editor.drafts.get(draftKey(base));
          return { ...base, value: saved?.replacement ?? item.str };
        });
      layer.innerHTML = '';
      if (!editor.currentBlocks.length) {
        layer.innerHTML = '<div class="document-edit-empty">No searchable text was found on this page. Scanned pages need OCR.</div>';
        return;
      }
      const fragment = document.createDocumentFragment();
      editor.currentBlocks.forEach((block) => fragment.appendChild(createTextBlockElement(block)));
      layer.appendChild(fragment);
    } catch (error) {
      console.error(error);
      layer.innerHTML = `<div class="document-edit-empty">Could not build the editable text layer: ${escapeHtml(error.message)}</div>`;
    }
  }

  async function ensureDocumentEditable(documentState) {
    if (!documentState) throw new Error('Open a PDF first.');
    if (!nativeEngine.available && !(await checkNativeEngine())) {
      throw new Error('Edit mode needs the local PDF engine. Install requirements and run npm start.');
    }
    const analysis = await analyzeDocumentNatively(documentState);
    if (analysis.signatures?.mutationWarning) {
      throw new Error('This PDF is signed. Editing would invalidate its signature, so document edit mode is disabled.');
    }
  }

  async function enterDocumentEditMode() {
    if (!activeDocument()) {
      flash('Open a PDF first');
      return;
    }
    try {
      setLoading(true, 'Preparing document edit mode…');
      await ensureDocumentEditable(activeDocument());
      editor.mode = 'edit';
      state.tool = 'select';
      state.selectedAnnotationId = null;
      updateDocumentEditorUI();
      updateUI();
      await renderDocumentTextLayer();
      flash('Edit mode: double-click any text');
    } catch (error) {
      flash(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function performDocumentOperations(documentState, operations) {
    if (!documentState) throw new Error('The source PDF is no longer available.');
    if (!operations.length) return null;
    if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('The native PDF engine is offline.');
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
  }

  async function commitDocumentEditsAndRead() {
    if (editor.committing) return;
    if (!editor.drafts.size) {
      editor.mode = 'read';
      updateDocumentEditorUI();
      await renderDocumentTextLayer();
      return;
    }
    editor.committing = true;
    updateDocumentEditorUI();
    setLoading(true, 'Writing edits into the PDF…');
    const grouped = new Map();
    for (const [key, draft] of editor.drafts) {
      if (!grouped.has(draft.docId)) grouped.set(draft.docId, []);
      grouped.get(draft.docId).push({ key, draft });
    }
    try {
      for (const [docId, entries] of grouped) {
        const documentState = state.documents.get(docId);
        const operations = entries.map(({ draft }) => ({
          type: 'replace_text_region',
          page: draft.sourceIndex,
          rect: draft.rect,
          originalText: draft.original,
          replacement: draft.replacement,
          fontSize: draft.fontSize,
          minimumFontSize: 4,
        }));
        await performDocumentOperations(documentState, operations);
        entries.forEach(({ key }) => editor.drafts.delete(key));
      }
      editor.mode = 'read';
      await renderDocumentTextLayer();
      updateDocumentEditorUI();
      flash('Edits saved into the PDF');
    } catch (error) {
      flash(`Could not save inline edits: ${error.message}`);
      editor.mode = 'edit';
      await renderDocumentTextLayer();
    } finally {
      editor.committing = false;
      setLoading(false);
      updateDocumentEditorUI();
    }
  }

  function discardDocumentEdits() {
    editor.drafts.clear();
    editor.mode = 'read';
    updateDocumentEditorUI();
    renderDocumentTextLayer();
    flash('Inline edits discarded');
  }

  function normalizedRectForPage(pageState, args) {
    const documentState = state.documents.get(pageState.docId);
    return documentState.pdfjs.getPage(pageState.sourceIndex + 1).then((page) => {
      const view = page.view || [0, 0, 612, 792];
      const width = view[2] - view[0];
      const height = view[3] - view[1];
      const x = clamp(Number(args.x) || 0.1, 0, 0.98);
      const y = clamp(Number(args.y) || 0.1, 0, 0.98);
      const w = clamp(Number(args.width) || 0.35, 0.02, 1 - x);
      const h = clamp(Number(args.height) || 0.08, 0.02, 1 - y);
      return [x * width, y * height, (x + w) * width, (y + h) * height];
    });
  }

  function nativeToolSchemas() {
    return [
      {
        type: 'function',
        function: {
          name: 'edit_text',
          description: 'Replace exact searchable text in the source PDF. Prefer the shortest unique source phrase from the document context.',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 },
              search: { type: 'string' },
              replacement: { type: 'string' },
              occurrence: { anyOf: [{ type: 'string', enum: ['first', 'all'] }, { type: 'integer', minimum: 0 }] },
            },
            required: ['page', 'search', 'replacement'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'add_native_text',
          description: 'Insert real text into a rectangular area of a PDF page.',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 },
              x: { type: 'number', minimum: 0, maximum: 1 },
              y: { type: 'number', minimum: 0, maximum: 1 },
              width: { type: 'number', minimum: 0.02, maximum: 1 },
              height: { type: 'number', minimum: 0.02, maximum: 1 },
              text: { type: 'string' },
              size: { type: 'number', minimum: 4, maximum: 96 },
              color: { type: 'string' },
            },
            required: ['page', 'x', 'y', 'width', 'height', 'text'],
          },
        },
      },
    ];
  }

  function parseToolCalls(message) {
    const actions = [];
    for (const call of message?.tool_calls || []) {
      const name = call?.function?.name;
      if (!name) continue;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { args = {}; }
      actions.push({ tool: name, args });
    }
    return actions;
  }

  const basePermissionForTool = permissionForTool;
  permissionForTool = function enhancedPermissionForTool(tool) {
    if (['edit_text', 'add_native_text'].includes(tool)) return 'add_content';
    return basePermissionForTool(tool);
  };

  aiSystemPrompt = function enhancedAISystemPrompt() {
    return `You are Lumina's document assistant. You may answer questions and propose precise document edits. Page numbers are 1-based. For existing PDF text, use edit_text with an exact source phrase from the supplied document context; do not guess coordinates for replacement. Use add_native_text only when inserting new text. Other available Lumina actions are add_highlight, add_comment, add_rectangle, rotate_page, duplicate_page, move_page, delete_page, and export_pdf. Never claim an edit happened until the user approves it. When not using tool calls, return valid JSON: {"message":"helpful response","actions":[{"tool":"edit_text","args":{"page":1,"search":"old text","replacement":"new text"}}]}. Use an empty actions array when no edit is needed.`;
  };

  sendAIMessage = async function enhancedSendAIMessage() {
    const prompt = el.aiPrompt.value.trim();
    if (!prompt) return;
    if (!aiConfig.baseUrl || !aiConfig.model) {
      openAIModal();
      return;
    }
    addAIMessage('user', prompt);
    el.aiPrompt.value = '';
    document.querySelector('#send-ai').disabled = true;
    const placeholder = document.createElement('div');
    placeholder.className = 'ai-message assistant';
    placeholder.textContent = 'Thinking…';
    el.aiChat.appendChild(placeholder);
    try {
      const context = state.aiUseDocument && aiConfig.permissions.read_document ? await documentContext() : '';
      const messages = [
        { role: 'system', content: aiSystemPrompt() },
        ...state.aiConversation.slice(0, -1).slice(-8).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
        { role: 'user', content: context ? `${prompt}\n\nDocument context:\n${context}` : prompt },
      ];
      const headers = { 'Content-Type': 'application/json' };
      const key = sessionStorage.getItem('lumina-ai-key');
      if (key) headers.Authorization = `Bearer ${key}`;
      if (aiConfig.provider === 'openrouter') {
        headers['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin;
        headers['X-OpenRouter-Title'] = 'Lumina PDF Studio';
      }
      const endpoint = `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const baseBody = { model: aiConfig.model, messages, temperature: 0.15 };
      let response = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify({ ...baseBody, tools: nativeToolSchemas(), tool_choice: 'auto' }),
      });
      if (!response.ok && [400, 404, 422].includes(response.status)) {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(baseBody) });
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${response.status}: ${body.slice(0, 220)}`);
      }
      const data = await response.json();
      const message = data.choices?.[0]?.message || data.message || {};
      const content = message.content ?? data.output_text ?? '';
      const parsed = parseAIResponse(content);
      const actions = [...parseToolCalls(message), ...parsed.actions];
      placeholder.remove();
      addAIMessage('assistant', parsed.message || (actions.length ? 'I prepared source-PDF edits for review.' : String(content || 'Done.')));
      state.pendingAIActions = filterAIActions(actions);
      const blocked = actions.length - state.pendingAIActions.length;
      if (blocked > 0) addAIMessage('assistant', `${blocked} proposed action${blocked === 1 ? ' was' : 's were'} blocked by your permission settings or an unsupported tool name.`);
      renderActionQueue();
    } catch (error) {
      placeholder.className = 'ai-message error';
      placeholder.textContent = `AI request failed: ${error.message}`;
    } finally {
      document.querySelector('#send-ai').disabled = false;
    }
  };

  const baseExecutePendingAIActions = executePendingAIActions;
  executePendingAIActions = async function enhancedExecutePendingAIActions() {
    if (!state.pendingAIActions.length) return;
    const all = state.pendingAIActions;
    const nativeActions = all.filter((action) => ['edit_text', 'add_native_text'].includes(action.tool));
    const otherActions = all.filter((action) => !['edit_text', 'add_native_text'].includes(action.tool));
    state.pendingAIActions = otherActions;
    let applied = 0;
    const failures = [];

    if (nativeActions.length) {
      setLoading(true, 'Applying AI edits to the PDF…');
      try {
        if (!nativeEngine.available && !(await checkNativeEngine())) throw new Error('The local PDF engine is offline. Run npm start, not npm run start:static.');
        const groups = new Map();
        for (const action of nativeActions) {
          const args = action.args || {};
          const index = pageFromNumber(args.page);
          const pageState = state.pages[index];
          if (!pageState) {
            failures.push(`Page ${args.page} was not found.`);
            continue;
          }
          const documentState = state.documents.get(pageState.docId);
          if (!groups.has(documentState.id)) groups.set(documentState.id, { documentState, operations: [] });
          if (action.tool === 'edit_text') {
            if (!String(args.search || '').trim()) {
              failures.push(`AI edit on page ${index + 1} did not include source text to replace.`);
              continue;
            }
            let occurrence = args.occurrence ?? 'first';
            if (typeof occurrence === 'string' && !['first', 'all'].includes(occurrence)) occurrence = 'first';
            groups.get(documentState.id).operations.push({
              type: 'replace_text',
              search: String(args.search),
              replacement: String(args.replacement ?? ''),
              pages: [pageState.sourceIndex],
              occurrence,
              requireMatch: true,
            });
          } else {
            const rect = await normalizedRectForPage(pageState, args);
            groups.get(documentState.id).operations.push({
              type: 'add_text',
              page: pageState.sourceIndex,
              rect,
              text: String(args.text || ''),
              fontSize: clamp(Number(args.size) || 12, 4, 96),
              color: /^#[0-9a-f]{6}$/i.test(args.color || '') ? args.color : '#111318',
              minimumFontSize: 4,
            });
          }
        }
        for (const { documentState, operations } of groups.values()) {
          if (!operations.length) continue;
          await performDocumentOperations(documentState, operations);
          applied += operations.length;
        }
      } catch (error) {
        failures.push(error.message);
      } finally {
        setLoading(false);
      }
    }

    if (otherActions.length) {
      state.pendingAIActions = otherActions;
      await baseExecutePendingAIActions();
      applied += otherActions.length;
    } else {
      state.pendingAIActions = [];
      renderActionQueue();
    }

    if (applied) addAIMessage('assistant', `${applied} approved edit${applied === 1 ? '' : 's'} applied to the document.`);
    if (failures.length) addAIMessage('assistant', `Some edits could not be applied:\n${failures.map((item) => `• ${item}`).join('\n')}`);
  };

  const baseRenderCurrentPage = renderCurrentPage;
  renderCurrentPage = async function renderCurrentPageWithDocumentEditor() {
    await baseRenderCurrentPage();
    await renderDocumentTextLayer();
  };

  window.LuminaDocumentEditor = {
    enter: enterDocumentEditMode,
    saveAndRead: commitDocumentEditsAndRead,
    discard: discardDocumentEdits,
    render: renderDocumentTextLayer,
    state: editor,
  };

  injectDocumentEditorUI();
})();
