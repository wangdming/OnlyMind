import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertTask, listTasks, getTask } from '../src/db.js';
import { createQueue } from '../src/queue.js';
import { buildServer } from '../src/server.js';
import { ENGINES } from '../src/engines.js';

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
  assert.ok(done.every((t) => t.output.startsWith('out:')));
});

test('queue records failures from the runner', async () => {
  const db = openDb(':memory:');
  let clock = 0;
  const run = async () => ({ status: 'failed', output: null, error: 'boom', exitCode: 1 });
  const queue = createQueue({ db, run, now: () => ++clock });
  const t = insertTask(db, { id: 'f1', prompt: 'x', engine: 'claude', cwd: null, created_at: 1 });
  queue.enqueue(t.id);
  await queue.drain();
  const got = listTasks(db, { limit: 1 }).items[0];
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
  const got = listTasks(db, { limit: 1 }).items[0];
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
