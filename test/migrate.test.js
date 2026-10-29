'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('migrates legacy model ids in Cursor state and composer data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-migrate-'));
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  const storageKey = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
  const storage = {
    aiSettings: {
      modelConfig: {
        composer: {
          modelName: 'deepseek-v4.1-flash',
          maxMode: false,
          selectedModels: [{ modelId: 'deepseek-v4.1-flash', parameters: [] }],
        },
      },
      modelOverrideEnabled: ['deepseek-v4.1-flash'],
      modelLastUsedAt: { 'deepseek-v4.1-flash': '2026-01-01T00:00:00.000Z' },
    },
  };
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(storageKey, JSON.stringify(storage));
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'composerData:conv1',
    JSON.stringify({
      composerId: 'conv1',
      modelConfig: {
        modelName: 'deepseek-v4.1-flash',
        selectedModels: [{ modelId: 'deepseek-v4.1-flash', parameters: [] }],
      },
    }),
  );
  db.close();

  const config = path.join(__dirname, '..', 'config', 'anycursor.example.json');
  execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'migrate-model-ids.js'),
    '--force',
    `--db=${dbPath}`,
  ], {
    env: { ...process.env, ANY_CURSOR_CONFIG: config, LOCALAPPDATA: dir },
    stdio: 'pipe',
  });

  const after = new DatabaseSync(dbPath, { readOnly: true });
  const migratedStorage = JSON.parse(after.prepare('SELECT value FROM ItemTable WHERE key = ?').get(storageKey).value);
  const migratedComposer = JSON.parse(after.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composerData:conv1').value);
  after.close();

  const namespaced = 'anycursor/opencode/deepseek-v4.1-flash';
  assert.equal(migratedStorage.aiSettings.modelConfig.composer.modelName, namespaced);
  assert.equal(migratedStorage.aiSettings.modelConfig.composer.selectedModels[0].modelId, namespaced);
  assert.deepEqual(migratedStorage.aiSettings.modelOverrideEnabled, [namespaced]);
  assert.equal(migratedStorage.aiSettings.modelLastUsedAt[namespaced], '2026-01-01T00:00:00.000Z');
  assert.equal(migratedComposer.modelConfig.modelName, namespaced);
  assert.equal(migratedComposer.modelConfig.selectedModels[0].modelId, namespaced);
});
