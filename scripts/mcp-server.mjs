#!/usr/bin/env node
// OnlyMind MCP server (stdio): exposes this computer's OnlyMind sessions/tasks
// to a local AI (Claude Code/Desktop, Codex, MCP-capable ChatGPT) so it can
// read what OnlyMind worked on and continue seamlessly.
//
// Read-only over the same SQLite DB. Hand-rolled minimal MCP (newline-delimited
// JSON-RPC 2.0 over stdio) — no extra dependency.
//
// Mount in Claude:  claude mcp add --scope user onlymind -- node <abs>/scripts/mcp-server.mjs
// (or: npm run mcp:claude)

import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import {
  openDb, getSession, sessionTasksFull, searchTasks,
  sessionSyncRows, sessionsNeedingSync, markSessionPulled, setSyncIgnored, sessionTasksSince,
} from '../src/db.js';

export const SERVER_INSTRUCTIONS =
  '本服务暴露本机 OnlyMind 的会话(由手机下发、在电脑上执行过的任务)。' +
  '当用户想"续接之前的工作"或你需要了解 OnlyMind 处理过什么时:\n' +
  '1) 先调用 check_sync 看有哪些会话"需要同步"(有新轮且未被忽略);\n' +
  '2) 对每个需要同步的会话调用 get_session_transcript 读取完整转录——读取后它会被自动标记为已同步,下次不再重复出现;\n' +
  '3) 续接工作:转录顶部若给出「原生续接命令」,且你能运行该引擎 CLI,优先用它直接续接引擎原生会话(上下文最完整)——' +
  'codex(codex exec resume <id>)任意目录可用;claude(claude --resume <id>)需在提示的目录下运行。否则基于转录继续。\n' +
  '其它:list_sessions 可浏览(only_new 只看有新内容的;标「可原生续接」者支持上面方式);search_tasks 全文检索;' +
  'set_sync_ignore 可把某会话标记为"不需要同步"(之后 check_sync 会跳过它);mark_synced 可不读取就标记已同步。';

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ---- pure formatters (testable) ------------------------------------------
export function formatSessionList(rows) {
  if (!rows.length) return '(当前没有会话)';
  return rows.map((s) => {
    const native = s.engine === 'codex' ? !!s.engine_session_id : (s.engine === 'claude' && (s.total ?? 0) > 0);
    return `- ${s.name}(引擎 ${s.engine},共 ${s.total ?? '?'} 轮,待同步 ${s.pending ?? 0})` +
      (s.sync_ignored ? ' [已忽略]' : '') + (native ? ' · 可原生续接' : '') + ` · id: ${s.id}`;
  }).join('\n');
}

export function formatSyncCheck(needing) {
  if (!needing.length) return '没有需要同步的会话(已全部同步,或被标记为不同步)。';
  return `有 ${needing.length} 个会话需要同步:\n` +
    needing.map((s) => `- ${s.name}(id: ${s.id},新 ${s.pending} 轮,引擎 ${s.engine})`).join('\n') +
    '\n用 get_session_transcript 读取完整转录(读取即视为已同步)。';
}

// Native-resume hint so a local AI can continue the engine's OWN session
// (fuller context than a text transcript). Pure/testable.
//  - claude: resume id is OnlyMind's session id; cwd-scoped (claude archives
//    transcripts per project dir), so the cwd must match where tasks ran.
//    Only available once the session has had a turn (total > 0).
//  - codex: resume id is the captured thread id; works from any cwd.
//  - api engines: no engine-side session → null (use the transcript).
export function buildResumeHint(session, cwd, total) {
  if (session.engine === 'claude') {
    if (typeof total === 'number' && total <= 0) return null;
    return {
      engine: 'claude', id: session.id, cwd: cwd || null,
      command: `claude --resume ${session.id}`,
      note: cwd
        ? `需在目录「${cwd}」下运行(claude 按项目目录归档会话)`
        : '需在该会话任务当初运行的目录下运行(claude 按项目目录归档会话)',
    };
  }
  if (session.engine === 'codex') {
    if (!session.engine_session_id) return null;
    return {
      engine: 'codex', id: session.engine_session_id, cwd: null,
      command: `codex exec resume ${session.engine_session_id}`,
      note: '任意目录均可',
    };
  }
  return null; // api engines: no engine-side session
}

export function formatResumeHint(hint) {
  if (!hint) return '';
  return '续接方式(二选一):\n' +
    `- 原生续接(推荐,上下文最完整):若你能运行该引擎 CLI,执行 \`${hint.command}\` —— ${hint.note}\n` +
    '- 或:基于下方转录继续\n';
}

export function buildTranscript(session, tasks, partial = false, resumeHint = null) {
  const head =
    `# 会话:${session.name}\n` +
    `引擎:${session.engine} · id:${session.id}\n` +
    `摘要:${session.summary || '(无)'}\n` +
    formatResumeHint(resumeHint) +
    (partial ? `增量:上次同步之后的新 ${tasks.length} 轮\n` : `共 ${tasks.length} 轮\n`);
  const body = tasks.map((t, i) => {
    let s = `\n## [${i + 1}] ${t.status} · ${fmtTime(t.created_at)}\n【问】\n${t.prompt}\n【答】\n${t.output ?? ''}`;
    if (t.status === 'failed' && t.error) s += `\n【错误】\n${t.error}`;
    return s;
  }).join('\n');
  return head + body;
}

export function formatSearch(rows) {
  if (!rows.length) return '(没有匹配的任务)';
  return rows.map((t) => {
    const prompt = (t.prompt || '').replace(/\s+/g, ' ').slice(0, 120);
    const output = (t.output || '').replace(/\s+/g, ' ').slice(0, 200);
    return `- [${t.engine}/${t.status}] ${fmtTime(t.created_at)} · 任务 ${t.id}` +
      (t.session_id ? ` · 会话 ${t.session_id}` : '') +
      `\n  问:${prompt}\n  答:${output}`;
  }).join('\n');
}

export const TOOLS = [
  {
    name: 'check_sync',
    description: '检查有哪些 OnlyMind 会话"需要同步"(有新轮、且未被标记为不同步)。续接工作前先调用它。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_sessions',
    description: '列出 OnlyMind 会话,含 id/名称/引擎/总轮数/待同步轮数/是否已忽略。only_new=true 只看有新内容的;include_ignored=true 含已忽略。',
    inputSchema: { type: 'object', properties: { engine: { type: 'string', description: 'claude|codex|openai|anthropic,可选' }, only_new: { type: 'boolean' }, include_ignored: { type: 'boolean' } }, required: [] },
  },
  {
    name: 'get_session_transcript',
    description: '获取会话完整转录(摘要 + 每轮问/答全文,不截断),用于续接。读取后该会话自动标记为已同步。since_last_pull=true 只取上次同步之后的新轮(增量)。',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, since_last_pull: { type: 'boolean' } }, required: ['session_id'] },
  },
  {
    name: 'search_tasks',
    description: '在所有任务的问题与回答里全文检索,返回匹配任务及其会话 id(再用 get_session_transcript 取完整内容)。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: '默认 20,最多 100' } }, required: ['query'] },
  },
  {
    name: 'set_sync_ignore',
    description: '把某会话标记为"不需要同步"(ignored=true)或恢复(ignored=false)。被忽略的会话不会出现在 check_sync 里。',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, ignored: { type: 'boolean', description: '默认 true' } }, required: ['session_id'] },
  },
  {
    name: 'mark_synced',
    description: '不读取内容也把某会话标记为已同步(把同步标记推进到最新)。',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
];

export const PROMPTS = [
  { name: 'sync', description: '检查并同步 OnlyMind 待同步会话,然后继续这些工作', arguments: [] },
];
export function getPrompt(name) {
  if (name !== 'sync') throw new Error('未知 prompt: ' + name);
  return {
    description: '检查并同步 OnlyMind 待同步会话',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: '请调用 check_sync 检查有无需要同步的 OnlyMind 会话。若有,逐个用 get_session_transcript 读取完整转录(读取即自动标记已同步)。续接时:转录顶部若给出「原生续接命令」且你能运行该引擎 CLI,优先据此直接续接引擎原生会话(codex 任意目录、claude 需在提示目录);否则基于转录继续。已被标记为不同步的会话会自动跳过。',
      },
    }],
  };
}

export function runTool(db, name, args = {}) {
  if (name === 'check_sync') {
    return formatSyncCheck(sessionsNeedingSync(db));
  }
  if (name === 'list_sessions') {
    let rows = sessionSyncRows(db, args.engine ? { engine: args.engine } : {});
    if (!args.include_ignored) rows = rows.filter((s) => !s.sync_ignored);
    if (args.only_new) rows = rows.filter((s) => s.pending > 0);
    return formatSessionList(rows);
  }
  if (name === 'get_session_transcript') {
    if (!args.session_id) throw new Error('缺少 session_id');
    const s = getSession(db, args.session_id);
    if (!s) throw new Error('未找到该会话');
    const full = sessionTasksFull(db, s.id); // for cwd + total (native-resume hint)
    const tasks = args.since_last_pull
      ? sessionTasksSince(db, s.id, s.last_pulled_at || 0)
      : full;
    // The session is bound to one directory (set on its first task), so use it
    // directly for claude's dir-scoped --resume hint.
    const cwd = s.cwd || config.defaultCwd;
    const hint = buildResumeHint(s, cwd, full.length);
    const text = buildTranscript(s, tasks, !!args.since_last_pull, hint);
    markSessionPulled(db, s.id, Date.now()); // reading = synced up to now
    return text;
  }
  if (name === 'search_tasks') {
    if (!args.query) throw new Error('缺少 query');
    return formatSearch(searchTasks(db, String(args.query), args.limit));
  }
  if (name === 'set_sync_ignore') {
    if (!args.session_id) throw new Error('缺少 session_id');
    const ignored = args.ignored !== false;
    const s = setSyncIgnored(db, args.session_id, ignored);
    if (!s) throw new Error('未找到该会话');
    return `已将会话「${s.name}」标记为${ignored ? '不需要同步' : '需要同步'}。`;
  }
  if (name === 'mark_synced') {
    if (!args.session_id) throw new Error('缺少 session_id');
    const s = getSession(db, args.session_id);
    if (!s) throw new Error('未找到该会话');
    markSessionPulled(db, s.id, Date.now());
    return `已将会话「${s.name}」标记为已同步。`;
  }
  throw new Error('未知工具: ' + name);
}

// ---- stdio JSON-RPC loop (when run as a server) ---------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const db = openDb(config.dbPath);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  function handle(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    const { id, method, params } = m;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'onlymind', version: config.version || '0' }, instructions: SERVER_INSTRUCTIONS } });
      return;
    }
    if (id === undefined || id === null) return; // notification → no reply
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { prompts: PROMPTS } }); return; }
    if (method === 'prompts/get') {
      try { send({ jsonrpc: '2.0', id, result: getPrompt(params?.name) }); }
      catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32602, message: e.message } }); }
      return;
    }
    if (method === 'tools/call') {
      try { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: runTool(db, params?.name, params?.arguments || {}) }] } }); }
      catch (e) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误:' + e.message }], isError: true } }); }
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) handle(line); }
  });
  process.stdin.on('end', () => process.exit(0));
}
