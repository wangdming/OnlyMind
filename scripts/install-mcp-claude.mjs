#!/usr/bin/env node
// Mount the OnlyMind MCP server into Claude (user scope) so local Claude can
// read this computer's OnlyMind sessions/tasks and continue the work.
//   npm run mcp:claude          # install
//   npm run mcp:claude -- remove  # uninstall
//
// Codex / other MCP clients: add a stdio server running `node <this path>`:
//   scripts/mcp-server.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(ROOT, 'scripts', 'mcp-server.mjs');
const remove = process.argv.slice(2).includes('remove');

function has(cmd) {
  return spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;
}
if (!has('claude')) {
  console.error('[FAIL] 未找到 claude。请先安装 Claude Code。');
  process.exit(1);
}

const args = remove
  ? ['mcp', 'remove', 'onlymind']
  : ['mcp', 'add', '--scope', 'user', 'onlymind', '--', 'node', server];

console.log((remove ? '从 Claude 移除' : '挂载到 Claude(user 范围)') + ':claude ' + args.join(' '));
const r = spawnSync('claude', args, { stdio: 'inherit', shell: WIN });
if (r.status === 0 && !remove) {
  console.log('\n✓ 已挂载。现在在任意目录运行 `claude`,它都能用工具:');
  console.log('  list_sessions / get_session_transcript / search_tasks');
  console.log('  例如问它:「用 onlymind 列出会话,并把最近一个会话的完整转录取来,接着继续」');
}
process.exit(r.status || 0);
