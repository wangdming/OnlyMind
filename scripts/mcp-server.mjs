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
import { openDb, listSessions, getSession, sessionTasksFull, searchTasks } from '../src/db.js';

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ---- pure formatters (testable) ------------------------------------------
export function formatSessionList(rows, counts = {}) {
  if (!rows.length) return '(当前没有会话)';
  return rows.map((s) =>
    `- ${s.name}(引擎 ${s.engine},${counts[s.id] ?? '?'} 轮,更新 ${fmtTime(s.updated_at)})· id: ${s.id}`
  ).join('\n');
}

export function buildTranscript(session, tasks) {
  const head =
    `# 会话:${session.name}\n` +
    `引擎:${session.engine} · id:${session.id}\n` +
    `摘要:${session.summary || '(无)'}\n` +
    `共 ${tasks.length} 轮\n`;
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
    name: 'list_sessions',
    description: '列出 OnlyMind 里的会话(可按引擎过滤),含会话 id、名称、引擎、轮数、更新时间。',
    inputSchema: { type: 'object', properties: { engine: { type: 'string', description: 'claude|codex|openai|anthropic,可选' } }, required: [] },
  },
  {
    name: 'get_session_transcript',
    description: '获取某个会话的完整转录:摘要 + 每一轮的问题与完整回答(不截断)。用于续接 OnlyMind 处理过的工作。',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string', description: '会话 id(来自 list_sessions)' } }, required: ['session_id'] },
  },
  {
    name: 'search_tasks',
    description: '在所有任务的问题与回答里全文检索,返回匹配任务及其会话 id(再用 get_session_transcript 取完整内容)。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: '默认 20,最多 100' } }, required: ['query'] },
  },
];

export function runTool(db, name, args = {}) {
  if (name === 'list_sessions') {
    const rows = listSessions(db, args.engine ? { engine: args.engine } : {});
    const counts = {};
    for (const s of rows) counts[s.id] = sessionTasksFull(db, s.id).length;
    return formatSessionList(rows, counts);
  }
  if (name === 'get_session_transcript') {
    if (!args.session_id) throw new Error('缺少 session_id');
    const s = getSession(db, args.session_id);
    if (!s) throw new Error('未找到该会话');
    return buildTranscript(s, sessionTasksFull(db, args.session_id));
  }
  if (name === 'search_tasks') {
    if (!args.query) throw new Error('缺少 query');
    return formatSearch(searchTasks(db, String(args.query), args.limit));
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
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'onlymind', version: config.version || '0' } } });
      return;
    }
    if (id === undefined || id === null) return; // notification → no reply
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
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
