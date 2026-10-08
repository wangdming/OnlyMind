import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, insertTask, listTasks, getTask, markFinished,
  createSession, getSession, sessionHistory, setSessionSummary, sessionTasksFull, searchTasks,
  sessionsNeedingSync, setSyncIgnored, setSessionEngineId,
} from '../src/db.js';
import { buildTranscript, formatSessionList, formatSearch, runTool, getPrompt, buildResumeHint, formatResumeHint } from '../scripts/mcp-server.mjs';
import { createQueue } from '../src/queue.js';
import { buildServer } from '../src/server.js';
import { ENGINES } from '../src/engines.js';
import { spawnRunner, claudeSessionArgs, parseCodexSessionId, cliTranscript, buildClaudeMcpConfig } from '../src/runner.js';
import { assembleContext } from '../src/providers.js';
import { buildCodexMcpToml, syncCodexConfig, MARK_START, MARK_END } from '../src/codexmcp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'test-token';

function fakeQueue() {
  const enqueued = [];
  return { enqueue: (id) => enqueued.push(id), get size() { return enqueued.length; }, enqueued };
}

function makeApp() {
  const db = openDb(':memory:');
  const queue = fakeQueue();
  let clock = 1000;
  const now = () => ++clock;
  const app = buildServer({ db, queue, token: TOKEN, now });
  return { db, queue, app, now };
}

function auth(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

test('rejects requests without a valid token', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/tasks' });
  assert.equal(res.statusCode, 401);

  const bad = await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.statusCode, 401);
});

test('POST /api/tasks creates a queued task and enqueues it', async () => {
  const { app, queue } = makeApp();
  const res = await app.inject({
    method: 'POST', url: '/api/tasks', headers: auth(),
    payload: { prompt: '  hello world  ', engine: 'claude', cwd: '/tmp' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.prompt, 'hello world'); // trimmed
  assert.equal(body.status, 'queued');
  assert.equal(body.engine, 'claude');
  assert.equal(body.cwd, '/tmp');
  assert.equal(queue.enqueued.length, 1);
  assert.equal(queue.enqueued[0], body.id);
});

test('POST validates prompt and engine', async () => {
  const { app } = makeApp();
  const noPrompt = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: '   ' } });
  assert.equal(noPrompt.statusCode, 400);

  const badEngine = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', engine: 'gpt' } });
  assert.equal(badEngine.statusCode, 400);
});

test('defaults engine to claude', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x' } });
  assert.equal(res.json().engine, 'claude');
});

test('GET /api/tasks/:id returns a task or 404', async () => {
  const { app } = makeApp();
  const created = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'abc' } })).json();
  const got = await app.inject({ method: 'GET', url: `/api/tasks/${created.id}`, headers: auth() });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().prompt, 'abc');

  const missing = await app.inject({ method: 'GET', url: '/api/tasks/does-not-exist', headers: auth() });
  assert.equal(missing.statusCode, 404);
});

test('cursor pagination returns newest-first pages without overlap', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 5; i++) {
    insertTask(db, { id: `id-${i}`, prompt: `p${i}`, engine: 'claude', cwd: null, created_at: 1000 + i });
  }
  const page1 = listTasks(db, { limit: 2 });
  assert.deepEqual(page1.items.map((t) => t.id), ['id-4', 'id-3']);
  assert.equal(page1.nextCursor, 1003);

  const page2 = listTasks(db, { cursor: page1.nextCursor, limit: 2 });
  assert.deepEqual(page2.items.map((t) => t.id), ['id-2', 'id-1']);

  const page3 = listTasks(db, { cursor: page2.nextCursor, limit: 2 });
  assert.deepEqual(page3.items.map((t) => t.id), ['id-0']);
  assert.equal(page3.nextCursor, null);
});

test('queue runs tasks serially and persists results', async () => {
  const db = openDb(':memory:');
  const order = [];
  let active = 0, maxActive = 0;
  let clock = 0;
  const run = async (task) => {
    active++; maxActive = Math.max(maxActive, active);
    order.push(task.id);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { status: 'done', output: `out:${task.prompt}`, error: null, exitCode: 0 };
  };
  const queue = createQueue({ db, run, now: () => ++clock });

  for (let i = 0; i < 3; i++) {
    const t = insertTask(db, { id: `t${i}`, prompt: `p${i}`, engine: 'claude', cwd: null, created_at: clock + 1 });
    queue.enqueue(t.id);
  }
  await queue.drain();

  assert.equal(maxActive, 1, 'tasks must not overlap (concurrency = 1)');
  assert.deepEqual(order, ['t0', 't1', 't2']);
  const done = listTasks(db, { limit: 10 }).items;
  assert.ok(done.every((t) => t.status === 'done'));
  assert.equal(done[0].output, undefined, 'list must NOT include heavy output');
  // output is available via getTask (full fetch on open)
  assert.ok(done.every((t) => getTask(db, t.id).output.startsWith('out:')));
});

test('queue records failures from the runner', async () => {
  const db = openDb(':memory:');
  let clock = 0;
  const run = async () => ({ status: 'failed', output: null, error: 'boom', exitCode: 1 });
  const queue = createQueue({ db, run, now: () => ++clock });
  const t = insertTask(db, { id: 'f1', prompt: 'x', engine: 'claude', cwd: null, created_at: 1 });
  queue.enqueue(t.id);
  await queue.drain();
  const got = getTask(db, 'f1');
  assert.equal(got.status, 'failed');
  assert.equal(got.error, 'boom');
  assert.equal(got.exit_code, 1);
});

test('startup fails orphaned running tasks', async () => {
  const db = openDb(':memory:');
  insertTask(db, { id: 'orphan', prompt: 'x', engine: 'claude', cwd: null, created_at: 1 });
  db.prepare(`UPDATE tasks SET status='running' WHERE id='orphan'`).run();
  // Constructing a queue should recover orphans.
  createQueue({ db, run: async () => ({ status: 'done' }), now: () => 99 });
  const got = getTask(db, 'orphan');
  assert.equal(got.status, 'failed');
  assert.match(got.error, /restart/i);
});

test('claude engine parses JSON envelope result', () => {
  const parsed = ENGINES.claude.parse(JSON.stringify({ result: 'the answer', type: 'result' }));
  assert.equal(parsed, 'the answer');
  // Falls back to raw stdout for non-JSON.
  assert.equal(ENGINES.claude.parse('plain text'), 'plain text');
});

test('claude stream parser extracts deltas and final result', () => {
  const { line } = ENGINES.claude.stream;
  assert.deepEqual(line('{"type":"system","subtype":"init"}'), {});
  const assistant = line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } }));
  assert.deepEqual(assistant, { delta: 'pong' });
  const result = line(JSON.stringify({ type: 'result', result: 'final answer' }));
  assert.deepEqual(result, { final: 'final answer' });
  // Non-JSON passes through as a delta.
  assert.deepEqual(line('raw text'), { delta: 'raw text' });
});

test('POST accepts stream flag', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', stream: true } });
  assert.equal(res.json().stream, 1);
  const res2 = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'y' } });
  assert.equal(res2.json().stream, 0);
});

test('cancel a queued task marks it canceled and removes from queue', async () => {
  const db = openDb(':memory:');
  let clock = 0;
  let gate; // never resolves until we let it
  const blocker = new Promise((r) => { gate = r; });
  // First task blocks the worker so the second stays queued.
  const run = async (task, { signal }) => {
    if (task.id === 't-block') { await blocker; return { status: 'done', output: 'ok', error: null, exitCode: 0 }; }
    return { status: 'done', output: 'ok', error: null, exitCode: 0 };
  };
  const queue = createQueue({ db, run, now: () => ++clock });
  insertTask(db, { id: 't-block', prompt: 'a', engine: 'claude', cwd: null, created_at: 1 });
  insertTask(db, { id: 't-wait', prompt: 'b', engine: 'claude', cwd: null, created_at: 2 });
  queue.enqueue('t-block');
  queue.enqueue('t-wait');
  await new Promise((r) => setTimeout(r, 10)); // let worker pick up t-block

  const canceled = queue.cancel('t-wait');
  assert.equal(canceled.status, 'canceled');
  gate(); // unblock
  await queue.drain();
  assert.equal(getTask(db, 't-wait').status, 'canceled');
  assert.equal(getTask(db, 't-block').status, 'done');
});

test('cancel a running task aborts it via signal', async () => {
  const db = openDb(':memory:');
  let clock = 0;
  const run = (task, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () =>
        resolve({ status: 'canceled', output: null, error: 'Canceled by user', exitCode: null }));
    });
  const queue = createQueue({ db, run, now: () => ++clock });
  insertTask(db, { id: 'r1', prompt: 'x', engine: 'claude', cwd: null, created_at: 1 });
  queue.enqueue('r1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getTask(db, 'r1').status, 'running');

  queue.cancel('r1');
  await queue.drain();
  assert.equal(getTask(db, 'r1').status, 'canceled');
});

test('cannot cancel a finished task (HTTP 409)', async () => {
  const db = openDb(':memory:');
  const queue = createQueue({ db, run: async () => ({ status: 'done', output: 'ok' }), now: (() => { let c = 0; return () => ++c; })() });
  const app = buildServer({ db, queue, token: TOKEN });
  const created = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x' } })).json();
  await queue.drain();
  const res = await app.inject({ method: 'POST', url: `/api/tasks/${created.id}/cancel`, headers: auth() });
  assert.equal(res.statusCode, 409);
});

test('rerun copies a task into a new queued task', async () => {
  const db = openDb(':memory:');
  const queue = createQueue({ db, run: async () => ({ status: 'done', output: 'ok' }), now: (() => { let c = 100; return () => ++c; })() });
  const app = buildServer({ db, queue, token: TOKEN });
  const created = (await app.inject({
    method: 'POST', url: '/api/tasks', headers: auth(),
    payload: { prompt: 'do it', engine: 'claude', cwd: '/tmp', stream: true },
  })).json();
  await queue.drain();

  const rerun = await app.inject({ method: 'POST', url: `/api/tasks/${created.id}/rerun`, headers: auth() });
  assert.equal(rerun.statusCode, 201);
  const body = rerun.json();
  assert.notEqual(body.id, created.id);
  assert.equal(body.prompt, 'do it');
  assert.equal(body.cwd, '/tmp');
  assert.equal(body.stream, 1);
  assert.equal(body.status, 'queued');
});

test('engines list includes API engines with needsKey/keySet', async () => {
  const { app } = makeApp();
  const { engines } = (await app.inject({ method: 'GET', url: '/api/engines', headers: auth() })).json();
  const openai = engines.find((e) => e.id === 'openai');
  assert.equal(openai.kind, 'api');
  assert.equal(openai.needsKey, true);
  assert.equal(openai.keySet, false); // no getApiKey in makeApp
  const claude = engines.find((e) => e.id === 'claude');
  assert.equal(claude.kind, 'cli');
  assert.equal(claude.keySet, true); // cli never needs a key
});

test('API-engine task without a key is rejected (400)', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'hi', engine: 'openai' } });
  assert.equal(res.statusCode, 400);
});

test('/api/keys status + validation of provider/key', async () => {
  const { app } = makeApp();
  const st = (await app.inject({ method: 'GET', url: '/api/keys', headers: auth() })).json();
  assert.equal(st.openai, false);
  assert.equal(st.anthropic, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/keys', headers: auth(), payload: { provider: 'nope', key: 'k' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/keys', headers: auth(), payload: { provider: 'openai', key: '' } })).statusCode, 400);
});

test('injected getApiKey enables the API engine (keySet + task accepted)', async () => {
  const db = openDb(':memory:');
  const queue = fakeQueue();
  const app = buildServer({ db, queue, token: TOKEN, getApiKey: (p) => (p === 'openai' ? 'sk-test' : null) });
  const { engines } = (await app.inject({ method: 'GET', url: '/api/engines', headers: auth() })).json();
  assert.equal(engines.find((e) => e.id === 'openai').keySet, true);
  assert.equal(engines.find((e) => e.id === 'anthropic').keySet, false);
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'hi', engine: 'openai' } });
  assert.equal(res.statusCode, 201);
});

test('runner fails an API task when no key is configured', async () => {
  const run = spawnRunner({ defaultCwd: '/tmp', taskTimeoutMs: 1000, getApiKey: () => null, models: {} });
  const r = await run({ engine: 'openai', prompt: 'x' }, {});
  assert.equal(r.status, 'failed');
  assert.match(r.error, /API Key/);
});

test('sessions: create / list / filter-by-engine / rename', async () => {
  const { app } = makeApp();
  const created = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: '  翻译项目  ', engine: 'claude' } })).json();
  assert.equal(created.name, '翻译项目');
  assert.equal(created.engine, 'claude');
  assert.ok(created.id);
  // bad engine / empty name
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'x', engine: 'gpt' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: '', engine: 'claude' } })).statusCode, 400);
  // another engine's session, then filter
  await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'gpt 会话', engine: 'openai' } });
  const all = (await app.inject({ method: 'GET', url: '/api/sessions', headers: auth() })).json().sessions;
  assert.equal(all.length, 2);
  const onlyClaude = (await app.inject({ method: 'GET', url: '/api/sessions?engine=claude', headers: auth() })).json().sessions;
  assert.equal(onlyClaude.length, 1);
  assert.equal(onlyClaude[0].engine, 'claude');
  // rename
  const renamed = (await app.inject({ method: 'PATCH', url: `/api/sessions/${created.id}`, headers: auth(), payload: { name: '新名字' } })).json();
  assert.equal(renamed.name, '新名字');
});

test('task with session_id: validation + binding + session task list', async () => {
  const { app, db } = makeApp();
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 's', engine: 'claude' } })).json();
  // engine mismatch -> 400
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', engine: 'codex', session_id: s.id } })).statusCode, 400);
  // nonexistent session -> 404
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', engine: 'claude', session_id: 'nope' } })).statusCode, 404);
  // valid
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'hi', engine: 'claude', session_id: s.id } })).json();
  assert.equal(t.session_id, s.id);
  const inSession = (await app.inject({ method: 'GET', url: `/api/sessions/${s.id}/tasks`, headers: auth() })).json();
  assert.equal(inSession.items.length, 1);
  assert.equal(inSession.items[0].id, t.id);
});

test('delete session cascades to its tasks', async () => {
  const { app, db } = makeApp();
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 's', engine: 'claude' } })).json();
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'hi', engine: 'claude', session_id: s.id } })).json();
  const del = (await app.inject({ method: 'DELETE', url: `/api/sessions/${s.id}`, headers: auth() })).json();
  assert.equal(del.ok, true);
  assert.equal(del.removedTasks, 1);
  assert.equal(getTask(db, t.id), null); // task removed with the session
  assert.equal((await app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: auth() })).statusCode, 404);
});

// --- P2/P3: session continuity + compress --------------------------------

test('assembleContext: system text (concise+summary) + alternating prior messages', () => {
  const { systemText, priorMessages } = assembleContext({
    concise: true, summary: '老王喜欢喝茶', history: [{ prompt: 'Q1', output: 'A1' }, { prompt: 'Q2', output: 'A2' }],
  });
  assert.match(systemText, /只输出最终答案/); // concise instruction
  assert.match(systemText, /老王喜欢喝茶/);   // summary
  assert.deepEqual(priorMessages, [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
  ]);
  const bare = assembleContext({});
  assert.equal(bare.systemText, null);
  assert.deepEqual(bare.priorMessages, []);
});

test('claudeSessionArgs: first turn creates, later turns resume', () => {
  assert.deepEqual(claudeSessionArgs(null, null), []);
  assert.deepEqual(claudeSessionArgs('sid', { turns: [] }), ['--session-id', 'sid']);
  assert.deepEqual(claudeSessionArgs('sid', { turns: [{ prompt: 'a', output: 'b' }] }), ['--resume', 'sid']);
});

test('claudeSessionArgs: name appends -n (engine title sync)', () => {
  assert.deepEqual(claudeSessionArgs('sid', { turns: [] }, '库存分析'), ['--session-id', 'sid', '-n', '库存分析']);
  assert.deepEqual(claudeSessionArgs('sid', { turns: [{ prompt: 'a', output: 'b' }] }, '库存分析'), ['--resume', 'sid', '-n', '库存分析']);
  assert.deepEqual(claudeSessionArgs('sid', { turns: [] }, ''), ['--session-id', 'sid']); // no name -> no -n
  assert.deepEqual(claudeSessionArgs(null, null, 'x'), []); // no session -> nothing
});

test('parseCodexSessionId extracts the uuid from the codex header', () => {
  const header = 'OpenAI Codex v0.161.0\n--------\nworkdir: /x\nsession id: 01a119b6-9f76-70f2-8e1a-24c07337d376\n--------\n';
  assert.equal(parseCodexSessionId(header), '01a119b6-9f76-70f2-8e1a-24c07337d376');
  assert.equal(parseCodexSessionId('no id here'), null);
  assert.equal(parseCodexSessionId(''), null);
  assert.equal(parseCodexSessionId(null), null);
});

test('codex build: first turn vs resume (both stream and non-stream)', () => {
  const first = ENGINES.codex.build({}, {});
  assert.deepEqual(first, ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-']);
  const resume = ENGINES.codex.build({}, { resumeId: 'tid-123' });
  assert.deepEqual(resume, ['exec', 'resume', 'tid-123', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-']);
  const resumeStream = ENGINES.codex.stream.build({}, { resumeId: 'tid-123' });
  assert.deepEqual(resumeStream, ['exec', 'resume', 'tid-123', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-']);
});

test('setSessionEngineId records once and does not clobber', () => {
  const db = openDb(':memory:');
  createSession(db, { id: 's1', name: 'n', engine: 'codex', now: 1 });
  setSessionEngineId(db, 's1', 'thread-A', 2);
  assert.equal(getSession(db, 's1').engine_session_id, 'thread-A');
  setSessionEngineId(db, 's1', 'thread-B', 3); // first-capture only
  assert.equal(getSession(db, 's1').engine_session_id, 'thread-A');
});

test('PATCH rename reports engineSync (claude=next-task, new codex=first-task)', async () => {
  const { app } = makeApp();
  const cl = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'c', engine: 'claude' } })).json();
  const rc = (await app.inject({ method: 'PATCH', url: `/api/sessions/${cl.id}`, headers: auth(), payload: { name: '新名' } })).json();
  assert.equal(rc.name, '新名');
  assert.equal(rc.engineSync.when, 'next-task');

  const cx = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'x', engine: 'codex' } })).json();
  const rx = (await app.inject({ method: 'PATCH', url: `/api/sessions/${cx.id}`, headers: auth(), payload: { name: '新X' } })).json();
  assert.equal(rx.engineSync.when, 'first-task'); // no engine_session_id captured yet
});

test('cliTranscript formats summary + prior turns, empty when none', () => {
  assert.equal(cliTranscript(null), '');
  assert.equal(cliTranscript({ turns: [] }), '');
  const t = cliTranscript({ summary: 'S', turns: [{ prompt: 'Q', output: 'A' }] });
  assert.match(t, /此前对话摘要/);
  assert.match(t, /【我】Q/);
  assert.match(t, /【你】A/);
});

test('sessionHistory returns only done turns; setSessionSummary stores summary+offset', () => {
  const db = openDb(':memory:');
  createSession(db, { id: 's1', name: 'n', engine: 'openai', now: 1 });
  insertTask(db, { id: 't1', prompt: 'Q1', engine: 'openai', cwd: null, session_id: 's1', created_at: 2 });
  markFinished(db, 't1', { status: 'done', output: 'A1', error: null, exitCode: 0, finishedAt: 3 });
  insertTask(db, { id: 't2', prompt: 'Q2', engine: 'openai', cwd: null, session_id: 's1', created_at: 4 }); // queued
  const hist = sessionHistory(db, 's1');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].prompt, 'Q1');
  assert.equal(hist[0].output, 'A1');
  const s = setSessionSummary(db, 's1', 'SUM', 1, 99);
  assert.equal(s.summary, 'SUM');
  assert.equal(s.turns_before_summary, 1);
});

test('compress: 404 unknown / 400 for CLI engine / 400 without key', async () => {
  const { app } = makeApp(); // no getApiKey → API engine has no key
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/nope/compress', headers: auth() })).statusCode, 404);
  const cli = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'c', engine: 'claude' } })).json();
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${cli.id}/compress`, headers: auth() })).statusCode, 400);
  const api = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'a', engine: 'openai' } })).json();
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${api.id}/compress`, headers: auth() })).statusCode, 400);
});

// --- MCP ------------------------------------------------------------------

test('buildClaudeMcpConfig builds http servers with custom headers', () => {
  const cfg = buildClaudeMcpConfig([{ name: 'sellerspace', url: 'https://x/mcp/', header_name: 'x-api-key', header_value: 'k' }]);
  assert.deepEqual(cfg, { mcpServers: { sellerspace: { type: 'http', url: 'https://x/mcp/', headers: { 'x-api-key': 'k' } } } });
  assert.deepEqual(buildClaudeMcpConfig([]), { mcpServers: {} });
});

test('MCP servers CRUD + header masking (raw value never returned)', async () => {
  const { app } = makeApp();
  assert.equal((await app.inject({ method: 'POST', url: '/api/mcp', headers: auth(), payload: { name: 'ss', url: 'https://www.sellerspace.com/mcp/', header_name: 'x-api-key', header_value: 'demo_aurelia_2026' } })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/api/mcp', headers: auth(), payload: { name: 'x', url: 'ftp://bad', header_name: 'h', header_value: 'v' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/mcp', headers: auth(), payload: { name: 'x' } })).statusCode, 400);
  const list = (await app.inject({ method: 'GET', url: '/api/mcp', headers: auth() })).json().servers;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ss');
  assert.equal(list[0].header_name, 'x-api-key');
  assert.ok(!('header_value' in list[0]), 'raw header value must NOT be returned');
  assert.ok(list[0].header_masked.includes('…'));
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/mcp/ss', headers: auth() })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/mcp/ss', headers: auth() })).statusCode, 404);
});

test('buildCodexMcpToml emits http_headers with custom header', () => {
  const toml = buildCodexMcpToml([{ name: 'sellerspace', url: 'https://x/mcp/', header_name: 'x-api-key', header_value: 'k' }]);
  assert.ok(toml.includes(MARK_START) && toml.includes(MARK_END));
  assert.ok(toml.includes('[mcp_servers."sellerspace"]'));
  assert.ok(toml.includes('url = "https://x/mcp/"'));
  assert.ok(toml.includes('http_headers = { "x-api-key" = "k" }'));
  assert.equal(buildCodexMcpToml([]), '');
});

test('syncCodexConfig merges/replaces/removes managed block, preserving other content', () => {
  const p = path.join(os.tmpdir(), `onlymind-codex-${Date.now()}-${Math.floor(Math.random() * 1e6)}.toml`);
  fs.writeFileSync(p, '[model]\nname = "gpt"\n');
  syncCodexConfig(p, [{ name: 'ss', url: 'https://a/mcp/', header_name: 'x-api-key', header_value: 'k1' }]);
  let c = fs.readFileSync(p, 'utf8');
  assert.ok(c.includes('name = "gpt"'), 'preserves existing content');
  assert.ok(c.includes('[mcp_servers."ss"]') && c.includes('k1'));
  // re-sync with different server → old block replaced, no duplicate markers
  syncCodexConfig(p, [{ name: 'sp', url: 'https://b/mcp', header_name: 'secret-key', header_value: 'k2' }]);
  c = fs.readFileSync(p, 'utf8');
  assert.ok(c.includes('name = "gpt"'));
  assert.ok(c.includes('[mcp_servers."sp"]') && c.includes('k2'));
  assert.ok(!c.includes('[mcp_servers."ss"]'), 'old block removed');
  assert.equal(c.match(new RegExp(MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length, 1, 'single managed block');
  // clear
  syncCodexConfig(p, []);
  c = fs.readFileSync(p, 'utf8');
  assert.ok(c.includes('name = "gpt"') && !c.includes('mcp_servers'), 'block removed, content kept');
  fs.rmSync(p, { force: true });
});

test('POST /api/mcp/codex-apply writes config.toml', async () => {
  const db = openDb(':memory:');
  const queue = fakeQueue();
  const p = path.join(os.tmpdir(), `onlymind-codex-ep-${Date.now()}-${Math.floor(Math.random() * 1e6)}.toml`);
  const app = buildServer({ db, queue, token: TOKEN, codexConfigPath: p });
  await app.inject({ method: 'POST', url: '/api/mcp', headers: auth(), payload: { name: 'ss', url: 'https://www.sellerspace.com/mcp/', header_name: 'x-api-key', header_value: 'demo_aurelia_2026' } });
  const r = await app.inject({ method: 'POST', url: '/api/mcp/codex-apply', headers: auth() });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().count, 1);
  const c = fs.readFileSync(p, 'utf8');
  assert.ok(c.includes('[mcp_servers."ss"]') && c.includes('demo_aurelia_2026'));
  fs.rmSync(p, { force: true });
});

test('task accepts mcp flag', async () => {
  const { app } = makeApp();
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', mcp: true } })).json();
  assert.equal(t.mcp, 1);
  const t2 = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'y' } })).json();
  assert.equal(t2.mcp, 0);
});

// --- OnlyMind MCP server (sessions → local AI) ----------------------------

function seedSession(db) {
  createSession(db, { id: 'S', name: '选品分析', engine: 'claude', now: 1 });
  insertTask(db, { id: 'a', prompt: '分析 ASIN B01 的类目', engine: 'claude', cwd: null, session_id: 'S', created_at: 2 });
  markFinished(db, 'a', { status: 'done', output: '该类目竞争中等,机会在长尾关键词。', error: null, exitCode: 0, finishedAt: 3 });
  insertTask(db, { id: 'b', prompt: '列出长尾词', engine: 'claude', cwd: null, session_id: 'S', created_at: 4 });
  markFinished(db, 'b', { status: 'failed', output: null, error: '超时', exitCode: 1, finishedAt: 5 });
  return db;
}

test('sessionTasksFull returns all rows (incl output/error), oldest first', () => {
  const db = seedSession(openDb(':memory:'));
  const rows = sessionTasksFull(db, 'S');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a');
  assert.equal(rows[0].output, '该类目竞争中等,机会在长尾关键词。');
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[1].error, '超时');
});

test('searchTasks matches prompt or output, newest first, honors limit', () => {
  const db = seedSession(openDb(':memory:'));
  assert.equal(searchTasks(db, '长尾', 10).length, 2); // prompt of b + output of a
  assert.equal(searchTasks(db, 'ASIN', 10).length, 1);
  assert.equal(searchTasks(db, '长尾', 1).length, 1);
  assert.equal(searchTasks(db, '不存在xyz', 10).length, 0);
});

test('buildTranscript includes full output + marks failures, not truncated', () => {
  const db = seedSession(openDb(':memory:'));
  const t = buildTranscript(getSession(db, 'S'), sessionTasksFull(db, 'S'));
  assert.ok(t.includes('# 会话:选品分析'));
  assert.ok(t.includes('该类目竞争中等,机会在长尾关键词。')); // full output present
  assert.ok(t.includes('【错误】') && t.includes('超时'));
});

test('buildResumeHint: claude (cwd-scoped) / codex (any cwd) / api & uncaptured => null', () => {
  // claude: resume id = session id, cwd-scoped, only when it has turns
  const h = buildResumeHint({ engine: 'claude', id: 'S' }, '/work/dir', 2);
  assert.equal(h.command, 'claude --resume S');
  assert.match(h.note, /\/work\/dir/);
  assert.equal(buildResumeHint({ engine: 'claude', id: 'S' }, '/x', 0), null); // no turns yet
  // codex: resume by captured thread id, any cwd
  const c = buildResumeHint({ engine: 'codex', id: 'S', engine_session_id: 'tid-9' }, '/x', 3);
  assert.equal(c.command, 'codex exec resume tid-9');
  assert.match(c.note, /任意目录/);
  assert.equal(buildResumeHint({ engine: 'codex', id: 'S', engine_session_id: null }, '/x', 3), null);
  // api engines: no engine-side session
  assert.equal(buildResumeHint({ engine: 'openai', id: 'S' }, '/x', 3), null);
});

test('formatResumeHint + buildTranscript inject the native-resume command', () => {
  assert.equal(formatResumeHint(null), '');
  const hint = buildResumeHint({ engine: 'codex', id: 'S', engine_session_id: 'tid-9' }, null, 1);
  assert.match(formatResumeHint(hint), /codex exec resume tid-9/);
  const t = buildTranscript({ name: 'n', engine: 'codex', id: 'S', summary: null }, [], false, hint);
  assert.match(t, /续接方式/);
  assert.match(t, /codex exec resume tid-9/);
});

test('runTool: list/transcript/search + errors', () => {
  const db = seedSession(openDb(':memory:'));
  const list = runTool(db, 'list_sessions', {});
  assert.ok(list.includes('选品分析') && list.includes('id: S'));
  assert.ok(list.includes('可原生续接')); // claude session with turns
  const tr = runTool(db, 'get_session_transcript', { session_id: 'S' });
  assert.ok(tr.includes('【问】') && tr.includes('该类目竞争中等') && tr.includes('【错误】'));
  assert.ok(tr.includes('claude --resume S')); // native-resume hint present
  const sr = runTool(db, 'search_tasks', { query: 'ASIN' });
  assert.ok(sr.includes('任务 a'));
  assert.throws(() => runTool(db, 'get_session_transcript', { session_id: 'nope' }), /未找到/);
  assert.throws(() => runTool(db, 'unknown', {}), /未知工具/);
});

test('formatters handle empty input', () => {
  assert.equal(formatSessionList([]), '(当前没有会话)');
  assert.equal(formatSearch([]), '(没有匹配的任务)');
});

test('sync: needing → transcript auto-advances → new turn re-pends → ignore excludes', () => {
  const db = seedSession(openDb(':memory:'));
  assert.equal(sessionsNeedingSync(db).length, 1);
  assert.equal(sessionsNeedingSync(db)[0].pending, 2);
  runTool(db, 'get_session_transcript', { session_id: 'S' }); // reading marks synced
  assert.equal(sessionsNeedingSync(db).length, 0);
  insertTask(db, { id: 'c', prompt: '新一轮', engine: 'claude', cwd: null, session_id: 'S', created_at: 100 });
  markFinished(db, 'c', { status: 'done', output: 'ok', error: null, exitCode: 0, finishedAt: 101 });
  assert.equal(sessionsNeedingSync(db).length, 1); // new turn → needs sync again
  setSyncIgnored(db, 'S', true);
  assert.equal(sessionsNeedingSync(db).length, 0); // ignored → excluded
});

test('runTool: check_sync / only_new / set_sync_ignore / mark_synced', () => {
  const db = seedSession(openDb(':memory:'));
  assert.match(runTool(db, 'check_sync', {}), /需要同步/);
  assert.ok(runTool(db, 'list_sessions', { only_new: true }).includes('选品'));
  runTool(db, 'set_sync_ignore', { session_id: 'S' });
  assert.match(runTool(db, 'check_sync', {}), /没有需要同步/);
  assert.equal(runTool(db, 'list_sessions', {}), '(当前没有会话)'); // ignored hidden by default
  assert.ok(runTool(db, 'list_sessions', { include_ignored: true }).includes('已忽略'));
  runTool(db, 'set_sync_ignore', { session_id: 'S', ignored: false });
  runTool(db, 'mark_synced', { session_id: 'S' });
  assert.match(runTool(db, 'check_sync', {}), /没有需要同步/);
});

test('getPrompt sync returns a usable prompt; unknown throws', () => {
  assert.ok(getPrompt('sync').messages[0].content.text.includes('check_sync'));
  assert.throws(() => getPrompt('nope'), /未知 prompt/);
});

test('HTTP POST /api/sessions/:id/sync-ignore sets flag / 404', async () => {
  const { app } = makeApp();
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 'x', engine: 'claude' } })).json();
  const r = await app.inject({ method: 'POST', url: `/api/sessions/${s.id}/sync-ignore`, headers: auth(), payload: { ignored: true } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().sync_ignored, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/nope/sync-ignore', headers: auth(), payload: { ignored: true } })).statusCode, 404);
});

test('GET /api/version returns current and no update when repoSlug unset', async () => {
  const { app } = makeApp(); // no repoSlug -> no GitHub call
  const res = await app.inject({ method: 'GET', url: '/api/version', headers: auth() });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.current, '0.0.0');
  assert.equal(b.latest, null);
  assert.equal(b.updateAvailable, false);
});

test('concise defaults ON and can be disabled', async () => {
  const { app } = makeApp();
  const def = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x' } });
  assert.equal(def.json().concise, 1); // default ON
  const off = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', concise: false } });
  assert.equal(off.json().concise, 0);
});

test('all CLI args stay pure ASCII (Windows shell:true safety)', () => {
  const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
  for (const eng of [ENGINES.claude, ENGINES.codex]) {
    for (const a of eng.build({ prompt: 'x', concise: 1 })) assert.ok(isAscii(a), `arg not ascii: ${a}`);
    if (eng.stream) for (const a of eng.stream.build({ prompt: 'x', concise: 1 })) assert.ok(isAscii(a), `stream arg not ascii: ${a}`);
  }
});

test('concise is injected via stdin for both engines', () => {
  for (const eng of [ENGINES.claude, ENGINES.codex]) {
    const concise = eng.stdinText({ prompt: 'do it', concise: 1 });
    assert.ok(concise.includes('do it'));
    assert.ok(concise.length > 'do it'.length, 'instruction should be prepended');
    assert.equal(eng.stdinText({ prompt: 'do it', concise: 0 }), 'do it');
  }
});

test('rerun preserves concise', async () => {
  const db = openDb(':memory:');
  const queue = createQueue({ db, run: async () => ({ status: 'done', output: 'ok' }), now: (() => { let c = 0; return () => ++c; })() });
  const app = buildServer({ db, queue, token: TOKEN });
  const created = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', concise: false } })).json();
  await queue.drain();
  const rerun = (await app.inject({ method: 'POST', url: `/api/tasks/${created.id}/rerun`, headers: auth() })).json();
  assert.equal(rerun.concise, 0);
});

test('session binds its directory on first task and never crosses dirs', async () => {
  const { app, db } = makeApp();
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 's', engine: 'claude' } })).json();
  // First task binds the session's dir.
  const t1 = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'a', engine: 'claude', session_id: s.id, cwd: '/dir/a' } });
  assert.equal(t1.statusCode, 201);
  assert.equal(t1.json().cwd, '/dir/a');
  assert.equal(getSession(db, s.id).cwd, '/dir/a');
  // A different dir is rejected.
  const bad = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'b', engine: 'claude', session_id: s.id, cwd: '/dir/b' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /不允许会话跨目录/);
  // Blank inherits the bound dir; same dir is fine.
  const t2 = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'c', engine: 'claude', session_id: s.id } })).json();
  assert.equal(t2.cwd, '/dir/a');
  const t3 = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'd', engine: 'claude', session_id: s.id, cwd: '/dir/a' } })).json();
  assert.equal(t3.cwd, '/dir/a');
});

test('first task binds to defaultCwd when none given', async () => {
  const db = openDb(':memory:');
  const queue = fakeQueue();
  const app = buildServer({ db, queue, token: TOKEN, defaultCwd: '/srv/home' });
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 's', engine: 'codex' } })).json();
  const t1 = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'a', engine: 'codex', session_id: s.id } })).json();
  assert.equal(t1.cwd, '/srv/home');
  assert.equal(getSession(db, s.id).cwd, '/srv/home');
});

test('rerun stays in the same session (preserves session_id + mcp)', async () => {
  const { app, db } = makeApp();
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload: { name: 's', engine: 'claude' } })).json();
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(), payload: { prompt: 'x', engine: 'claude', session_id: s.id, mcp: true } })).json();
  const rerun = (await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/rerun`, headers: auth() })).json();
  assert.equal(rerun.session_id, s.id); // did not leave its session
  assert.equal(rerun.mcp, 1);
  assert.equal(getTask(db, rerun.id).cwd, getTask(db, t.id).cwd); // same dir
});

test('streaming task appends incremental output via onData', async () => {
  const db = openDb(':memory:');
  let clock = 0;
  const run = async (task, { onData }) => {
    onData('hello ');
    onData('world');
    return { status: 'done', output: 'hello world', error: null, exitCode: 0 };
  };
  const queue = createQueue({ db, run, now: () => ++clock });
  insertTask(db, { id: 's1', prompt: 'x', engine: 'claude', cwd: null, stream: true, created_at: 1 });
  queue.enqueue('s1');
  await queue.drain();
  const t = getTask(db, 's1');
  assert.equal(t.status, 'done');
  assert.equal(t.output, 'hello world');
});
