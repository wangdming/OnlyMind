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

// Refresh the customer-facing manuals in user-guide/ before packaging.
syncUserGuide(ROOT);
console.log('已同步 user-guide/(4 份说明书)');

// Generate 更新说明.md (this version's notes) from CHANGELOG.md, with a git fallback.
writeReleaseNotes(ROOT, pkg.version);

// Compute entries AFTER generating 更新说明.md so it is included in the zip.
const entries = fs.readdirSync(ROOT).filter(
  (e) => !EXCLUDE.has(e) && !e.endsWith('.zip') && !e.endsWith('.db')
);

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
console.log('  含本次「ChangeLog.md」,客户解压后即可看到本版更新内容。');

// --- helpers ---------------------------------------------------------------
function extractChangelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const re = new RegExp('^##\\s+\\[?v?' + version.replace(/\./g, '\\.') + '\\b');
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { start = i; break; } }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { if (/^##\s+/.test(lines[i])) { end = i; break; } }
  return lines.slice(start, end).join('\n').trim();
}
function gitNotesFallback(root) {
  try {
    const prev = spawnSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD^'], { cwd: root, encoding: 'utf8' }).stdout.trim()
      || spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const range = prev ? `${prev}..HEAD` : 'HEAD';
    const log = spawnSync('git', ['log', '--no-merges', '--pretty=- %s', range], { cwd: root, encoding: 'utf8' }).stdout.trim();
    return log || null;
  } catch { return null; }
}
function writeReleaseNotes(root, version) {
  const notesPath = path.join(root, 'ChangeLog.md'); // delivered per-version notes
  let body = null;
  let source = '';
  const clPath = path.join(root, 'docs', 'CHANGELOG.md'); // curated full history (source)
  if (fs.existsSync(clPath)) {
    const sec = extractChangelogSection(fs.readFileSync(clPath, 'utf8'), version);
    if (sec) { body = sec; source = 'docs/CHANGELOG.md'; }
  }
  if (!body) {
    const git = gitNotesFallback(root);
    body = `## v${version}\n\n(自动根据 git 提交生成,建议在 docs/CHANGELOG.md 补充正式说明)\n\n${git || '- 本次更新'}`;
    source = 'git 提交(兜底)';
    console.warn(`⚠ docs/CHANGELOG.md 未找到 v${version} 条目,已用${source}生成 ChangeLog.md`);
  }
  fs.writeFileSync(notesPath, `# OnlyMind 更新说明\n\n> 版本 v${version}\n\n${body}\n`);
  console.log(`已生成 ChangeLog.md(v${version},来源:${source})`);
}
