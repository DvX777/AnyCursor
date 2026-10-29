'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  parseCredential,
  readOpencodeCredential,
  cachedOpencodeCredential,
  clearCredentialCache,
} = require('../src/providers/opencode-credential');

function fixture(value, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-credential-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      connector_id TEXT, method_id TEXT, active INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
  `);
  if (value !== undefined) {
    db.prepare(`INSERT INTO credential
      (id, integration_id, label, value, active, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, 1, 1)`)
      .run('cred_1', options.integration || 'opencode-go', 'OpenCode Go', value, options.active === false ? 0 : 1);
  }
  db.close();
  return { dir, dbPath };
}

test('parses OpenCode credential JSON and plain keys', () => {
  assert.equal(parseCredential('{"type":"key","key":"oc_abc"}'), 'oc_abc');
  assert.equal(parseCredential('{"type":"oauth","accessToken":"token_1"}'), 'token_1');
  assert.equal(parseCredential('oc_plain'), 'oc_plain');
  assert.equal(parseCredential('{"type":"key"}'), null);
  assert.equal(parseCredential(''), null);
});

test('reads an active opencode-go credential from the local database', () => {
  const { dir, dbPath } = fixture('{"type":"key","key":"oc_test_123"}');
  const credential = readOpencodeCredential({ dbPath });
  assert.equal(credential.key, 'oc_test_123');
  assert.equal(credential.source, dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ignores inactive or unrelated credentials', () => {
  const inactive = fixture('{"type":"key","key":"oc_inactive"}', { active: false });
  assert.equal(readOpencodeCredential({ dbPath: inactive.dbPath }), null);
  fs.rmSync(inactive.dir, { recursive: true, force: true });

  const other = fixture('{"type":"key","key":"oc_other"}', { integration: 'github' });
  assert.equal(readOpencodeCredential({ dbPath: other.dbPath }), null);
  fs.rmSync(other.dir, { recursive: true, force: true });
});

test('returns null when the database or row is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-credential-'));
  assert.equal(readOpencodeCredential({ dbPath: path.join(dir, 'missing.db') }), null);

  const empty = fixture(undefined);
  assert.equal(readOpencodeCredential({ dbPath: empty.dbPath }), null);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty.dir, { recursive: true, force: true });
});

test('caches the credential briefly', () => {
  clearCredentialCache();
  const { dir, dbPath } = fixture('{"type":"key","key":"oc_cached"}');
  const first = cachedOpencodeCredential({ dbPath, ttlMs: 60000 });
  assert.equal(first.key, 'oc_cached');

  const other = fixture('{"type":"key","key":"oc_other"}');
  const second = cachedOpencodeCredential({ dbPath: other.dbPath, ttlMs: 60000 });
  assert.equal(second.key, 'oc_cached', 'cache avoids reopening the database');

  clearCredentialCache();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(other.dir, { recursive: true, force: true });
});
