import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

let version = '0.0.0';
let repoSlug = null; // "owner/repo", used to check GitHub for newer releases
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  version = pkg.version || version;
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const m = String(url).match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
  if (m) repoSlug = `${m[1]}/${m[2]}`;
} catch { /* ignore */ }

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// A token is required to call the API. If none is provided via env we generate
// one at startup and print it so the user can paste it into the web page.
let token = process.env.ONLYMIND_TOKEN;
let tokenGenerated = false;
if (!token) {
  token = randomUUID();
  tokenGenerated = true;
}

export const config = {
  version,
  repoSlug,
  projectRoot,
  host: process.env.ONLYMIND_HOST || '0.0.0.0',
  port: envInt('ONLYMIND_PORT', 8787),
  token,
  tokenGenerated,
  dbPath: process.env.ONLYMIND_DB || path.join(projectRoot, 'data', 'onlymind.db'),
  // Working directory used when a task does not specify one.
  defaultCwd: process.env.ONLYMIND_DEFAULT_CWD || os.homedir(),
  // Hard timeout for a single task execution.
  taskTimeoutMs: envInt('ONLYMIND_TASK_TIMEOUT_MS', 10 * 60 * 1000),
  publicDir: path.join(projectRoot, 'public'),
  // API-engine models (overridable; set to whatever your account supports).
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  anthropicMaxTokens: envInt('ANTHROPIC_MAX_TOKENS', 4096),
};
