// Generate & merge OnlyMind-managed MCP server entries into Codex's config.toml.
// Codex reads custom headers for Streamable-HTTP MCP servers from `http_headers`
// (NOT `headers`). We write an isolated, marker-delimited block so the rest of
// the user's config is preserved and the block can be regenerated/removed.

import fs from 'node:fs';
import path from 'node:path';

export const MARK_START = '# === OnlyMind MCP (managed; do not edit inside) ===';
export const MARK_END = '# === /OnlyMind MCP ===';

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the managed TOML block for the given MCP servers (pure, testable). */
export function buildCodexMcpToml(servers) {
  if (!servers || !servers.length) return '';
  const blocks = servers.map((s) =>
    `[mcp_servers."${esc(s.name)}"]\n` +
    `url = "${esc(s.url)}"\n` +
    `http_headers = { "${esc(s.header_name)}" = "${esc(s.header_value)}" }\n`
  );
  return `${MARK_START}\n${blocks.join('\n')}${MARK_END}\n`;
}

/**
 * Write/replace the managed block in config.toml, preserving everything else.
 * Empty servers → the managed block is removed. Returns { path, count }.
 */
export function syncCodexConfig(configPath, servers) {
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch { /* new file */ }
  const re = new RegExp(escRe(MARK_START) + '[\\s\\S]*?' + escRe(MARK_END) + '\\n?', 'g');
  let base = existing.replace(re, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const block = buildCodexMcpToml(servers);
  let out = block ? (base ? base + '\n\n' + block : block) : base;
  out = out.replace(/\s*$/, '') + '\n';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, out);
  return { path: configPath, count: servers ? servers.length : 0 };
}
