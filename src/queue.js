import {
  getQueuedIds, getTask, markRunning, markFinished, failOrphans, appendOutput,
} from './db.js';
import { emitChunk, emitStatus } from './events.js';

/**
 * A strictly serial task queue (concurrency = 1). Tasks are persisted in SQLite;
 * this object tracks the in-memory processing loop plus the currently running
 * child so it can be canceled. On construction it fails orphaned 'running' tasks
 * and picks up tasks still 'queued'.
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {(task:object, opts:{signal:AbortSignal, onData:(t:string)=>void})=>Promise<object>} deps.run
 * @param {()=>number} [deps.now]
 */
export function createQueue({ db, run, now = () => Date.now(), onFinished = () => {} }) {
  let processing = false;
  const pending = [];
  let currentId = null;
  let currentController = null;

  // Recover state from a previous process.
  failOrphans(db, now());
  for (const id of getQueuedIds(db)) pending.push(id);

  function enqueue(id) {
    pending.push(id);
    tick();
  }

  async function tick() {
    if (processing) return;
    processing = true;
    try {
      while (pending.length > 0) {
        const id = pending.shift();
        const task = getTask(db, id);
        if (!task || task.status !== 'queued') continue;

        markRunning(db, id, now());
        emitStatus(id, getTask(db, id));

        currentId = id;
        currentController = new AbortController();
        let result;
        try {
          result = await run(getTask(db, id), {
            signal: currentController.signal,
            onData: (text) => {
              appendOutput(db, id, text);
              emitChunk(id, text);
            },
          });
        } finally {
          currentId = null;
          currentController = null;
        }

        const finished = markFinished(db, id, {
          status: result.status,
          output: result.output,
          error: result.error,
          exitCode: result.exitCode,
          finishedAt: now(),
        });
        emitStatus(id, finished);
        // Let the host persist engine-side session info (e.g. codex thread id)
        // and sync the session name. Best-effort — never breaks the queue.
        try { await onFinished(finished, result); } catch { /* ignore */ }
      }
    } finally {
      processing = false;
    }
  }

  /**
   * Cancel a task. Returns the updated task, or null if not cancelable
   * (already finished / unknown).
   */
  function cancel(id) {
    const task = getTask(db, id);
    if (!task) return null;

    if (task.status === 'running' && currentId === id && currentController) {
      currentController.abort(); // runner kills the child, loop persists 'canceled'
      return getTask(db, id);
    }
    if (task.status === 'queued') {
      const i = pending.indexOf(id);
      if (i !== -1) pending.splice(i, 1);
      const finished = markFinished(db, id, {
        status: 'canceled', output: null, error: 'Canceled while queued', exitCode: null, finishedAt: now(),
      });
      emitStatus(id, finished);
      return finished;
    }
    return null; // done / failed / already canceled
  }

  return {
    enqueue,
    cancel,
    async drain() {
      await tick();
      while (processing || pending.length > 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    get size() {
      return pending.length;
    },
  };
}
