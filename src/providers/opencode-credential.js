'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * OpenCode Go stores its credential in the OpenCode CLI database:
 *   ~/.local/share/opencode/opencode.db
 *   table credential -> { integration_id: 'opencode-go', value: '{"type":"key","key":"oc_..."}' }
 *
 * Reuse it when the provider config has no explicit apiKey, so AnyCursor users
 * who already signed in to OpenCode Go do not have to paste the key again.
 */

function opencodeDataDir(env = process.env) {
  if (env.OPENCODE_DATA_DIR) return env.OPENCODE_DATA_DIR;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, '.local', 'share', 'opencode');
}

function parseCredential(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_) {
    return value.startsWith('oc_') ? value : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.key === 'string' && parsed.key.trim()) return parsed.key.trim();
  if (typeof parsed.accessToken === 'string' && parsed.accessToken.trim()) return parsed.accessToken.trim();
  return null;
}

function readOpencodeCredential(options = {}) {
  const env = options.env || process.env;
  const dbPath = options.dbPath || path.join(opencodeDataDir(env), 'opencode.db');
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (_) {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA query_only = ON');
    }
    db.exec('PRAGMA busy_timeout = 1500');
    const row = db.prepare(`
      SELECT value FROM credential
      WHERE integration_id = 'opencode-go' AND active = 1
      ORDER BY time_updated DESC LIMIT 1
    `).get();
    const key = parseCredential(row && row.value);
    if (!key) return null;
    return { key, source: dbPath };
  } catch (_) {
    return null;
  } finally {
    if (db) { try { db.close(); } catch (_) { /* ignore */ } }
  }
}

let cache = { at: 0, value: null, ttlMs: 60000 };

function cachedOpencodeCredential(options = {}) {
  const now = Date.now();
  const ttl = options.ttlMs === undefined ? cache.ttlMs : options.ttlMs;
  if (cache.at && now - cache.at < ttl) return cache.value;
  const value = readOpencodeCredential(options);
  cache = { at: now, value, ttlMs: ttl };
  return value;
}

function clearCredentialCache() {
  cache = { at: 0, value: null, ttlMs: cache.ttlMs };
}

module.exports = {
  opencodeDataDir,
  parseCredential,
  readOpencodeCredential,
  cachedOpencodeCredential,
  clearCredentialCache,
};
