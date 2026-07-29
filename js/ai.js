function loadAIConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('lumina-ai-config') || 'null');
    return saved ? { ...defaultAIConfig, ...saved, permissions: { ...defaultAIConfig.permissions, ...(saved.permissions || {}) } } : deepClone(defaultAIConfig);
  } catch (_) {
    return deepClone(defaultAIConfig);
  }
}

function updateAIStatus() {
  const provider = providerDefaults[aiConfig.provider] || providerDefaults.custom;
  el.providerLabel.textContent = aiConfig.baseUrl && aiConfig.model ? provider.label : 'No AI connected';
  el.modelLabel.textContent = aiConfig.model || 'Configure a provider';
}

function openAIModal() {
  el.aiModal.classList.remove('hidden');
  el.aiBaseUrl.value = aiConfig.baseUrl || '';
  el.aiModel.value = aiConfig.model || '';
  el.aiKey.value = sessionStorage.getItem('lumina-ai-key') || '';
  $$('#provider-grid button').forEach((button) => button.classList.toggle('active', button.dataset.provider === aiConfig.provider));
  $$('[data-ai-tool]').forEach((input) => { input.checked = Boolean(aiConfig.permissions[input.dataset.aiTool]); });
  el.connectionResult.textContent = '';
  icons();
}

function selectProvider(provider) {
  aiConfig.provider = provider;
  const defaults = providerDefaults[provider];
  el.aiBaseUrl.value = defaults.baseUrl;
  if (!el.aiModel.value || provider !== 'custom') el.aiModel.value = defaults.model;
  $$('#provider-grid button').forEach((button) => button.classList.toggle('active', button.dataset.provider === provider));
}

function saveAISettings() {
  aiConfig.baseUrl = el.aiBaseUrl.value.trim().replace(/\/$/, '');
  aiConfig.model = el.aiModel.value.trim();
  aiConfig.permissions = Object.fromEntries($$('[data-ai-tool]').map((input) => [input.dataset.aiTool, input.checked]));
  localStorage.setItem('lumina-ai-config', JSON.stringify(aiConfig));
  if (el.aiKey.value) sessionStorage.setItem('lumina-ai-key', el.aiKey.value); else sessionStorage.removeItem('lumina-ai-key');
  el.aiModal.classList.add('hidden');
  updateAIStatus();
  flash('AI connection saved');
}

async function testAIConnection() {
  const baseUrl = el.aiBaseUrl.value.trim().replace(/\/$/, '');
  if (!baseUrl) return;
  el.connectionResult.textContent = 'Testing…';
  try {
    const headers = {};
    if (el.aiKey.value) headers.Authorization = `Bearer ${el.aiKey.value}`;
    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    const count = Array.isArray(data.data) ? data.data.length : Array.isArray(data.models) ? data.models.length : null;
    el.connectionResult.textContent = count === null ? 'Connected' : `Connected · ${count} models`;
  } catch (error) {
    el.connectionResult.textContent = `Could not connect: ${error.message}. Local servers may need CORS enabled.`;
  }
}

function setRightTab(tab) {
  $$('.right-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.rightTab === tab));
  $$('[data-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== tab));
}

function addAIMessage(role, content) {
  state.aiConversation.push({ role, content });
  const div = document.createElement('div');
  div.className = `ai-message ${role}`;
  div.textContent = content;
  el.aiChat.appendChild(div);
  el.aiChat.scrollTop = el.aiChat.scrollHeight;
}

function aiSystemPrompt() {
  const tools = [
    'add_text {page, x, y, text, size?, color?}',
    'add_highlight {page, x, y, width, height, color?}',
    'add_comment {page, x, y, text}',
    'add_rectangle {page, x, y, width, height, color?}',
    'whiteout {page, x, y, width, height}',
    'replace_text {page, x, y, width, height, text, size?, color?}',
    'rotate_page {page, degrees}',
    'duplicate_page {page}',
    'move_page {from, to}',
    'delete_page {page}',
    'export_pdf {}',
  ];
  return `You are Lumina's document assistant. Answer questions and, when useful, propose actions using only the tools below. Coordinates and dimensions are normalised from 0 to 1, measured from the top-left. Page numbers are 1-based. Never claim an action happened until the user approves it. Return valid JSON only with this shape: {"message":"helpful response","actions":[{"tool":"tool_name","args":{}}]}. Use an empty actions array when no edit is required. Available tools:\n${tools.join('\n')}`;
}

function parseAIResponse(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text || part.content || '').join('') : String(content || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(candidate);
    return { message: String(parsed.message || ''), actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
  } catch (_) {
    return { message: text, actions: [] };
  }
}

function permissionForTool(tool) {
  if (['add_text', 'add_highlight', 'add_comment', 'add_rectangle', 'whiteout', 'replace_text'].includes(tool)) return 'add_content';
  if (['rotate_page', 'duplicate_page', 'move_page'].includes(tool)) return 'organize_pages';
  if (tool === 'delete_page') return 'delete_pages';
  if (tool === 'export_pdf') return 'export_pdf';
  return null;
}

function filterAIActions(actions) {
  return actions.filter((action) => {
    if (!action || typeof action.tool !== 'string' || typeof action.args !== 'object') return false;
    const permission = permissionForTool(action.tool);
    return permission && aiConfig.permissions[permission];
  }).slice(0, 20);
}

function renderActionQueue() {
  if (!state.pendingAIActions.length) {
    el.actionQueue.classList.add('hidden');
    el.actionQueue.innerHTML = '';
    return;
  }
  el.actionQueue.classList.remove('hidden');
  el.actionQueue.innerHTML = `<h4>${state.pendingAIActions.length} proposed action${state.pendingAIActions.length === 1 ? '' : 's'}</h4>${state.pendingAIActions.map((action) => `<div class="action-item"><b>${escapeHtml(action.tool)}</b> ${escapeHtml(JSON.stringify(action.args))}</div>`).join('')}<div class="action-buttons"><button class="button primary small" id="approve-actions">Approve all</button><button class="button ghost small" id="reject-actions">Reject</button></div>`;
  $('#approve-actions').addEventListener('click', executePendingAIActions);
  $('#reject-actions').addEventListener('click', () => {
    state.pendingAIActions = [];
    renderActionQueue();
    addAIMessage('assistant', 'Proposed actions discarded.');
  });
}

async function sendAIMessage() {
  const prompt = el.aiPrompt.value.trim();
  if (!prompt) return;
  if (!aiConfig.baseUrl || !aiConfig.model) {
    openAIModal();
    return;
  }
  addAIMessage('user', prompt);
  el.aiPrompt.value = '';
  $('#send-ai').disabled = true;
  const placeholder = document.createElement('div');
  placeholder.className = 'ai-message assistant';
  placeholder.textContent = 'Thinking…';
  el.aiChat.appendChild(placeholder);
  try {
    const context = state.aiUseDocument && aiConfig.permissions.read_document ? await documentContext() : '';
    const messages = [
      { role: 'system', content: aiSystemPrompt() },
      ...state.aiConversation.slice(0, -1).slice(-8).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
      { role: 'user', content: context ? `${prompt}\n\nDocument context:${context}` : prompt },
    ];
    const headers = { 'Content-Type': 'application/json' };
    const key = sessionStorage.getItem('lumina-ai-key');
    if (key) headers.Authorization = `Bearer ${key}`;
    if (aiConfig.provider === 'openrouter') {
      headers['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin;
      headers['X-OpenRouter-Title'] = 'Lumina PDF Studio';
    }
    const response = await fetch(`${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: aiConfig.model, messages, temperature: 0.2 }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status}: ${body.slice(0, 180)}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? data.output_text ?? '';
    const parsed = parseAIResponse(content);
    placeholder.remove();
    addAIMessage('assistant', parsed.message || 'I prepared document actions for review.');
    state.pendingAIActions = filterAIActions(parsed.actions);
    const blocked = parsed.actions.length - state.pendingAIActions.length;
    if (blocked > 0) addAIMessage('assistant', `${blocked} proposed action${blocked === 1 ? ' was' : 's were'} blocked by your permission settings.`);
    renderActionQueue();
  } catch (error) {
    placeholder.className = 'ai-message error';
    placeholder.textContent = `Connection failed: ${error.message}`;
  } finally {
    $('#send-ai').disabled = false;
  }
}

function pageFromNumber(value, fallback = state.activePageIndex) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(Math.round(number) - 1, 0, state.pages.length - 1) : fallback;
}

async function executePendingAIActions() {
  if (!state.pendingAIActions.length) return;
  const actions = state.pendingAIActions;
  state.pendingAIActions = [];
  renderActionQueue();
  pushHistory();
  let needsExport = false;
  for (const action of actions) {
    const args = action.args || {};
    const index = pageFromNumber(args.page);
    const page = state.pages[index];
    if (!page && action.tool !== 'export_pdf') continue;
    const x = clamp(Number(args.x) || .1, 0, .95);
    const y = clamp(Number(args.y) || .1, 0, .95);
    const width = clamp(Number(args.width) || .3, .02, 1 - x);
    const height = clamp(Number(args.height) || .08, .02, 1 - y);
    const color = /^#[0-9a-f]{6}$/i.test(args.color || '') ? args.color : '#5d42e8';
    if (action.tool === 'add_text') page.annotations.push({ id: uid('ann'), type: 'text', x, y, width, height, text: String(args.text || ''), size: clamp(Number(args.size) || 18, 6, 96), color, opacity: 1 });
    if (action.tool === 'add_highlight') page.annotations.push({ id: uid('ann'), type: 'highlight', x, y, width, height, color: args.color || '#f3c623', opacity: 1 });
    if (action.tool === 'add_comment') page.annotations.push({ id: uid('ann'), type: 'comment', x, y, text: String(args.text || ''), color, opacity: 1 });
    if (action.tool === 'add_rectangle') page.annotations.push({ id: uid('ann'), type: 'rectangle', x, y, width, height, strokeWidth: 3, color, opacity: 1 });
    if (action.tool === 'whiteout') page.annotations.push({ id: uid('ann'), type: 'whiteout', x, y, width, height, color: '#ffffff', opacity: 1 });
    if (action.tool === 'replace_text') {
      page.annotations.push({ id: uid('ann'), type: 'whiteout', x, y, width, height, color: '#ffffff', opacity: 1 });
      page.annotations.push({ id: uid('ann'), type: 'text', x: x + .006, y: y + .004, width: Math.max(.02, width - .012), height: Math.max(.02, height - .008), text: String(args.text || ''), size: clamp(Number(args.size) || 16, 6, 96), color, opacity: 1 });
    }
    if (action.tool === 'rotate_page') page.rotation = ((page.rotation + (Number(args.degrees) || 90)) % 360 + 360) % 360;
    if (action.tool === 'duplicate_page') {
      const copy = deepClone(page); copy.id = uid('page'); copy.annotations.forEach((item) => { item.id = uid('ann'); }); state.pages.splice(index + 1, 0, copy);
    }
    if (action.tool === 'move_page') {
      const from = pageFromNumber(args.from); const to = pageFromNumber(args.to);
      const [moved] = state.pages.splice(from, 1); state.pages.splice(to, 0, moved);
    }
    if (action.tool === 'delete_page' && state.pages.length > 1) state.pages.splice(index, 1);
    if (action.tool === 'export_pdf') needsExport = true;
  }
  state.activePageIndex = clamp(state.activePageIndex, 0, Math.max(0, state.pages.length - 1));
  state.selectedAnnotationId = null;
  await refreshWorkspace();
  addAIMessage('assistant', `${actions.length} approved action${actions.length === 1 ? '' : 's'} applied.`);
  if (needsExport) await exportPdf();
}
