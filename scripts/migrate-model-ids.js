'use strict';

/*
 * One-time migration: rewrite legacy model ids in Cursor's local composer and
 * application state to their AnyCursor namespaced ids.
 *
 * Cursor must be closed. The database is backed up first.
 *
 * Usage:
 *   node scripts/migrate-model-ids.js
 *   node scripts/migrate-model-ids.js --force
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config/load');

const root = path.join(__dirname, '..');
const configPath = process.env.ANY_CURSOR_CONFIG || path.join(root, 'config', 'anycursor.json');
const force = process.argv.includes('--force');
const dbArg = process.argv.find((arg) => arg.startsWith('--db='));

function cursorRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Cursor.exe"', { encoding: 'utf8' });
    return /Cursor\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

function stateDbPath() {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function backup(dbPath) {
  const dir = path.join(process.env.LOCALAPPDATA || path.dirname(dbPath), 'AnyCursor', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `state-${stamp}.vscdb`);
  fs.copyFileSync(dbPath, target);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, target + suffix);
  }
  return target;
}

function rewriteValue(value, mapping, stats) {
  if (Array.isArray(value)) {
    for (const item of value) rewriteValue(item, mapping, stats);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && mapping.has(child)) {
      value[key] = mapping.get(child);
      stats.strings++;
      continue;
    }
    rewriteValue(child, mapping, stats);
  }
  return value;
}

function rewriteStorageJson(value, mapping, stats) {
  const obj = JSON.parse(value);
  const settings = obj && obj.aiSettings;
  if (settings) {
    rewriteValue(settings.modelConfig, mapping, stats);
    if (Array.isArray(settings.modelOverrideEnabled)) {
      settings.modelOverrideEnabled = [...new Set(settings.modelOverrideEnabled.map((id) => mapping.get(id) || id))];
    }
    if (settings.modelLastUsedAt && typeof settings.modelLastUsedAt === 'object') {
      for (const [oldId, newId] of mapping) {
        if (settings.modelLastUsedAt[oldId] && !settings.modelLastUsedAt[newId]) {
          settings.modelLastUsedAt[newId] = settings.modelLastUsedAt[oldId];
        }
      }
    }
  }
  return JSON.stringify(obj);
}

function main() {
  if (cursorRunning() && !force) {
    console.error('Cursor is running. Fully quit it first, then run this script again.');
    console.error('Use --force only if you accept the risk of editing an open database.');
    process.exit(1);
  }
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }

  const { config } = loadConfig(configPath);
  const mapping = new Map();
  for (const model of config.models) {
    for (const legacy of model.legacyIds || []) {
      if (legacy && legacy !== model.cursorId) mapping.set(legacy, model.cursorId);
    }
  }
  if (mapping.size === 0) {
    console.log('No legacy model ids configured; nothing to migrate.');
    return;
  }

  const dbPath = dbArg ? dbArg.slice('--db='.length) : stateDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`Cursor state database not found: ${dbPath}`);
    process.exit(1);
  }
  const backupPath = backup(dbPath);
  console.log(`backup: ${backupPath}`);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const stats = { strings: 0, storage: 0, composers: 0 };
  try {
    db.exec('BEGIN IMMEDIATE');
    const storageKey = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
    const storage = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(storageKey);
    if (storage) {
      db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(
        rewriteStorageJson(storage.value, mapping, stats),
        storageKey,
      );
      stats.storage++;
    }

    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
    const update = db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?');
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.value); } catch (_) { continue; }
      if (!data || typeof data !== 'object') continue;
      const before = JSON.stringify(data);
      rewriteValue(data, mapping, stats);
      const after = JSON.stringify(data);
      if (after !== before) {
        update.run(after, row.key);
        stats.composers++;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    db.close();
  }

  console.log(`migrated storage rows: ${stats.storage}`);
  console.log(`migrated composer rows: ${stats.composers}`);
  console.log(`rewritten model id strings: ${stats.strings}`);
  console.log('Restart Cursor, then open an old chat and a new chat.');
}

main();
