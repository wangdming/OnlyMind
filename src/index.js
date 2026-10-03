import { config } from './config.js';
import { openDb } from './db.js';
import { createQueue } from './queue.js';
import { spawnRunner } from './runner.js';
import { buildServer } from './server.js';
import { networkInterfaces } from 'node:os';

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
  const run = spawnRunner({ defaultCwd: config.defaultCwd, taskTimeoutMs: config.taskTimeoutMs });
  const queue = createQueue({ db, run });
  const app = buildServer({ db, queue, token: config.token, publicDir: config.publicDir, version: config.version, repoSlug: config.repoSlug });

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
