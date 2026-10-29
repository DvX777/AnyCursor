'use strict';

/*
 * Stage the gateway runtime inside the extension so a packaged VSIX works
 * without the source repository.
 *
 * Usage: node scripts/stage-extension.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'extension', 'vendor', 'anycursor');

const DIRS = ['src', 'public', 'schema', 'config', 'scripts'];
const FILES = ['package.json', 'README.md', 'LICENSE'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, target);
      continue;
    }
    // Never ship a real config with credentials; the installer seeds it.
    if (/^anycursor\.json(\.|$)/.test(entry.name)) continue;
    if (entry.name.endsWith('.bak') || entry.name.endsWith('.log')) continue;
    fs.copyFileSync(source, target);
  }
}

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

for (const dir of DIRS) {
  const from = path.join(root, dir);
  if (fs.existsSync(from)) copyDir(from, path.join(vendor, dir));
}
for (const file of FILES) {
  const from = path.join(root, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(vendor, file));
}

const gateway = path.join(vendor, 'src', 'gateway', 'index.js');
if (!fs.existsSync(gateway)) {
  console.error(`staging failed: ${gateway} is missing`);
  process.exit(1);
}

const bytes = fs.readdirSync(vendor, { recursive: true })
  .filter((name) => fs.statSync(path.join(vendor, name)).isFile())
  .reduce((sum, name) => sum + fs.statSync(path.join(vendor, name)).size, 0);
console.log(`staged gateway runtime in ${vendor} (${(bytes / 1024).toFixed(0)} KiB)`);
