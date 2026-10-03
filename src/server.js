import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { insertTask, getTask, listTasks } from './db.js';
import { isValidEngine, engineList } from './engines.js';
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
export function buildServer({ db, queue, token, publicDir, version = '0.0.0', now = () => Date.now() }) {
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

  app.get('/api/version', async () => ({ version }));

  app.get('/api/engines', async () => ({ engines: engineList() }));

  app.post('/api/tasks', async (req, reply) => {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const engine = body.engine || 'claude';
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
    const stream = body.stream === true || body.stream === 1 || body.stream === '1';
    // Concise defaults to ON unless explicitly disabled.
    const concise = body.concise !== false && body.concise !== 0 && body.concise !== '0';

    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
    if (!isValidEngine(engine)) return reply.code(400).send({ error: `unknown engine: ${engine}` });

    const task = insertTask(db, { id: randomUUID(), prompt, engine, cwd, stream, concise, created_at: now() });
    queue.enqueue(task.id);
    return reply.code(201).send(task);
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
