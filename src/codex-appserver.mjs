import { spawn } from 'node:child_process';

// Minimal client for the Codex app-server JSON-RPC protocol (newline-delimited
// JSON over stdio). We use it only to set a thread's display name, which is the
// officially supported way to rename a codex session (the TUI uses the same
// `thread/name/set` method). Setting the name via the app-server avoids putting
// a (possibly non-ASCII) name on argv, and does not require running a turn.

/**
 * Set the display name of a codex thread. Best-effort: resolves to
 * { ok, reason? } and never throws, so callers can report a soft failure.
 *
 * @param {string} threadId  codex thread/session id (uuid)
 * @param {string} name      new display name
 * @param {object} [opts]
 * @param {string} [opts.bin='codex']   codex binary
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export function setCodexThreadName(threadId, name, opts = {}) {
  const bin = opts.bin || 'codex';
  const timeoutMs = opts.timeoutMs || 8000;
  if (!threadId || !name) return Promise.resolve({ ok: false, reason: 'missing threadId or name' });

  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; clearTimeout(timer); try { child.kill(); } catch { /* ignore */ } resolve(res); } };

    let child;
    try {
      child = spawn(bin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, reason: `spawn failed: ${err.message}` });
    }

    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);

    const pending = new Map(); // id -> handler
    let buf = '';
    const send = (id, method, params) => {
      pending.set(id, null);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    };

    child.stdin.on('error', () => { /* ignore EPIPE */ });
    child.on('error', (err) => done({ ok: false, reason: err.code === 'ENOENT' ? 'codex not found' : err.message }));

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { done({ ok: false, reason: `initialize: ${msg.error.message || 'error'}` }); return; }
          send(2, 'thread/name/set', { threadId, name });
        } else if (msg.id === 2) {
          if (msg.error) done({ ok: false, reason: msg.error.message || 'thread/name/set error' });
          else done({ ok: true });
        }
      }
    });

    send(1, 'initialize', { clientInfo: { name: 'onlymind', version: '1' } });
  });
}
