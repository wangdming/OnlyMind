#!/usr/bin/env node
// OnlyMind diagnostics — checks environment and whether the install works.
// Cross-platform (macOS / Windows / Linux). Run via:
//   npm run doctor
//   ./scripts/doctor-macos.sh      (macOS)
//   .\scripts\doctor-windows.ps1   (Windows)

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkCloudflare } from './check-tunnel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code, s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

let pass = 0, warn = 0, fail = 0;
const ok = (m, d) => { pass++; console.log(`  ${c('32', '[ OK ]')} ${m}${d ? c('90', '  — ' + d) : ''}`); };
const wn = (m, d) => { warn++; console.log(`  ${c('33', '[WARN]')} ${m}${d ? c('90', '  — ' + d) : ''}`); };
const er = (m, d) => { fail++; console.log(`  ${c('31', '[FAIL]')} ${m}${d ? c('90', '  — ' + d) : ''}`); };
const info = (m, d) => console.log(`  ${c('36', '[INFO]')} ${m}${d ? c('90', '  — ' + d) : ''}`);
const section = (t) => console.log('\n' + c('1;36', t));

// Does a command exist on PATH? Returns its resolved path or null.
function findCommand(cmd) {
  const finder = WIN ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

// Try to get `cmd --version` (tolerant: .cmd shims need a shell on Windows).
function tryVersion(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15000, shell: WIN });
  if (r.status === 0 && (r.stdout || r.stderr)) return (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
  return null;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

function localIps() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

console.log(c('1', '\n=== OnlyMind Doctor ===') + c('90', `  (${process.platform}, node ${process.version})`));

// ---- A. Runtime -----------------------------------------------------------
section('A. 运行时 Runtime');
{
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok('Node.js 版本满足要求 (≥ 22)', process.version);
  else er('Node.js 版本过低,需 ≥ 22(内置 node:sqlite)', '当前 ' + process.version);

  try {
    await import('node:sqlite');
    ok('内置 node:sqlite 可用');
  } catch (e) {
    er('node:sqlite 不可用', e.message);
  }
}

// ---- B. Project -----------------------------------------------------------
section('B. 项目文件与依赖 Project');
{
  const must = ['package.json', 'src/index.js', 'src/server.js', 'src/db.js',
    'public/index.html', 'public/app.js'];
  const missing = must.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length === 0) ok('核心文件齐全');
  else er('缺少文件', missing.join(', '));

  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    ok('node_modules 已安装');
    for (const dep of ['fastify', '@fastify/static']) {
      try { await import(dep); ok(`依赖可加载: ${dep}`); }
      catch { er(`依赖缺失/损坏: ${dep}`, '请运行 npm install'); }
    }
  } else {
    er('未安装依赖', '请运行 npm install');
  }
}

// ---- C. Engines -----------------------------------------------------------
section('C. 引擎 Engines');
{
  const claude = findCommand('claude');
  if (claude) ok('claude 在 PATH 上', tryVersion('claude') || claude);
  else er('未找到 claude', '安装 Claude Code 并确保在 PATH 上');

  const codex = findCommand('codex');
  if (codex) ok('codex 在 PATH 上', tryVersion('codex') || codex);
  else wn('未找到 codex(可选)', '仅使用 Claude 时可忽略');

  if (!claude && !codex) er('没有任何可用引擎', '至少需要 claude 或 codex 其一');
}

// ---- D. Config ------------------------------------------------------------
section('D. 配置 Config');
let port = 8787;
{
  if (process.env.ONLYMIND_TOKEN) ok('ONLYMIND_TOKEN 已设置(固定令牌)');
  else wn('未设置 ONLYMIND_TOKEN', '启动时会随机生成并打印;开机自启必须固定令牌');

  port = Number.parseInt(process.env.ONLYMIND_PORT || '8787', 10) || 8787;
  if (await portFree(port)) ok(`端口 ${port} 可用`);
  else wn(`端口 ${port} 被占用`, '可能 OnlyMind 已在运行,或改用 ONLYMIND_PORT');
}

// ---- E. Networking --------------------------------------------------------
section('E. 网络 Networking');
{
  const ips = localIps();
  if (ips.length) ok('本机 IPv4', ips.join(', '));
  else wn('未发现对外 IPv4 地址');
  info('远程访问(Cloudflare 隧道)的检测见下方「C.」专节');
}

// ---- F. Auto-start service -----------------------------------------------
section('F. 开机自启服务 Auto-start');
{
  if (WIN) {
    const r = spawnSync('schtasks', ['/query', '/tn', 'OnlyMind'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) ok('已安装 Windows 计划任务 "OnlyMind"');
    else wn('未安装开机自启', '运行 .\\scripts\\windows-install.ps1');
  } else if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library/LaunchAgents/com.onlymind.plist');
    const r = spawnSync('launchctl', ['list', 'com.onlymind'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) ok('已加载 LaunchAgent "com.onlymind"');
    else if (fs.existsSync(plist)) wn('plist 存在但未加载', '可重新运行 ./scripts/macos-install.sh');
    else wn('未安装开机自启', '运行 ./scripts/macos-install.sh');
  } else {
    wn('当前平台未提供开机自启脚本', process.platform);
  }
}

// ---- G. Live boot self-test ----------------------------------------------
section('G. 启动自检 Live boot (内存实例)');
{
  try {
    const { openDb } = await import('../src/db.js');
    const { createQueue } = await import('../src/queue.js');
    const { spawnRunner } = await import('../src/runner.js');
    const { buildServer } = await import('../src/server.js');
    const { config } = await import('../src/config.js');

    const db = openDb(':memory:');
    const run = spawnRunner({ defaultCwd: os.homedir(), taskTimeoutMs: 1000 });
    const queue = createQueue({ db, run });
    const app = buildServer({ db, queue, token: 'doctor-token', publicDir: config.publicDir });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const p = app.server.address().port;
    const base = `http://127.0.0.1:${p}`;

    const noAuth = await fetch(`${base}/api/health`);
    noAuth.status === 401 ? ok('鉴权生效(无令牌 → 401)') : er('鉴权异常', `期望 401,得到 ${noAuth.status}`);

    const health = await fetch(`${base}/api/health`, { headers: { Authorization: 'Bearer doctor-token' } });
    if (health.ok && (await health.json()).ok) ok('API 健康检查通过');
    else er('健康检查失败', `HTTP ${health.status}`);

    const page = await fetch(`${base}/`);
    page.ok ? ok('网页静态资源可访问') : er('网页无法访问', `HTTP ${page.status}`);

    const engines = await (await fetch(`${base}/api/engines`, { headers: { Authorization: 'Bearer doctor-token' } })).json();
    ok('引擎列表接口正常', engines.engines.map((e) => e.id).join(', '));

    await app.close();
    db.close();
    ok('服务可正常启动与关闭');
  } catch (e) {
    er('启动自检失败', e.message);
  }
}

// ---- C. Cloudflare Tunnel (shared module) --------------------------------
// Non-strict: if you haven't set up remote access yet this is a WARN, not FAIL.
await checkCloudflare({ ok, wn, er, info, section }, { strict: false });

// ---- Summary --------------------------------------------------------------
section('结果 Summary');
console.log(`  ${c('32', 'OK ' + pass)}   ${c('33', 'WARN ' + warn)}   ${c('31', 'FAIL ' + fail)}`);
if (fail > 0) {
  console.log('\n' + c('31', '✗ 存在致命问题,请先修复上面的 [FAIL] 项。'));
  process.exit(1);
} else if (warn > 0) {
  console.log('\n' + c('33', '! 基本可用,但有建议优化的 [WARN] 项(如令牌、Cloudflare 隧道、自启)。'));
  process.exit(0);
} else {
  console.log('\n' + c('32', '✓ 全部通过,安装与环境正常。'));
  process.exit(0);
}
