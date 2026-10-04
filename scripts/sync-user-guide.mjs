#!/usr/bin/env node
// Sync the 4 customer-facing manuals from docs/ into user-guide/ (project root).
// Run standalone (`node scripts/sync-user-guide.mjs`) or via package.mjs before zipping.
//
// The manuals live in docs/ (edited there, alongside the other numbered docs).
// user-guide/ is the clean, easy-to-find copy shipped to customers. Links to
// numbered docs (docs/NN-*.md) are rewritten to ../docs/NN-*.md so they still
// resolve from inside user-guide/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MANUALS = [
  'install-macos.md',
  'usage-macos.md',
  'install-windows.md',
  'usage-windows.md',
];

export function syncUserGuide(root = ROOT) {
  const srcDir = path.join(root, 'docs');
  const outDir = path.join(root, 'user-guide');
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of MANUALS) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) throw new Error(`缺少手册源文件: docs/${name}`);
    let text = fs.readFileSync(src, 'utf8');
    // Links to numbered docs (./NN-xxx.md[#anchor]) → ../docs/NN-xxx.md
    text = text.replace(/\]\(\.\/(\d{2}-[^)]+\.md[^)]*)\)/g, '](../docs/$1)');
    fs.writeFileSync(path.join(outDir, name), text);
  }

  // A small index so the folder is self-explanatory.
  fs.writeFileSync(path.join(outDir, 'README.md'),
    '# OnlyMind 说明书\n\n按你的系统选择:\n\n' +
    '## macOS\n- [安装手册](./install-macos.md)\n- [使用手册](./usage-macos.md)\n\n' +
    '## Windows\n- [安装手册](./install-windows.md)\n- [使用手册](./usage-windows.md)\n\n' +
    '> 本目录由 `scripts/sync-user-guide.mjs` 从 `docs/` 自动生成,每次打包前刷新。\n');

  return MANUALS.length;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const n = syncUserGuide();
  console.log(`✓ 已同步 ${n} 份手册到 user-guide/`);
}
