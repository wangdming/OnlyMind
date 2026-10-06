import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import {
  insertTask, getTask, listTasks, setSetting,
  createSession, getSession, listSessions, renameSession, deleteSession, touchSession,
  sessionHistory, setSessionSummary, setSyncIgnored,
  listMcpServers, setMcpServer, deleteMcpServer,
} from './db.js';
import { isValidEngine, engineList, ENGINES } from './engines.js';
import { validateKey, complete } from './providers.js';
import { syncCodexConfig } from './codexmcp.js';
import { taskBus } from './events.js';

/**
 * Build the Fastify app. Dependencies are injected so tests can supply an
 * in-memory DB and a fake queue.
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {{enqueue:(id:string)=>void, size:number}} deps.queue
 * @param {string} deps.token
 * @param {string} [deps.publicDir]  if set, serves the web client
 * @param {()=>number} [deps.now]
 */
// Compare "a.b.c" version strings. Returns >0 if a newer than b.
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

export function buildServer({ db, queue, token, publicDir, version = '0.0.0', repoSlug = null, getApiKey = () => null, models = {}, codexConfigPath = null, now = () => Date.now() }) {
  const app = Fastify({ logger: false });

  // --- Auth: every /api route requires a valid token ----------------------
  // Accept either `Authorization: Bearer <token>` or `?token=<token>`.
  // The query form lets the browser EventSource (SSE) authenticate, since it
  // cannot set custom headers.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers['authorization'] || '';
    const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : null;
    const fromQuery = typeof req.query?.token === 'string' ? req.query.token : null;
    const supplied = fromHeader || fromQuery;
    if (!supplied || supplied !== token) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // --- Routes -------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, queued: queue.size }));

  // Current version + (cached) latest GitHub release, so the phone can show an
  // "update available" hint. The computer fetches GitHub (cached 6h); the phone
  // only reads the result. Failures degrade gracefully to latest=null.
  let latestCache = { value: null, at: 0 };
  const LATEST_TTL = 6 * 60 * 60 * 1000;
  async function getLatest() {
    if (!repoSlug) return null;
    if (latestCache.at && now() - latestCache.at < LATEST_TTL) return latestCache.value;
    let value = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
        headers: { 'User-Agent': 'OnlyMind', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) value = ((await res.json()).tag_name || '').replace(/^v/, '') || null;
    } catch { /* offline / rate-limited: keep null */ }
    latestCache = { value, at: now() };
    return value;
  }

  app.get('/api/version', async () => {
    const latest = await getLatest();
    return {
      current: version,
      latest: latest || null,
      updateAvailable: !!latest && cmpVer(latest, version) > 0,
    };
  });

  app.get('/api/engines', async () => ({ engines: engineList((p) => !!getApiKey(p)) }));

  // Which providers already have a key stored (never returns the key itself).
  app.get('/api/keys', async () => ({
    openai: !!getApiKey('openai'),
    anthropic: !!getApiKey('anthropic'),
  }));

  // Validate an API key against the provider; store it only if valid.
  app.post('/api/keys', async (req, reply) => {
    const body = req.body || {};
    const provider = body.provider;
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!['openai', 'anthropic'].includes(provider)) return reply.code(400).send({ ok: false, error: `未知提供方: ${provider}` });
    if (!key) return reply.code(400).send({ ok: false, error: 'API Key 不能为空' });
    const result = await validateKey(provider, key);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    setSetting(db, `${provider}_api_key`, key);
    return { ok: true };
  });

  // --- MCP servers (for CLI engines to connect external tools) ------------
  const maskVal = (v) => (v && v.length > 6 ? v.slice(0, 3) + '…' + v.slice(-2) : '••••');
  app.get('/api/mcp', async () => ({
    servers: listMcpServers(db).map((s) => ({ name: s.name, url: s.url, header_name: s.header_name, header_masked: maskVal(s.header_value) })),
  }));
  app.post('/api/mcp', async (req, reply) => {
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    const header_name = typeof b.header_name === 'string' ? b.header_name.trim() : '';
    const header_value = typeof b.header_value === 'string' ? b.header_value.trim() : '';
    if (!name || !url || !header_name || !header_value) return reply.code(400).send({ error: 'name/url/header_name/header_value 均为必填' });
    if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: 'url 必须以 http(s):// 开头' });
    setMcpServer(db, { name, url, header_name, header_value, now: now() });
    return reply.code(201).send({ ok: true });
  });
  app.delete('/api/mcp/:name', async (req, reply) => {
    const ok = deleteMcpServer(db, req.params.name);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // Write all configured MCP servers into Codex's config.toml (one-click auto-config).
  app.post('/api/mcp/codex-apply', async (req, reply) => {
    if (!codexConfigPath) return reply.code(500).send({ error: 'codex 配置路径未知' });
    try {
      const servers = listMcpServers(db);
      const r = syncCodexConfig(codexConfigPath, servers);
      return { ok: true, path: r.path, count: r.count };
    } catch (e) { return reply.code(500).send({ error: '写入 Codex 配置失败:' + e.message }); }
  });
  // Remove the OnlyMind-managed block from Codex's config.toml.
  app.post('/api/mcp/codex-clear', async (req, reply) => {
    if (!codexConfigPath) return reply.code(500).send({ error: 'codex 配置路径未知' });
    try { const r = syncCodexConfig(codexConfigPath, []); return { ok: true, path: r.path }; }
    catch (e) { return reply.code(500).send({ error: '清除失败:' + e.message }); }
  });

  app.post('/api/tasks', async (req, reply) => {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const engine = body.engine || 'claude';
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
    const stream = body.stream === true || body.stream === 1 || body.stream === '1';
    // Concise defaults to ON unless explicitly disabled.
    const concise = body.concise !== false && body.concise !== 0 && body.concise !== '0';

    const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : null;
    const mcp = body.mcp === true || body.mcp === 1 || body.mcp === '1';

    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
    if (!isValidEngine(engine)) return reply.code(400).send({ error: `unknown engine: ${engine}` });
    const eng = ENGINES[engine];
    if (eng.kind === 'api' && !getApiKey(eng.provider)) {
      return reply.code(400).send({ error: `引擎 ${engine} 需要先设置 ${eng.provider} API Key` });
    }
    if (sessionId) {
      const s = getSession(db, sessionId);
      if (!s) return reply.code(404).send({ error: 'session not found' });
      if (s.engine !== engine) return reply.code(400).send({ error: `会话绑定引擎 ${s.engine},与任务引擎 ${engine} 不一致` });
    }

    const task = insertTask(db, { id: randomUUID(), prompt, engine, cwd, stream, concise, session_id: sessionId, mcp, created_at: now() });
    if (sessionId) touchSession(db, sessionId, now());
    queue.enqueue(task.id);
    return reply.code(201).send(task);
  });

  // --- Sessions -----------------------------------------------------------
  app.get('/api/sessions', async (req) => {
    const engine = req.query?.engine;
    return { sessions: listSessions(db, engine ? { engine } : {}) };
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '';
    const engine = body.engine;
    if (!name) return reply.code(400).send({ error: 'name is required' });
    if (!isValidEngine(engine)) return reply.code(400).send({ error: `unknown engine: ${engine}` });
    const s = createSession(db, { id: randomUUID(), name, engine, now: now() });
    return reply.code(201).send(s);
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const s = getSession(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return s;
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const s = getSession(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name is required' });
    return renameSession(db, req.params.id, name, now());
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const s = getSession(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const removed = deleteSession(db, req.params.id);
    return { ok: true, removedTasks: removed };
  });

  // Mark a session as "don't sync to local AI" (or restore). Used by the phone UI.
  app.post('/api/sessions/:id/sync-ignore', async (req, reply) => {
    const s = getSession(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const ignored = req.body?.ignored !== false;
    return setSyncIgnored(db, req.params.id, ignored);
  });

  app.get('/api/sessions/:id/tasks', async (req, reply) => {
    const s = getSession(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { cursor, limit } = req.query || {};
    return listTasks(db, { cursor, limit, sessionId: req.params.id });
  });

  // Compress a session's history into a summary (saves context/tokens).
  // Supported for API engines (openai/anthropic); claude manages its own context.
  app.post('/api/sessions/:id/compress', async (req, reply) => {
    const s = getSession(db, req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const eng = ENGINES[s.engine];
    if (!eng || eng.kind !== 'api') {
      return reply.code(400).send({ error: '当前仅 API 引擎(OpenAI/Anthropic)支持压缩;CLI 引擎自行维护上下文' });
    }
    const key = getApiKey(eng.provider);
    if (!key) return reply.code(400).send({ error: `需要先设置 ${eng.provider} API Key` });
    const all = sessionHistory(db, s.id);
    if (all.length === 0) return reply.code(400).send({ error: '该会话暂无可压缩的历史' });

    const transcript = all.map((t) => `【我】${t.prompt}\n【你】${t.output ?? ''}`).join('\n\n');
    const base = s.summary ? `已有摘要:\n${s.summary}\n\n新的对话:\n` : '';
    const prompt = `请把下面的多轮对话压缩成简洁的中文要点摘要,保留关键事实、结论、决定与未决问题,供后续对话作为上下文。只输出摘要正文,不要多余说明。\n\n${base}${transcript}`;
    const model = eng.provider === 'openai' ? models.openai : models.anthropic;
    const result = await complete(eng.provider, { prompt, key, concise: false, stream: false, model, maxTokens: models.anthropicMaxTokens });
    if (result.status !== 'done' || !result.output) {
      return reply.code(502).send({ error: result.error || '压缩失败' });
    }
    const updated = setSessionSummary(db, s.id, result.output, all.length, now());
    return { ok: true, summary: updated.summary, turns_before_summary: updated.turns_before_summary };
  });

  // Cancel a queued or running task.
  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const task = getTask(db, req.params.id);
    if (!task) return reply.code(404).send({ error: 'not found' });
    const updated = queue.cancel(req.params.id);
    if (!updated) return reply.code(409).send({ error: `cannot cancel task in status '${task.status}'` });
    return updated;
  });

  // Re-run a task: create a fresh task copying its prompt/engine/cwd/stream.
  app.post('/api/tasks/:id/rerun', async (req, reply) => {
    const src = getTask(db, req.params.id);
    if (!src) return reply.code(404).send({ error: 'not found' });
    const task = insertTask(db, {
      id: randomUUID(), prompt: src.prompt, engine: src.engine, cwd: src.cwd,
      stream: src.stream, concise: src.concise, created_at: now(),
    });
    queue.enqueue(task.id);
    return reply.code(201).send(task);
  });

  // Live output stream (SSE). Sends a snapshot, then deltas, then a done event.
  app.get('/api/tasks/:id/stream', (req, reply) => {
    const id = req.params.id;
    const task = getTask(db, id);
    if (!task) return reply.code(404).send({ error: 'not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Initial snapshot (includes any output accumulated so far).
    send('snapshot', task);

    // If already finished, close immediately after the snapshot.
    if (['done', 'failed', 'canceled'].includes(task.status)) {
      send('done', { status: task.status });
      reply.raw.end();
      return;
    }

    const onChunk = (text) => send('chunk', { text });
    const onStatus = (t) => {
      send('status', t);
      if (['done', 'failed', 'canceled'].includes(t.status)) {
        send('done', { status: t.status });
        cleanup();
        reply.raw.end();
      }
    };
    function cleanup() {
      taskBus.off(`chunk:${id}`, onChunk);
      taskBus.off(`status:${id}`, onStatus);
    }
    taskBus.on(`chunk:${id}`, onChunk);
    taskBus.on(`status:${id}`, onStatus);
    req.raw.on('close', cleanup);
  });

  app.get('/api/tasks', async (req) => {
    const { cursor, limit } = req.query || {};
    return listTasks(db, { cursor, limit });
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const task = getTask(db, req.params.id);
    if (!task) return reply.code(404).send({ error: 'not found' });
    return task;
  });

  // --- Static web client --------------------------------------------------
  if (publicDir) {
    app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  }

  return app;
}
