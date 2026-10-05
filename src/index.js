import { config } from './config.js';
import { openDb, getSetting, getSession, sessionHistory, listMcpServers } from './db.js';
import { createQueue } from './queue.js';
import { spawnRunner } from './runner.js';
import { buildServer } from './server.js';
import { networkInterfaces, homedir } from 'node:os';
import path from 'node:path';

function localIps() {
  const nets = networkInterfaces();
  const ips = [];
  for (const addrs of Object.values(nets)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  }
  return ips;
}

async function main() {
  const db = openDb(config.dbPath);
  // API key resolution: stored setting first, then environment variable fallback.
  const envKey = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  const getApiKey = (provider) => getSetting(db, `${provider}_api_key`) || envKey[provider] || null;
  const models = { openai: config.openaiModel, anthropic: config.anthropicModel, anthropicMaxTokens: config.anthropicMaxTokens };

  // Session continuity: summary + turns AFTER the compressed prefix.
  const getSessionContext = (sessionId) => {
    const s = getSession(db, sessionId);
    if (!s) return { summary: null, turns: [] };
    const all = sessionHistory(db, sessionId);
    return { summary: s.summary || null, turns: all.slice(s.turns_before_summary || 0) };
  };

  const getMcpServers = () => listMcpServers(db);

  const run = spawnRunner({ defaultCwd: config.defaultCwd, taskTimeoutMs: config.taskTimeoutMs, getApiKey, models, getSessionContext, getMcpServers });
  const queue = createQueue({ db, run });
  // Codex reads MCP config from $CODEX_HOME/config.toml (default ~/.codex).
  const codexConfigPath = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');

  const app = buildServer({ db, queue, token: config.token, publicDir: config.publicDir, version: config.version, repoSlug: config.repoSlug, getApiKey, models, codexConfigPath });

  await app.listen({ host: config.host, port: config.port });

  const line = '='.repeat(60);
  console.log(line);
  console.log('  OnlyMind is running');
  console.log(line);
  console.log(`  Local:     http://localhost:${config.port}`);
  for (const ip of localIps()) {
    console.log(`  LAN:       http://${ip}:${config.port}   (same Wi-Fi only)`);
  }
  console.log('  Remote:    expose via Cloudflare Tunnel — see docs/08-remote-access.md');
  console.log('');
  if (config.tokenGenerated) {
    console.log('  ACCESS TOKEN (generated — paste this into the web page):');
    console.log(`      ${config.token}`);
    console.log('  Set ONLYMIND_TOKEN to use a fixed token instead.');
  } else {
    console.log('  Access token: (from ONLYMIND_TOKEN)');
  }
  console.log(line);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await app.close();
      db.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Failed to start OnlyMind:', err);
  process.exit(1);
});
