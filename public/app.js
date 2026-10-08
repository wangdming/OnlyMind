'use strict';

const $ = (id) => document.getElementById(id);
const DONE = new Set(['done', 'failed', 'canceled']);

const state = {
  token: localStorage.getItem('onlymind_token') || '',
  streamPref: localStorage.getItem('onlymind_stream') === '1',
  concisePref: localStorage.getItem('onlymind_concise') !== '0', // default ON
  mcpPref: localStorage.getItem('onlymind_mcp') === '1', // default OFF
  enginePref: localStorage.getItem('onlymind_engine') || '',
  engines: [],       // full metadata from /api/engines
  engineById: {},
  sessions: [],      // sessions for the current engine
  currentSession: '', // '' = no session (one-off tasks)

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Output rendering -----------------------------------------------------
// Task output is plain text that often contains GitHub-flavored Markdown pipe
// tables (rows built from "|" and "---"). On a narrow phone, dumping them as
// pre-wrap monospace wraps every row into an unreadable blob, so we convert
// detected table blocks into real, horizontally-scrollable <table> elements.
// Everything else stays as pre-wrap text.
function splitRow(s) {
  let r = s.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split('|').map((c) => c.trim());
}

function renderOutput(text) {
  const lines = String(text).split('\n');
  let html = '';
  let buf = [];
  const flush = () => {
    if (buf.length) { html += `<div class="otext">${escapeHtml(buf.join('\n'))}</div>`; buf = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A table = a header row with "|", then a separator row whose cells are
    // all dash-runs (---, :--, --:, :-:) and whose column count matches.
    if (line.includes('|') && i + 1 < lines.length) {
      const header = splitRow(line);
      const sep = splitRow(lines[i + 1]);
      const sepOk = /-/.test(lines[i + 1]) && sep.length === header.length &&
        sep.every((c) => /^:?-+:?$/.test(c));
      if (sepOk) {
        flush();
        const aligns = sep.map((c) => {
          const l = c.startsWith(':'), r = c.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        const td = (txt, c, tag) => {
          const a = aligns[c] ? ` style="text-align:${aligns[c]}"` : '';
          return `<${tag}${a}>${escapeHtml(txt)}</${tag}>`;
        };
        let t = '<div class="tbl-wrap"><table class="md-tbl"><thead><tr>';
        header.forEach((h, c) => { t += td(h, c, 'th'); });
        t += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          const row = splitRow(lines[i]);
          t += '<tr>';
          for (let c = 0; c < header.length; c++) t += td(row[c] || '', c, 'td');
          t += '</tr>';
          i++;
        }
        html += t + '</tbody></table></div>';
        continue;
      }
    }
    buf.push(line);
    i++;
  }
  flush();
  return html;
}

function setOutput(el, text, isError) {
  el.refs.output.classList.toggle('err', !!isError);
  if (isError || !text) { el.refs.output.textContent = text || '(无输出)'; return; }
  el.refs.output.innerHTML = renderOutput(text);
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
    <div class="actions hidden"></div>
    <div class="overlay hidden"><div class="spinner"></div></div>`;
  el.refs = {
    badge: el.querySelector('.badge'),
    live: el.querySelector('.live-dot'),
    engine: el.querySelector('.engine'),
    prompt: el.querySelector('.prompt'),
    time: el.querySelector('.time'),
    output: el.querySelector('.output'),
    actions: el.querySelector('.actions'),
    overlay: el.querySelector('.overlay'),
  };
  el._es = null;
  el._open = false;
  el._task = t;
  el.querySelector('.header').addEventListener('click', () => toggleCard(el, t.id));
  state.cards.set(t.id, el);
  return el;
}

function showLoading(el, on) { el.refs.overlay.classList.toggle('hidden', !on); }

function updateCard(el, t) {
  el._task = t; // cache so opening is instant (no network round-trip)
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
  setOutput(el, t.output || t.error || '', err);
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

function toggleCard(el, id) {
  if (el._open) { closeCard(el); return; }
  el._open = true;
  el.refs.output.classList.remove('hidden');
  el.refs.actions.classList.remove('hidden');

  const t = el._task; // from the list — has status/prompt/… but NOT output/error
  if (t && t.stream && !DONE.has(t.status)) {
    // Live task: connect SSE; show overlay until the first data arrives.
    showLoading(el, true);
    startStream(el, t, () => showLoading(el, false));
  } else {
    // List is lightweight (no output); fetch the full task on open.
    showLoading(el, true);
    api(`/api/tasks/${id}`)
      .then((ft) => updateCard(el, ft))
      .catch(() => { el.refs.output.textContent = '加载失败,请重试'; })
      .finally(() => showLoading(el, false));
  }
}

function closeCard(el) {
  el._open = false;
  stopStream(el);
  showLoading(el, false);
  el.refs.output.classList.add('hidden');
  el.refs.actions.classList.add('hidden');
}

// ---- SSE live streaming ---------------------------------------------------
function startStream(el, t, onReady = () => {}) {
  let ready = false;
  const done1 = () => { if (!ready) { ready = true; onReady(); } };
  el.refs.output.classList.remove('err');
  el.refs.output.textContent = t.output || '';
  const es = new EventSource(`/api/tasks/${t.id}/stream?token=${encodeURIComponent(state.token)}`);
  el._es = es;
  updateCard(el, t); // shows LIVE dot + cancel button

  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    el.refs.output.textContent = snap.output || '';
    done1();
  });
  es.addEventListener('chunk', (e) => {
    el.refs.output.textContent += JSON.parse(e.data).text;
    el.refs.output.scrollTop = el.refs.output.scrollHeight;
    done1();
  });
  es.addEventListener('status', (e) => {
    el.dataset.status = JSON.parse(e.data).status;
  });
  es.addEventListener('done', async () => {
    stopStream(el);
    try { updateCard(el, await api(`/api/tasks/${t.id}`)); } catch {}
    done1();
  });
  es.onerror = () => { stopStream(el); done1(); };
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

// ---- MCP servers ----------------------------------------------------------
async function loadMcp() {
  try {
    const { servers } = await api('/api/mcp');
    if (!servers.length) { $('mcpList').textContent = '(未配置 MCP 服务器)'; return; }
    $('mcpList').innerHTML = servers.map((s) =>
      `<div class="mcprow"><span>${escapeHtml(s.name)} · ${escapeHtml(s.header_name)}:${escapeHtml(s.header_masked)}</span>` +
      `<button class="cancel" data-mcp="${escapeHtml(s.name)}">删除</button></div>`).join('');
    for (const b of document.querySelectorAll('[data-mcp]')) {
      b.addEventListener('click', () => deleteMcp(b.dataset.mcp));
    }
  } catch { /* ignore */ }
}
async function addMcp() {
  const body = {
    name: $('mcp-name').value.trim(), url: $('mcp-url').value.trim(),
    header_name: $('mcp-hname').value.trim(), header_value: $('mcp-hval').value.trim(),
  };
  $('mcpMsg').textContent = '保存中…';
  try {
    await api('/api/mcp', { method: 'POST', body: JSON.stringify(body) });
    $('mcpMsg').textContent = '已保存 ✓';
    $('mcp-hval').value = '';
    await loadMcp();
  } catch (e) { $('mcpMsg').textContent = e.message; }
}
async function deleteMcp(name) {
  if (!window.confirm(`删除 MCP 服务器 ${name}?`)) return;
  try { await api(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }); await loadMcp(); }
  catch (e) { alert(e.message); }
}
function fillMcp(name, url, header) {
  $('mcp-name').value = name; $('mcp-url').value = url; $('mcp-hname').value = header;
  $('mcp-hval').focus();
}

// ---- Sessions -------------------------------------------------------------
async function loadSessions() {
  const engine = $('engine').value;
  try {
    const { sessions } = await api(`/api/sessions?engine=${encodeURIComponent(engine)}`);
    state.sessions = sessions;
    const opts = ['<option value="">(不使用会话 · 一次性任务)</option>']
      .concat(sessions.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`))
      .concat(['<option value="__new__">＋ 新建会话…</option>']);
    $('session').innerHTML = opts.join('');
    if (state.currentSession && state.sessions.some((s) => s.id === state.currentSession)) {
      $('session').value = state.currentSession;
    } else {
      state.currentSession = '';
      $('session').value = '';
    }
    renderSessionBar();
  } catch { /* ignore */ }
}

function renderSessionBar() {
  $('sessionBar').classList.toggle('hidden', !state.currentSession);
  $('sessMsg').textContent = '';
  const cur = state.sessions.find((s) => s.id === state.currentSession);
  $('sessNoSync').checked = !!(cur && cur.sync_ignored);
  // Compress only applies to API engines; CLI engines (claude/codex) manage
  // their own context, so hide the button for them.
  const isApi = !!(cur && state.engineById[cur.engine]?.kind === 'api');
  $('sessCompress').classList.toggle('hidden', !isApi);

  // A session is bound to one working directory (set by its first task) and
  // never crosses directories. Once bound, show it read-only; an unbound
  // session lets the first task choose the dir.
  const cwdEl = $('cwd');
  if (cur && cur.cwd) {
    cwdEl.value = cur.cwd;
    cwdEl.disabled = true;
    cwdEl.title = '该会话已绑定此工作目录,不可更改';
  } else {
    if (cwdEl.disabled || cur) cwdEl.value = '';
    cwdEl.disabled = false;
    cwdEl.title = '';
  }
}

async function onSessionChange() {
  const v = $('session').value;
  if (v === '__new__') {
    const name = (window.prompt('新会话名称:') || '').trim();
    if (!name) { $('session').value = state.currentSession; return; }
    try {
      const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name, engine: $('engine').value }) });
      state.currentSession = s.id;
      await loadSessions();
      await loadMore(true);
    } catch (e) { alert(e.message); $('session').value = state.currentSession; }
    return;
  }
  state.currentSession = v;
  renderSessionBar();
  await loadMore(true); // history now shows this session (or all)
}

async function renameSession() {
  if (!state.currentSession) return;
  const cur = state.sessions.find((s) => s.id === state.currentSession);
  const name = (window.prompt('重命名会话:', cur?.name || '') || '').trim();
  if (!name) return;
  $('sessMsg').textContent = '重命名中…';
  try {
    // PATCH returns the persisted row; confirm the server actually saved it
    // (not just an optimistic local change) before telling the user it worked.
    const updated = await api(`/api/sessions/${state.currentSession}`, {
      method: 'PATCH', body: JSON.stringify({ name }),
    });
    await loadSessions();
    if (!updated || updated.name !== name) { $('sessMsg').textContent = '重命名可能未生效,请刷新确认'; return; }
    const sy = updated.engineSync || {};
    let tail = '';
    if (sy.when === 'now') tail = sy.ok ? ' · 已同步到引擎 ✓' : ` · 引擎同步失败(${sy.reason || '未知'})`;
    else if (sy.when === 'next-task') tail = ' · 将在下次任务同步到引擎';
    else if (sy.when === 'first-task') tail = ' · 首个任务时同步到引擎';
    $('sessMsg').textContent = `已重命名为「${name}」✓${tail}`;
  } catch (e) { $('sessMsg').textContent = `重命名失败:${e.message}`; }
}

async function deleteSession() {
  if (!state.currentSession) return;
  if (!window.confirm('删除该会话及其全部任务?不可恢复。')) return;
  try {
    await api(`/api/sessions/${state.currentSession}`, { method: 'DELETE' });
    state.currentSession = '';
    await loadSessions();
    await loadMore(true);
  } catch (e) { alert(e.message); }
}

async function compressSession() {
  if (!state.currentSession) return;
  $('sessMsg').textContent = '压缩中…';
  try {
    const r = await api(`/api/sessions/${state.currentSession}/compress`, { method: 'POST' });
    $('sessMsg').textContent = '已压缩 ✓(已把历史总结为摘要,后续更省上下文)';
  } catch (e) { $('sessMsg').textContent = e.message; }
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
    const base = state.currentSession ? `/api/sessions/${state.currentSession}/tasks` : '/api/tasks';
    const q = state.nextCursor ? `?cursor=${state.nextCursor}&limit=20` : '?limit=20';
    const { items, nextCursor } = await api(base + q);
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

$('mcp').addEventListener('change', () => {
  state.mcpPref = $('mcp').checked;
  localStorage.setItem('onlymind_mcp', state.mcpPref ? '1' : '0');
});

$('mcpAdd').addEventListener('click', addMcp);
$('mcpFillYmy').addEventListener('click', () => fillMcp('sellerspace', 'https://www.sellerspace.com/mcp/', 'x-api-key'));
$('mcpFillMjjl').addEventListener('click', () => fillMcp('sellersprite', 'https://mcp.sellersprite.com/mcp', 'secret-key'));
$('mcpCodexApply').addEventListener('click', async () => {
  $('mcpCodexMsg').textContent = '写入中…';
  try { const r = await api('/api/mcp/codex-apply', { method: 'POST' }); $('mcpCodexMsg').textContent = `已写入 Codex 配置(${r.count} 个服务器):${r.path}`; }
  catch (e) { $('mcpCodexMsg').textContent = e.message; }
});
$('mcpCodexClear').addEventListener('click', async () => {
  try { await api('/api/mcp/codex-clear', { method: 'POST' }); $('mcpCodexMsg').textContent = '已从 Codex 配置移除 OnlyMind 托管的 MCP 块。'; }
  catch (e) { $('mcpCodexMsg').textContent = e.message; }
});

$('engine').addEventListener('change', async () => {
  state.enginePref = $('engine').value;
  localStorage.setItem('onlymind_engine', state.enginePref);
  refreshEngineKeyUI();
  // Sessions are per-engine: reset selection and reload for the new engine.
  state.currentSession = '';
  await loadSessions();
  await loadMore(true);
});

$('session').addEventListener('change', onSessionChange);
$('sessRename').addEventListener('click', renameSession);
$('sessDelete').addEventListener('click', deleteSession);
$('sessCompress').addEventListener('click', compressSession);
$('sessNoSync').addEventListener('change', async () => {
  if (!state.currentSession) return;
  const ignored = $('sessNoSync').checked;
  try {
    await api(`/api/sessions/${state.currentSession}/sync-ignore`, { method: 'POST', body: JSON.stringify({ ignored }) });
    const cur = state.sessions.find((s) => s.id === state.currentSession);
    if (cur) cur.sync_ignored = ignored ? 1 : 0;
    $('sessMsg').textContent = ignored ? '已标记为不同步' : '已恢复同步';
  } catch (e) { $('sessMsg').textContent = e.message; $('sessNoSync').checked = !ignored; }
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
        mcp: state.mcpPref,
        session_id: state.currentSession || undefined,
      }),
    });
    $('prompt').value = '';
    $('submitMsg').textContent = '已提交 ✓';
    // The first task in a session binds its directory — refresh so the cwd
    // field reflects the now-bound dir (read-only).
    if (state.currentSession) await loadSessions();
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
  $('mcp').checked = state.mcpPref;
  if (!state.token) {
    $('settings').classList.remove('hidden');
    $('connStatus').textContent = '未设置令牌';
    return;
  }
  try {
    await api('/api/health');
    $('connStatus').textContent = '已连接 ✓';
    await loadEngines();
    await loadSessions();
    loadMcp();
    loadVersion();
    await loadMore(true);
  } catch (e) {
    $('settings').classList.remove('hidden');
    $('connStatus').textContent = e.message;
  }
}

init();
