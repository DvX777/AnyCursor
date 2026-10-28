'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function cursorUserDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(env.HOME || '', 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config'), 'Cursor', 'User');
}

function readPersistentStorage(env = process.env) {
  const file = path.join(cursorUserDir(env), 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(file)) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare(
      "SELECT value FROM ItemTable WHERE key = ?",
    ).get('src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser');
    return row ? JSON.parse(row.value) : null;
  } catch (_) {
    return null;
  } finally {
    if (db) { try { db.close(); } catch (_) { /* ignore */ } }
  }
}

/**
 * Cursor may have selected either the namespaced AnyCursor id or a legacy id.
 * The catalog must expose exactly the selected id so the picker never points at
 * a model that is missing from the catalog.
 */
function selectedModelIds(env = process.env) {
  const storage = readPersistentStorage(env);
  const config = storage && storage.aiSettings && storage.aiSettings.modelConfig;
  if (!config || typeof config !== 'object') return [];
  const ids = [];
  for (const entry of Object.values(config)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.modelName === 'string' && entry.modelName) ids.push(entry.modelName);
    if (Array.isArray(entry.selectedModels)) {
      for (const selected of entry.selectedModels) {
        if (selected && typeof selected.modelId === 'string' && selected.modelId) ids.push(selected.modelId);
      }
    }
  }
  return [...new Set(ids)];
}

module.exports = {
  cursorUserDir,
  readPersistentStorage,
  selectedModelIds,
};
