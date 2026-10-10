import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENGINES } from './engines.js';
import { complete } from './providers.js';

// Build a Claude Code --mcp-config JSON from stored MCP servers (pure, testable).
export function buildClaudeMcpConfig(servers) {
  const mcpServers = {};
  for (const s of servers || []) {
    mcpServers[s.name] = { type: 'http', url: s.url, headers: { [s.header_name]: s.header_value } };
  }
  return { mcpServers };
}

// Extra claude CLI args for session continuity (pure, testable).
// First turn of a session creates the id; later turns resume it. When a name is
// given, `-n <name>` sets the session's display title in the engine (shown in
// `claude -r`), so renaming in OnlyMind propagates to Claude on the next turn.
export function claudeSessionArgs(sessionId, ctx, name) {
  if (!sessionId) return [];
  const hasPrior = !!ctx && Array.isArray(ctx.turns) && ctx.turns.length > 0;
  const args = hasPrior ? ['--resume', sessionId] : ['--session-id', sessionId];
  if (name) args.push('-n', name);
  return args;
}

// Capture codex's engine session id from its `exec` output header line
// ("session id: <uuid>"). Pure, testable. Returns null if absent.
export function parseCodexSessionId(stdout) {
  const m = /session id:\s*([0-9a-fA-F-]{36})/.exec(stdout || '');
  return m ? m[1] : null;
}

// Transcript prepended to the prompt for non-claude CLI engines (fallback
// continuity). Pure, testable.
export function cliTranscript(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (ctx.summary) parts.push('【此前对话摘要】\n' + ctx.summary);
  for (const t of ctx.turns || []) {
    parts.push(`【我】${t.prompt}\n【你】${t.output ?? ''}`);
  }
  return parts.length ? '以下是我们此前的对话,请在此基础上继续:\n\n' + parts.join('\n\n') + '\n\n---\n\n' : '';
}

// Kill the child. On Windows with shell:true there is an intermediate cmd.exe,
// so kill the whole process tree with taskkill; elsewhere SIGKILL suffices.
function killChild(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Default task runner: spawns the engine CLI, captures stdout/stderr, enforces
 * a timeout, supports cancellation via AbortSignal, and (for stream tasks)
 * reports incremental output via onData. Never rejects — failures are reported
 * through the resolved object so the queue can persist them.
 *
 * @param {object} cfg
 * @param {string} cfg.defaultCwd
 * @param {number} cfg.taskTimeoutMs
 * @returns {(task:object, opts?:{signal?:AbortSignal, onData?:(text:string)=>void}) =>
 *   Promise<{status:'done'|'failed'|'canceled', output:string|null, error:string|null, exitCode:number|null}>}
 */
export function spawnRunner({ defaultCwd, taskTimeoutMs, getApiKey = () => null, models = {}, getSessionContext = () => ({ summary: null, turns: [] }), getMcpServers = () => [] }) {
  return function run(task, { signal, onData } = {}) {
    const engine = ENGINES[task.engine];
    if (!engine) {
      return Promise.resolve({ status: 'failed', output: null, error: `Unknown engine: ${task.engine}`, exitCode: null });
    }
    if (signal?.aborted) {
      return Promise.resolve({ status: 'canceled', output: null, error: 'Canceled before start', exitCode: null });
    }

    // Session continuity context (summary + prior turns), if this task is in a session.
    const ctx = task.session_id ? getSessionContext(task.session_id) : null;

    // API engines call the provider over HTTP instead of spawning a CLI.
    if (engine.kind === 'api') {
      const key = getApiKey(engine.provider);
      if (!key) {
        return Promise.resolve({ status: 'failed', output: null, error: `未设置 ${engine.provider} API Key,请在手机「设置」中填写并验证`, exitCode: null });
      }
      const model = task.model || (engine.provider === 'openai' ? models.openai : models.anthropic);
      return complete(engine.provider, {
        prompt: task.prompt, key, concise: !!task.concise, stream: !!task.stream,
        model, maxTokens: models.anthropicMaxTokens, onData, signal,
        summary: ctx?.summary || null, history: ctx?.turns || [],
      });
    }

    return new Promise((resolve) => {
      const streaming = !!task.stream && !!engine.stream;
      // Codex native sessions: resume by stored engine id after the first turn.
      const codexResumeId = (engine.bin === 'codex' && task.session_id) ? (ctx?.engineSessionId || null) : null;
      let args = streaming ? engine.stream.build(task, { resumeId: codexResumeId }) : engine.build(task, { resumeId: codexResumeId });
      // Session continuity for CLI engines.
      if (task.session_id && engine.bin === 'claude') {
        // Pass the session name as the engine title. Keep it off argv on
        // Windows (shell:true) when non-ASCII, to avoid code-page mangling.
        const name = ctx?.name || null;
        const safeName = name && (process.platform !== 'win32' || /^[\x00-\x7F]*$/.test(name)) ? name : null;
        args = args.concat(claudeSessionArgs(task.session_id, ctx, safeName));
      }
      // MCP injection (claude only; codex configured in its own config).
      let mcpConfigFile = null;
      if (task.mcp && engine.bin === 'claude') {
        const servers = getMcpServers() || [];
        if (servers.length) {
          try {
            mcpConfigFile = path.join(os.tmpdir(), `onlymind-mcp-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
            fs.writeFileSync(mcpConfigFile, JSON.stringify(buildClaudeMcpConfig(servers)));
            args = args.concat(['--mcp-config', mcpConfigFile, '--strict-mcp-config']);
          } catch { mcpConfigFile = null; }
        }
      }
      const cwd = task.cwd || defaultCwd;
      // On Windows, npm-installed CLIs are `.cmd` shims that Node (>=18.20) can
      // only launch with shell:true. The prompt goes via stdin (below), so only
      // fixed, trusted flags ever reach the shell — no injection surface.
      const useShell = process.platform === 'win32';

      let child;
      try {
        child = spawn(engine.bin, args, {
          cwd,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: useShell,
          windowsHide: true,
        });
      } catch (err) {
        if (mcpConfigFile) { try { fs.unlinkSync(mcpConfigFile); } catch { /* ignore */ } }
        resolve({ status: 'failed', output: null, error: `Failed to spawn ${engine.bin}: ${err.message}`, exitCode: null });
        return;
      }

      // Deliver the prompt via stdin (cross-platform safe).
      if ((engine.promptVia || 'stdin') === 'stdin' && child.stdin) {
        let stdinText = engine.stdinText ? engine.stdinText(task) : task.prompt;
        // claude and codex both keep their own context natively (claude via
        // --session-id/--resume, codex via `exec resume`). Only prepend a
        // transcript for codex's FIRST turn (no resume id yet) so a session
        // that predates native resume carries its prior turns into the new
        // codex thread; subsequent turns rely on codex's own context.
        if (task.session_id && engine.bin === 'codex' && !codexResumeId) stdinText = cliTranscript(ctx) + stdinText;
        child.stdin.on('error', () => { /* ignore EPIPE if child exits early */ });
        child.stdin.write(stdinText);
        child.stdin.end();
      }

      let rawStdout = '';   // everything from stdout (for buffered parse)
      let stderr = '';
      let streamedText = ''; // accumulated deltas (streaming display)
      let finalText = null;  // authoritative final (streaming, e.g. claude result)
      let lineBuf = '';
      let timedOut = false;
      let canceled = false;

      const onAbort = () => { canceled = true; killChild(child); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => { timedOut = true; killChild(child); }, taskTimeoutMs);

      function handleStreamLine(raw) {
        const { delta, final } = engine.stream.line(raw);
        if (typeof final === 'string') finalText = final;
        if (delta) {
          streamedText += delta;
          if (onData) onData(delta);
        }
      }

      child.stdout.on('data', (d) => {
        const s = d.toString();
        rawStdout += s;
        if (streaming) {
          lineBuf += s;
          let nl;
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl);
            lineBuf = lineBuf.slice(nl + 1);
            handleStreamLine(line);
          }
        }
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (mcpConfigFile) { try { fs.unlinkSync(mcpConfigFile); } catch { /* ignore */ } }
      }

      child.on('error', (err) => {
        cleanup();
        const hint = err.code === 'ENOENT'
          ? `Command '${engine.bin}' not found. Is ${engine.label} installed and on PATH?`
          : err.message;
        resolve({ status: 'failed', output: rawStdout || null, error: hint, exitCode: null });
      });

      child.on('close', (code) => {
        cleanup();
        // flush any trailing partial line
        if (streaming && lineBuf) handleStreamLine(lineBuf);

        const streamOutput = finalText ?? streamedText;
        // Codex prints its "session id: <uuid>" header to stderr (stdout is the
        // clean answer); capture it so the queue can record the engine session
        // id on the session's first turn.
        const engineSessionId = engine.bin === 'codex' ? parseCodexSessionId(stderr) : null;

        if (canceled) {
          resolve({ status: 'canceled', output: (streaming ? streamOutput : engine.parse(rawStdout)) || null, error: 'Canceled by user', exitCode: code, engineSessionId });
          return;
        }
        if (timedOut) {
          resolve({ status: 'failed', output: (streaming ? streamOutput : engine.parse(rawStdout)) || null, error: `Task timed out after ${taskTimeoutMs} ms`, exitCode: code, engineSessionId });
          return;
        }
        if (code === 0) {
          resolve({ status: 'done', output: (streaming ? streamOutput : engine.parse(rawStdout)) || null, error: stderr || null, exitCode: 0, engineSessionId });
        } else {
          resolve({ status: 'failed', output: (streaming ? streamOutput : engine.parse(rawStdout)) || null, error: stderr || `Exited with code ${code}`, exitCode: code, engineSessionId });
        }
      });
    });
  };
}
