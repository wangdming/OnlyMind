#!/usr/bin/env node
// Check the Cloudflare Tunnel setup that exposes OnlyMind to your phone.
//
// It verifies the whole chain: cloudflared installed → tunnel configured →
// OnlyMind running locally → the public hostname is reachable AND protected by
// Cloudflare Access (critical, because OnlyMind can run arbitrary commands).
//
// Exposed as `checkCloudflare(report, opts)` so the env doctor can run it as a
// section; also runnable standalone:
//   npm run check:tunnel            human-readable report
//   npm run check:tunnel -- --json  machine-readable JSON (for automation)

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const CLR = !process.env.NO_COLOR && process.stdout.isTTY;
const dim = (s) => (CLR ? `\x1b[90m${s}\x1b[0m` : s);
const yb = (s) => (CLR ? `\x1b[1;33m${s}\x1b[0m` : s);

function sh(cmd, args, timeout = 8000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout });
}
function findCommand(cmd) {
  const r = sh(WIN ? 'where' : 'which', [cmd], 5000);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function readTunnelConfig() {
  const p = path.join(os.homedir(), '.cloudflared', 'config.yml');
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const tunnel = (text.match(/^\s*tunnel:\s*(\S+)/m) || [])[1] || null;
  const hostname = (text.match(/hostname:\s*(\S+)/) || [])[1] || null;
  const service = (text.match(/service:\s*(https?:\/\/\S+)/) || [])[1] || null;
  let port = null;
  if (service) port = Number((service.match(/:(\d+)/) || [])[1]) || null;
  const protocol = (text.match(/^\s*protocol:\s*(\S+)/m) || [])[1] || null;
  return { path: p, tunnel, hostname, service, port, protocol };
}

async function httpProbe(url, timeoutMs, redirect = 'manual') {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect });
    clearTimeout(t);
    let body = '';
    try { body = (await res.text()).slice(0, 2000); } catch { /* ignore */ }
    return { status: res.status, location: res.headers.get('location') || '', body };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

/**
 * @param {{ok,wn,er,info,section}} R
 * @param {{strict?:boolean, json?:boolean}} opts
 * @returns {Promise<{verdict,counts,findings,data,remediation}>}
 */
export async function checkCloudflare(R, opts = {}) {
  const strict = !!opts.strict;
  const findings = [];
  const data = { platform: process.platform };
  const issues = new Set();
  const LVL = { ok: 'ok', warn: 'wn', fail: 'er', info: 'info' };
  const rec = (level, msg, detail, key) => {
    findings.push({ level, key: key || null, msg, detail: detail || null });
    R[LVL[level]](msg, detail);
  };
  const miss = (msg, detail, key) => rec(strict ? 'fail' : 'warn', msg, detail, key);

  R.section('C. Cloudflare 隧道(手机远程访问)');

  // --- cloudflared installed? ---
  const bin = findCommand('cloudflared');
  data.installed = !!bin;
  if (!bin) {
    miss('未安装 cloudflared', '公网远程访问需要它', 'install');
    issues.add('install');
    return finish();
  }
  const ver = sh(bin, ['--version'], 8000);
  rec('ok', '已安装 cloudflared', (ver.stdout || '').trim().split(/\r?\n/)[0] || bin, 'install');

  // --- named tunnel configured? ---
  const cfg = readTunnelConfig();
  data.config = cfg ? { hostname: cfg.hostname, port: cfg.port, protocol: cfg.protocol, tunnel: cfg.tunnel } : null;
  if (!cfg) {
    miss('未找到命名隧道配置 (~/.cloudflared/config.yml)',
      '只用临时隧道无法加 Access;请按 docs/08 配置命名隧道', 'config');
    issues.add('config');
  } else {
    rec('ok', '找到隧道配置', cfg.path);
    if (cfg.hostname) rec('ok', '隧道域名', cfg.hostname);
    else { rec('warn', 'config.yml 未配置 hostname', '检查 ingress 段', 'config'); issues.add('config'); }
    if (cfg.protocol === 'http2') rec('ok', 'protocol: http2(利于在国内连通)');
    else rec('info', 'protocol 未设为 http2', '国内若连不上 Cloudflare,建议在 config.yml 设 protocol: http2');
  }

  // --- OnlyMind running locally? ---
  const port = (cfg && cfg.port) || Number(process.env.ONLYMIND_PORT) || 8787;
  data.localPort = port;
  const local = await httpProbe(`http://localhost:${port}/api/health`, 4000, 'manual');
  if (local.error) {
    rec('warn', `本地 OnlyMind 未响应 (localhost:${port})`, 'cloudflared 转发目标须是运行中的 OnlyMind;先 npm start', 'local');
    issues.add('local');
  } else if (local.status === 401) {
    rec('ok', `本地 OnlyMind 运行中 (localhost:${port})`, '鉴权生效(401)');
  } else {
    rec('ok', `本地端口 ${port} 有响应`, `HTTP ${local.status}`);
  }

  // --- public hostname reachable AND protected by Access? ---
  if (cfg && cfg.hostname) {
    const url = `https://${cfg.hostname}/`;
    R.info(`探测公网域名 ${url} …`);
    const pub = await httpProbe(url, 8000, 'manual');
    data.public = pub.error ? { error: pub.error } : { status: pub.status, location: pub.location };
    if (pub.error) {
      rec('warn', '公网域名访问失败', `${pub.error};可能 cloudflared 未运行 / DNS 未生效 / 本机被墙(可在翻墙环境复测)`, 'public');
      issues.add('run');
    } else {
      const toAccess = /cloudflareaccess\.com/i.test(pub.location) || /cloudflareaccess\.com/i.test(pub.body);
      const looksLikeApp = /OnlyMind/i.test(pub.body);
      if (toAccess) {
        rec('ok', '公网可达,且已启用 Cloudflare Access', '访问会先要求登录鉴权 ✓');
      } else if (looksLikeApp || pub.status === 200) {
        rec('fail', '公网可直接打开 OnlyMind —— 未启用 Access(危险!)',
          '任意命令执行接口裸奔在公网。请立即配置 Cloudflare Access', 'access');
        issues.add('access');
      } else {
        rec('warn', `公网返回 HTTP ${pub.status}`, '无法确认 Access 状态;请手动用手机访问确认会要求登录', 'access');
      }
    }
  } else {
    rec('info', '未配置域名,跳过公网可达性检测');
  }

  return finish();

  function finish() {
    const counts = {
      ok: findings.filter((f) => f.level === 'ok').length,
      warn: findings.filter((f) => f.level === 'warn').length,
      fail: findings.filter((f) => f.level === 'fail').length,
    };
    const verdict = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'pass';
    const remediation = remedyLines(issues);
    if (!opts.json && issues.size) printRemedy(remediation);
    return { verdict, counts, findings, data, remediation };
  }
}

function remedyLines(issues) {
  const out = [];
  if (issues.has('install')) {
    out.push('安装 cloudflared:');
    if (MAC) out.push('  brew install cloudflared');
    else if (WIN) out.push('  winget install Cloudflare.cloudflared');
    else out.push('  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  }
  if (issues.has('config')) {
    out.push('配置命名隧道(可加 Access,网址固定):');
    out.push('  cloudflared tunnel login');
    out.push('  cloudflared tunnel create onlymind');
    out.push('  cp scripts/cloudflared-config.example.yml ~/.cloudflared/config.yml  并填好 ID/域名/端口');
    out.push('  cloudflared tunnel route dns onlymind onlymind.你的域名.com');
  }
  if (issues.has('local')) {
    out.push('启动 OnlyMind 本体:ONLYMIND_TOKEN=你的令牌 npm start(端口需与 config.yml 的 service 一致)');
  }
  if (issues.has('run')) {
    out.push('运行隧道:npm run tunnel onlymind(或 cloudflared tunnel run onlymind)');
    out.push('  国内连不上 Cloudflare 时:config.yml 设  protocol: http2;并给 cloudflared 设 HTTPS_PROXY 走本地翻墙代理');
  }
  if (issues.has('access')) {
    out.push('启用 Cloudflare Access(必做,否则命令执行接口裸奔公网):');
    out.push('  Zero Trust 控制台 → Access → Applications → Add → Self-hosted');
    out.push('  域名填 onlymind.你的域名.com;Policy: Allow + Emails=你的邮箱(One-time PIN)');
  }
  return out;
}
function printRemedy(lines) {
  console.log('\n  ' + yb('修复建议 / 如何修改配置:'));
  for (const l of lines) console.log('  ' + dim((/^\s/.test(l) ? '  ' : '• ') + l.trimStart()));
}

// ---- standalone entry -----------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法: node scripts/check-tunnel.mjs [--json]\n  --json   输出结构化 JSON(自动化用)');
    process.exit(0);
  }
  if (args.includes('--json')) {
    const silent = { ok() {}, wn() {}, er() {}, info() {}, section() {} };
    const orig = console.log; console.log = () => {};
    const result = await checkCloudflare(silent, { strict: true, json: true });
    console.log = orig;
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.verdict === 'fail' ? 1 : 0);
  }
  const col = (code, s) => (CLR ? `\x1b[${code}m${s}\x1b[0m` : s);
  let pass = 0, warn = 0, fail = 0;
  const R = {
    ok: (m, d) => { pass++; console.log(`  ${col('32', '[ OK ]')} ${m}${d ? col('90', '  — ' + d) : ''}`); },
    wn: (m, d) => { warn++; console.log(`  ${col('33', '[WARN]')} ${m}${d ? col('90', '  — ' + d) : ''}`); },
    er: (m, d) => { fail++; console.log(`  ${col('31', '[FAIL]')} ${m}${d ? col('90', '  — ' + d) : ''}`); },
    info: (m, d) => console.log(`  ${col('36', '[INFO]')} ${m}${d ? col('90', '  — ' + d) : ''}`),
    section: (t) => console.log('\n' + col('1;36', t)),
  };
  console.log(col('1', '\n=== Cloudflare 隧道检测 ===') + col('90', `  (${process.platform})`));
  const result = await checkCloudflare(R, { strict: true });
  console.log('\n' + col('1;36', '结果 Summary'));
  console.log(`  ${col('32', 'OK ' + pass)}   ${col('33', 'WARN ' + warn)}   ${col('31', 'FAIL ' + fail)}`);
  process.exit(result.verdict === 'fail' ? 1 : 0);
}
