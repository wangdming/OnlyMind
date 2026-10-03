#!/usr/bin/env node
// Update OnlyMind to the latest version. Cross-platform (macOS/Windows/Linux).
//   npm run update            update to latest
//   npm run update -- --check only check, don't apply
//
// Two modes, auto-detected:
//   • git checkout  -> `git pull --ff-only` + `npm install`
//   • zip download  -> fetch latest GitHub Release tarball, extract over the
//                      project (preserving data/ and .env), then `npm install`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CHECK_ONLY = process.argv.includes('--check');
const PRESERVE = new Set(['data', '.env', 'node_modules', '.git']);

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
}
function fail(msg) { console.error('[FAIL] ' + msg); process.exit(1); }

// Parse "owner/repo" from package.json repository.url.
function repoSlug() {
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const m = String(url).match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

const isGit = fs.existsSync(path.join(ROOT, '.git'));
console.log(`OnlyMind 当前版本 v${pkg.version} · 模式:${isGit ? 'git' : 'release 下载'}`);

if (isGit) {
  if (sh('git', ['--version']).status !== 0) fail('检测到 .git 但未找到 git 命令');
  if (CHECK_ONLY) {
    sh('git', ['fetch', '--quiet']);
    const behind = sh('git', ['rev-list', '--count', 'HEAD..@{u}']).stdout.trim();
    console.log(behind && behind !== '0' ? `有更新:落后 ${behind} 个提交。运行 npm run update 应用。` : '已是最新。');
    process.exit(0);
  }
  console.log('>> git pull --ff-only');
  const pull = sh('git', ['pull', '--ff-only'], { stdio: 'inherit' });
  if (pull.status !== 0) fail('git pull 失败(可能本地有改动与远端冲突)。请手动处理后重试。');
  console.log('>> npm install');
  if (sh('npm', ['install'], { stdio: 'inherit' }).status !== 0) fail('npm install 失败');
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  console.log(`\n✓ 已更新到 v${v}。若 OnlyMind 正在运行,请重启使其生效。`);
  process.exit(0);
}

// ---- release-download mode ----
const slug = repoSlug();
if (!slug) fail('package.json 的 repository.url 未设置为 GitHub 仓库,无法下载更新。');

console.log(`>> 查询最新 Release: ${slug}`);
const api = `https://api.github.com/repos/${slug}/releases/latest`;
let rel;
try {
  const res = await fetch(api, { headers: { 'User-Agent': 'OnlyMind-Updater', Accept: 'application/vnd.github+json' } });
  if (!res.ok) fail(`GitHub API 返回 ${res.status}(仓库是否存在/是否有 Release?)`);
  rel = await res.json();
} catch (e) { fail('访问 GitHub 失败:' + e.message); }

const latest = rel.tag_name || rel.name || '';
if (!latest) fail('最新 Release 无版本号');
if (cmpVer(latest, pkg.version) <= 0) { console.log(`已是最新(最新 Release ${latest},本地 v${pkg.version})。`); process.exit(0); }
console.log(`发现新版本:${latest}(本地 v${pkg.version})`);
if (CHECK_ONLY) { console.log('运行 npm run update 应用更新。'); process.exit(0); }

// Download source tarball of the release and extract with tar (available on
// macOS, Linux, and Windows 10+).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onlymind-update-'));
const tgz = path.join(tmp, 'src.tar.gz');
console.log('>> 下载更新包…');
try {
  const res = await fetch(rel.tarball_url, { headers: { 'User-Agent': 'OnlyMind-Updater' }, redirect: 'follow' });
  if (!res.ok) fail(`下载失败 HTTP ${res.status}`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
} catch (e) { fail('下载失败:' + e.message); }

console.log('>> 解压…');
if (sh('tar', ['-xzf', tgz, '-C', tmp]).status !== 0) fail('解压失败(需要 tar;Windows 10+ 自带)');
const extracted = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
if (!extracted) fail('解压后未找到源目录');

console.log('>> 覆盖应用文件(保留 data/ 与 .env)…');
fs.cpSync(extracted, ROOT, {
  recursive: true, force: true,
  filter: (src) => {
    const rel2 = path.relative(extracted, src);
    if (!rel2) return true;
    const top = rel2.split(path.sep)[0];
    return !PRESERVE.has(top);
  },
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log('>> npm install');
if (sh('npm', ['install'], { stdio: 'inherit' }).status !== 0) fail('npm install 失败');
const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
console.log(`\n✓ 已更新到 v${v}。若 OnlyMind 正在运行,请重启使其生效。`);
