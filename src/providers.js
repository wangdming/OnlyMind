// OpenAI / Anthropic REST API callers. Used by the "openai" and "anthropic"
// engines (kind: 'api'). Pure HTTP via fetch — cross-platform, no CLI/app.

import { CONCISE_INSTRUCTION } from './engines.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/** Validate an API key by hitting the provider's models endpoint. */
export async function validateKey(provider, key) {
  if (!key) return { ok: false, error: 'API Key 为空' };
  try {
    let res;
    if (provider === 'openai') {
      res = await fetch(`${OPENAI_BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12000),
      });
    } else if (provider === 'anthropic') {
      res = await fetch(`${ANTHROPIC_BASE}/models`, {
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, signal: AbortSignal.timeout(12000),
      });
    } else {
      return { ok: false, error: `未知提供方: ${provider}` };
    }
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'API Key 无效或无权限' };
    return { ok: false, error: `验证失败 (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: '无法连接提供方:' + (e.name === 'TimeoutError' ? '超时' : e.message) };
  }
}

// Read an SSE stream from a fetch Response, calling onLine for each `data:` payload.
async function readSSE(res, onData, pickDelta, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let acc = '';
  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* */ } break; }
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const delta = pickDelta(JSON.parse(data));
        if (delta) { acc += delta; if (onData) onData(delta); }
      } catch { /* ignore keepalive/partial */ }
    }
  }
  return acc;
}

/**
 * Run a completion. Never throws — returns the queue's result shape.
 * @returns {Promise<{status:'done'|'failed'|'canceled', output, error, exitCode:null}>}
 */
export async function complete(provider, { prompt, key, concise, stream, model, maxTokens, onData, signal }) {
  if (!key) return { status: 'failed', output: null, error: `未设置 ${provider} API Key`, exitCode: null };
  const sys = concise ? CONCISE_INSTRUCTION : null;
  try {
    if (provider === 'openai') {
      const messages = [];
      if (sys) messages.push({ role: 'system', content: sys });
      messages.push({ role: 'user', content: prompt });
      const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: !!stream }),
        signal,
      });
      if (!res.ok) return { status: 'failed', output: null, error: await errText(res), exitCode: null };
      if (stream) {
        const text = await readSSE(res, onData, (o) => o.choices?.[0]?.delta?.content || '', signal);
        return { status: signal?.aborted ? 'canceled' : 'done', output: text || null, error: null, exitCode: null };
      }
      const j = await res.json();
      return { status: 'done', output: j.choices?.[0]?.message?.content ?? null, error: null, exitCode: null };
    }

    if (provider === 'anthropic') {
      const body = {
        model, max_tokens: maxTokens || 4096,
        messages: [{ role: 'user', content: prompt }],
        stream: !!stream,
      };
      if (sys) body.system = sys;
      const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) return { status: 'failed', output: null, error: await errText(res), exitCode: null };
      if (stream) {
        const text = await readSSE(res, onData, (o) => (o.type === 'content_block_delta' ? (o.delta?.text || '') : ''), signal);
        return { status: signal?.aborted ? 'canceled' : 'done', output: text || null, error: null, exitCode: null };
      }
      const j = await res.json();
      const text = Array.isArray(j.content) ? j.content.filter((p) => p.type === 'text').map((p) => p.text).join('') : null;
      return { status: 'done', output: text || null, error: null, exitCode: null };
    }

    return { status: 'failed', output: null, error: `未知提供方: ${provider}`, exitCode: null };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'canceled', output: null, error: 'Canceled by user', exitCode: null };
    return { status: 'failed', output: null, error: 'API 调用失败:' + e.message, exitCode: null };
  }
}

async function errText(res) {
  let detail = '';
  try { const j = await res.json(); detail = j.error?.message || JSON.stringify(j).slice(0, 200); }
  catch { detail = await res.text().catch(() => ''); }
  return `提供方返回 HTTP ${res.status}${detail ? ': ' + detail : ''}`;
}
