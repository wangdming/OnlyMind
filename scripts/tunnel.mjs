#!/usr/bin/env node
// Start a Cloudflare Tunnel in front of OnlyMind. Cross-platform (macOS/Windows/Linux).
//   npm run tunnel              quick ephemeral tunnel (TEST ONLY, no Access)
//   npm run tunnel -- <name>    run a named tunnel (production; see docs/08)
//
// cloudflared is a native binary on all platforms, so no shell is needed.

import { spawn, spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';

function hasCloudflared() {
  const r = spawnSync(WIN ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  return r.status === 0;
}

if (!hasCloudflared()) {
  console.error('[FAIL] 未找到 cloudflared。安装:' + (WIN ? 'winget install Cloudflare.cloudflared' : 'brew install cloudflared'));
  console.error('       详见 docs/08-remote-access.md');
  process.exit(1);
}

const port = process.env.ONLYMIND_PORT || '8787';
const name = process.argv[2];

let args;
if (name) {
  console.log(`>> 运行命名隧道 '${name}'(需已按 docs/08 配置好 config.yml + Access)`);
  args = ['tunnel', 'run', name];
} else {
  console.log('>> 启动临时隧道(仅测试用,无 Access 保护!日常请用命名隧道)');
  console.log(`>> 确保 OnlyMind 已在 http://localhost:${port} 运行`);
  args = ['tunnel', '--url', `http://localhost:${port}`];
}

const child = spawn('cloudflared', args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
// Ctrl+C in this terminal will reach cloudflared via the inherited stdio.
