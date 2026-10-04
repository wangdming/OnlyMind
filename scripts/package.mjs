#!/usr/bin/env node
// Package the project into a delivery zip. Cross-platform (macOS/Windows/Linux).
//   npm run package
// Produces onlymind-<version>.zip in the project root, excluding node_modules,
// data, .git, .env, *.db and any existing zip.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncUserGuide } from './sync-user-guide.mjs';

const WIN = process.platform === 'win32';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const out = `onlymind-${pkg.version}.zip`;

// Exact-name exclusions (dirs/files). .env.example and .gitignore are kept.
const EXCLUDE = new Set(['node_modules', 'data', '.git', '.env', '.DS_Store', 'local', out]);
const entries = fs.readdirSync(ROOT).filter(
  (e) => !EXCLUDE.has(e) && !e.endsWith('.zip') && !e.endsWith('.db')
);

// Refresh the customer-facing manuals in user-guide/ before packaging.
syncUserGuide(ROOT);
console.log('已同步 user-guide/(4 份说明书)');

// Remove a stale archive so it isn't bundled.
try { fs.rmSync(path.join(ROOT, out)); } catch { /* none */ }

console.log('打包内容:', entries.join(', '));
let r;
if (WIN) {
  const list = entries.map((e) => `'${e}'`).join(',');
  r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path ${list} -DestinationPath '${out}' -Force`],
    { cwd: ROOT, stdio: 'inherit' });
} else {
  if (spawnSync('which', ['zip'], { encoding: 'utf8' }).status !== 0) {
    console.error('[FAIL] 未找到 zip 命令(macOS 自带;Linux 可 apt/yum 安装 zip)');
    process.exit(1);
  }
  r = spawnSync('zip', ['-r', '-q', out, ...entries], { cwd: ROOT, stdio: 'inherit' });
}
if (!r || r.status !== 0) { console.error('[FAIL] 打包失败'); process.exit(1); }

const kb = (fs.statSync(path.join(ROOT, out)).size / 1024).toFixed(0);
console.log(`\n✓ 已打包: ${out} (${kb} KB)`);
console.log('  已排除: node_modules / data / .git / .env / *.db');
console.log('  交付给客户:客户解压到一个新建空文件夹,再按 docs/install-*.md 安装。');
