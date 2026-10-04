'use strict';

const $ = (id) => document.getElementById(id);
const DONE = new Set(['done', 'failed', 'canceled']);

const state = {
  token: localStorage.getItem('onlymind_token') || '',
  streamPref: localStorage.getItem('onlymind_stream') === '1',
  concisePref: localStorage.getItem('onlymind_concise') !== '0', // default ON
  enginePref: localStorage.getItem('onlymind_engine') || '',
  engines: [],       // full metadata from /api/engines
  engineById: {},

  nextCursor: null,
  loading: false,
  cards: new Map(), // id -> element
  pollTimer: null,
};

// ---- API helpers ----------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('令牌无效,请到设置里检查 Token');
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '';
}

// ---- Card lifecycle -------------------------------------------------------
function createCard(t) {
  const el = document.createElement('div');
  el.className = 'task';
  el.innerHTML = `
    <div class="header">
      <div class="top">
        <span class="badge"></span>
        <span class="live-dot hidden">● LIVE</span>
        <span class="engine"></span>
      </div>
      <p class="prompt"></p>
      <div class="time"></div>
    </div>
    <div class="output hidden"></div>
    <div class="actions hidden"></div>`;
  el.refs = {
    badge: el.querySelector('.badge'),
    live: el.querySelector('.live-dot'),
    engine: el.querySelector('.engine'),
    prompt: el.querySelector('.prompt'),
    time: el.querySelector('.time'),
    output: el.querySelector('.output'),
    actions: el.querySelector('.actions'),
  };
  el._es = null;
  el._open = false;
  el.querySelector('.header').addEventListener('click', () => toggleCard(el, t.id));
  state.cards.set(t.id, el);
  return el;
}

function updateCard(el, t) {
  el.dataset.status = t.status;
  el.refs.badge.textContent = t.status;
  el.refs.badge.className = `badge ${t.status}`;
  el.refs.engine.textContent = t.engine + (t.stream ? ' · stream' : '');
  el.refs.prompt.textContent = t.prompt;
  el.refs.time.textContent = fmtTime(t.created_at);
  el.refs.live.classList.toggle('hidden', !el._es);

  if (!el._open) return;
  el.refs.actions.classList.remove('hidden');
  renderActions(el, t);

  // When SSE is driving the output, don't clobber it here.
  if (el._es) return;
  el.refs.output.classList.remove('hidden');
  const err = t.status === 'failed' && t.error && !t.output;
  el.refs.output.classList.toggle('err', !!err);
  el.refs.output.textContent = t.output || t.error || '(无输出)';
}

function renderActions(el, t) {
  const a = el.refs.actions;
  a.innerHTML = '';
  if (t.status === 'queued' || t.status === 'running') {
    const btn = document.createElement('button');
    btn.className = 'cancel';
    btn.textContent = '取消';
    btn.addEventListener('click', (e) => { e.stopPropagation(); cancelTask(t.id); });
    a.appendChild(btn);
  }
  if (DONE.has(t.status)) {
    const btn = document.createElement('button');
    btn.className = 'rerun';
    btn.textContent = '重跑';
    btn.addEventListener('click', (e) => { e.stopPropagation(); rerunTask(t.id); });
    a.appendChild(btn);
  }
}

async function toggleCard(el, id) {
  if (el._open) { closeCard(el); return; }
  el._open = true;
  const t = await api(`/api/tasks/${id}`);
  el.refs.output.classList.remove('hidden');
  el.refs.actions.classList.remove('hidden');

  if (t.stream && !DONE.has(t.status)) {
    startStream(el, t);
  } else {
    updateCard(el, t);
  }
}

function closeCard(el) {
  el._open = false;
  stopStream(el);
  el.refs.output.classList.add('hidden');
  el.refs.actions.classList.add('hidden');
}

// ---- SSE live streaming ---------------------------------------------------
function startStream(el, t) {
  el.refs.output.classList.remove('err');
  el.refs.output.textContent = t.output || '';
  const es = new EventSource(`/api/tasks/${t.id}/stream?token=${encodeURIComponent(state.token)}`);
  el._es = es;
  updateCard(el, t); // shows LIVE dot + cancel button

  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    el.refs.output.textContent = snap.output || '';
  });
  es.addEventListener('chunk', (e) => {
    el.refs.output.textContent += JSON.parse(e.data).text;
    el.refs.output.scrollTop = el.refs.output.scrollHeight;
  });
  es.addEventListener('status', (e) => {
    el.dataset.status = JSON.parse(e.data).status;
  });
  es.addEventListener('done', async () => {
    stopStream(el);
    try { updateCard(el, await api(`/api/tasks/${t.id}`)); } catch {}
  });
  es.onerror = () => { stopStream(el); };
}

function stopStream(el) {
  if (el._es) { el._es.close(); el._es = null; el.refs.live.classList.add('hidden'); }
}

// ---- Actions --------------------------------------------------------------
async function cancelTask(id) {
  try {
    await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
    const el = state.cards.get(id);
    if (el) { stopStream(el); updateCard(el, await api(`/api/tasks/${id}`)); }
  } catch (e) { alert(e.message); }
}

async function rerunTask(id) {
  try {
    await api(`/api/tasks/${id}/rerun`, { method: 'POST' });
    await loadMore(true); // new task shows on top
  } catch (e) { alert(e.message); }
}

// ---- Data flow ------------------------------------------------------------
async function loadVersion() {
  try {
    const v = await api('/api/version');
    if (v.updateAvailable) {
      $('footer').innerHTML =
        `OnlyMind v${escapeHtml(v.current)}` +
        `<br><span class="update">有新版本 v${escapeHtml(v.latest)} · 在电脑上运行 npm run update 更新</span>`;
    } else {
      $('footer').textContent = `OnlyMind v${v.current}`;
    }
  } catch { /* 忽略,不影响使用 */ }
}

async function loadEngines() {
  try {
    const { engines } = await api('/api/engines');
    state.engines = engines;
    state.engineById = Object.fromEntries(engines.map((e) => [e.id, e]));
    $('engine').innerHTML = engines.map((e) => `<option value="${e.id}">${e.label}</option>`).join('');
    // Restore the user's last engine choice if still valid.
    if (state.enginePref && state.engineById[state.enginePref]) $('engine').value = state.enginePref;
    refreshEngineKeyUI();
    refreshKeyStatus();
  } catch { /* surfaced elsewhere */ }
}

function selectedEngine() { return state.engineById[$('engine').value]; }

// Show the inline "enter API key" row when the chosen engine needs a key but
// none is set yet.
function refreshEngineKeyUI() {
  const e = selectedEngine();
  const need = e && e.kind === 'api' && !e.keySet;
  $('apiKeyRow').classList.toggle('hidden', !need);
  if (need) {
    $('apiKeyProvider').textContent = e.provider;
    $('apiKeyInput').placeholder = e.provider === 'openai' ? 'sk-...' : 'sk-ant-...';
    $('apiKeyMsg').textContent = '';
  }
}

// Reflect stored-key status in the settings panel.
function refreshKeyStatus() {
  for (const p of ['openai', 'anthropic']) {
    const set = !!state.engineById[p]?.keySet;
    const el = $(`st-${p}`);
    if (el) { el.textContent = set ? '· 已设置' : '· 未设置'; el.className = `keystat ${set ? 'set' : 'unset'}`; }
  }
}

// Validate + store an API key via the server, then refresh engine metadata.
async function saveKey(provider, key, msgEl) {
  if (!key) { msgEl.textContent = '请输入 API Key'; return false; }
  msgEl.textContent = '验证中…';
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider, key }) });
    msgEl.textContent = '已验证并保存 ✓';
    await loadEngines(); // keySet now true
    return true;
  } catch (e) {
    msgEl.textContent = e.message; // e.g. API Key 无效
    return false;
  }
}

async function loadMore(reset = false) {
  if (state.loading) return;
  state.loading = true;
  $('listMsg').textContent = '加载中…';
  try {
    if (reset) {
      state.nextCursor = null;
      for (const el of state.cards.values()) stopStream(el);
      state.cards.clear();
      $('list').innerHTML = '';
    }
    const q = state.nextCursor ? `?cursor=${state.nextCursor}&limit=20` : '?limit=20';
    const { items, nextCursor } = await api('/api/tasks' + q);
    for (const t of items) {
      const el = createCard(t);
      $('list').appendChild(el);
      updateCard(el, t);
    }
    state.nextCursor = nextCursor;
    $('loadMore').classList.toggle('hidden', !nextCursor);
    $('listMsg').textContent = items.length === 0 && reset ? '暂无任务' : '';
    schedulePoll();
  } catch (e) {
    $('listMsg').textContent = e.message;
  } finally {
    state.loading = false;
  }
}

// Poll tasks that are still queued/running (except ones already streaming via SSE).
function schedulePoll() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    const live = [...state.cards.entries()].filter(
      ([, el]) => !el._es && (el.dataset.status === 'queued' || el.dataset.status === 'running')
    );
    if (live.length === 0) { clearInterval(state.pollTimer); state.pollTimer = null; return; }
    for (const [id, el] of live) {
      try { updateCard(el, await api(`/api/tasks/${id}`)); } catch { /* transient */ }
    }
  }, 2000);
}

// ---- Events ---------------------------------------------------------------
$('settingsBtn').addEventListener('click', () => $('settings').classList.toggle('hidden'));

$('saveToken').addEventListener('click', async () => {
  state.token = $('token').value.trim();
  localStorage.setItem('onlymind_token', state.token);
  await init();
  $('settings').classList.add('hidden');
});

$('stream').addEventListener('change', () => {
  state.streamPref = $('stream').checked;
  localStorage.setItem('onlymind_stream', state.streamPref ? '1' : '0');
});

$('concise').addEventListener('change', () => {
  state.concisePref = $('concise').checked;
  localStorage.setItem('onlymind_concise', state.concisePref ? '1' : '0');
});

$('engine').addEventListener('change', () => {
  state.enginePref = $('engine').value;
  localStorage.setItem('onlymind_engine', state.enginePref);
  refreshEngineKeyUI();
});

// Inline "enter key for this engine" (shown under the engine dropdown).
$('apiKeySave').addEventListener('click', async () => {
  const e = selectedEngine();
  if (!e || e.kind !== 'api') return;
  const ok = await saveKey(e.provider, $('apiKeyInput').value.trim(), $('apiKeyMsg'));
  if (ok) { $('apiKeyInput').value = ''; refreshEngineKeyUI(); }
});

// Key management inside the settings panel (gear).
for (const btn of document.querySelectorAll('.keysave')) {
  btn.addEventListener('click', async () => {
    const p = btn.dataset.provider;
    const ok = await saveKey(p, $(`key-${p}`).value.trim(), $('keyMsg'));
    if (ok) $(`key-${p}`).value = '';
  });
}

$('submit').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) { $('submitMsg').textContent = '请输入任务内容'; return; }
  const eng = selectedEngine();
  if (eng && eng.kind === 'api' && !eng.keySet) {
    $('submitMsg').textContent = `请先为 ${eng.provider} 设置并验证 API Key`;
    refreshEngineKeyUI();
    return;
  }
  $('submit').disabled = true;
  $('submitMsg').textContent = '发送中…';
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        engine: $('engine').value,
        cwd: $('cwd').value.trim() || undefined,
        stream: state.streamPref,
        concise: state.concisePref,
      }),
    });
    $('prompt').value = '';
    $('submitMsg').textContent = '已提交 ✓';
    await loadMore(true);
  } catch (e) {
    $('submitMsg').textContent = e.message;
  } finally {
    $('submit').disabled = false;
  }
});

$('loadMore').addEventListener('click', () => loadMore(false));

// ---- Init -----------------------------------------------------------------
async function init() {
  $('token').value = state.token;
  $('stream').checked = state.streamPref;
  $('concise').checked = state.concisePref;
  if (!state.token) {
    $('settings').classList.remove('hidden');
    $('connStatus').textContent = '未设置令牌';
    return;
  }
  try {
    await api('/api/health');
    $('connStatus').textContent = '已连接 ✓';
    await loadEngines();
    loadVersion();
    await loadMore(true);
  } catch (e) {
    $('settings').classList.remove('hidden');
    $('connStatus').textContent = e.message;
  }
}

init();
