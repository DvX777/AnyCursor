'use strict';

/*
 * Discover effort tiers from the models.dev catalogue and update model config.
 * Usage:
 *   node scripts/discover-models.js
 *   node scripts/discover-models.js --write
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config/load');
const { fetchModelsDev, enrichConfig } = require('../src/catalog/models-dev');

const root = path.join(__dirname, '..');
const file = process.env.ANY_CURSOR_CONFIG || path.join(root, 'config', 'anycursor.json');
const write = process.argv.includes('--write');

async function main() {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { config } = loadConfig(file);
  const catalog = await fetchModelsDev();
  const enriched = enrichConfig(config, catalog);

  let changes = 0;
  for (const model of enriched.models) {
    if (!model.effort) continue;
    const target = (raw.models || []).find((m) => (m.id || m.model) === model.id || m.model === model.model);
    if (!target) continue;
    const next = { ...model.effort };
    const before = JSON.stringify(target.effort || null);
    const after = JSON.stringify(next);
    if (before === after) continue;
    target.effort = next;
    changes++;
    console.log(`${model.id}: ${next.tiers.map((t) => t.label).join(', ')} (default ${next.default})`);
  }

  if (write && changes) {
    const backup = `${file}.${Date.now()}.bak`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
    console.log(`updated ${changes} model(s); backup: ${backup}`);
  } else {
    console.log(changes ? `${changes} model(s) would change; run with --write` : 'no effort changes');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
