'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  importConversations,
  listWorkspaces,
  resolveWorkspace,
  normalizeFolder,
} = require('../src/history/import');

const WS_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WS_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-history-'));
  const userDir = path.join(root, 'Cursor', 'User');
  const globalDir = path.join(userDir, 'globalStorage');
  const workspaceRoot = path.join(userDir, 'workspaceStorage');
  fs.mkdirSync(globalDir, { recursive: true });
  for (const [id, folder] of [[WS_A, 'C:\\Project\\vidzen'], [WS_B, 'C:\\Project\\AnyCursor']]) {
    const dir = path.join(workspaceRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.vscdb'), '');
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({
      folder: require('url').pathToFileURL(folder).href,
    }));
  }

  const dbPath = path.join(globalDir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,
      subagentTypeName TEXT, value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
  `);

  function insertHeader(id, workspaceId, name, extra = {}) {
    const value = {
      type: 'head',
      composerId: id,
      name,
      workspaceIdentifier: { id: workspaceId, uri: { fsPath: workspaceId } },
      ...extra,
    };
    db.prepare(`INSERT INTO composerHeaders
      (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, subagentTypeName, value)
      VALUES (?, ?, 1000, 2000, 0, 0, 0, 0, '', ?)`)
      .run(id, workspaceId, JSON.stringify(value));
  }
  function kv(key, value) {
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  insertHeader(ROOT, WS_A, 'Root chat');
  insertHeader(SUB, WS_A, 'Sub chat');
  insertHeader('99999999-9999-4999-8999-999999999999', WS_B, '');
  kv(`composerData:${ROOT}`, {
    composerId: ROOT,
    workspaceIdentifier: { id: WS_A },
    fullConversationHeadersOnly: [{ bubbleId: 'b1' }],
    subagentComposerIds: [SUB],
    subComposerIds: [],
    conversationMap: {},
  });
  kv(`composerData:${SUB}`, { composerId: SUB, workspaceIdentifier: { id: WS_A }, subagentComposerIds: [] });
  kv(`bubbleId:${ROOT}:b1`, { bubbleId: 'b1', type: 1, text: 'hello' });
  kv(`bubbleId:${SUB}:b2`, { bubbleId: 'b2', type: 1, text: 'sub hello' });
  kv(`composerConvHeaders:${ROOT}:000000`, { headers: [{ bubbleId: 'b1' }] });
  db.close();

  return { root, dbPath, env: { APPDATA: root, USERPROFILE: root } };
}

function open(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

test('lists workspaces and resolves them by id, folder or basename', () => {
  const fixture = createFixture();
  const workspaces = listWorkspaces({ env: fixture.env });
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces.find((w) => w.id === WS_A).conversations, 2);

  const byId = resolveWorkspace(WS_A, { env: fixture.env });
  assert.equal(byId.workspaceId, WS_A);
  const byName = resolveWorkspace('vidzen', { env: fixture.env });
  assert.equal(byName.workspaceId, WS_A);
  assert.equal(normalizeFolder('C:\\Project\\Vidzen'), normalizeFolder('c:/Project/vidzen'));

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('copies a conversation graph into another workspace with new ids', () => {
  const fixture = createFixture();
  const stores = require('../src/history/cursor-store').listStores(fixture.env);
  const target = stores.find((store) => store.workspaceId === WS_B);

  const result = importConversations({
    ids: [ROOT],
    target,
    force: true,
    env: fixture.env,
    stores,
  });

  assert.equal(result.conversations, 1);
  assert.equal(result.related, 2);
  assert.ok(fs.existsSync(result.backup));

  const newRoot = result.ids[0].to;
  assert.notEqual(newRoot, ROOT);

  const db = open(fixture.dbPath);
  const headers = db.prepare('SELECT composerId, workspaceId, value FROM composerHeaders ORDER BY composerId').all();
  const source = headers.find((row) => row.composerId === ROOT);
  assert.equal(source.workspaceId, WS_A, 'original stays in its workspace');

  const copied = headers.find((row) => row.composerId === newRoot);
  assert.ok(copied, 'copied header exists');
  assert.equal(copied.workspaceId, WS_B);
  assert.equal(JSON.parse(copied.value).workspaceIdentifier.id, WS_B);

  const data = JSON.parse(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${newRoot}`).value);
  assert.equal(data.workspaceIdentifier.id, WS_B);
  assert.equal(data.subagentComposerIds.length, 1);
  const newSub = data.subagentComposerIds[0];
  assert.notEqual(newSub, SUB);
  assert.ok(db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?').get(`composerData:${newSub}`));
  assert.ok(db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${newRoot}:b1`));
  assert.ok(db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${SUB}:b2`), 'source bubble remains');

  db.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('moves a conversation without changing its id', () => {
  const fixture = createFixture();
  const stores = require('../src/history/cursor-store').listStores(fixture.env);
  const target = stores.find((store) => store.workspaceId === WS_B);

  const result = importConversations({
    ids: [ROOT],
    target,
    move: true,
    force: true,
    env: fixture.env,
    stores,
  });
  assert.equal(result.ids[0].to, ROOT);

  const db = open(fixture.dbPath);
  const row = db.prepare('SELECT workspaceId, value FROM composerHeaders WHERE composerId = ?').get(ROOT);
  assert.equal(row.workspaceId, WS_B);
  assert.equal(JSON.parse(row.value).workspaceIdentifier.id, WS_B);
  const count = db.prepare('SELECT COUNT(*) AS c FROM composerHeaders WHERE composerId = ?').get(ROOT);
  assert.equal(count.c, 1);
  db.close();

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('refuses to write while Cursor is running unless forced', () => {
  const fixture = createFixture();
  const stores = require('../src/history/cursor-store').listStores(fixture.env);
  const target = stores.find((store) => store.workspaceId === WS_B);

  const original = process.platform;
  if (original !== 'win32') {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  // Only assert when Cursor is actually running on this machine.
  if (!require('../src/history/import').isCursorRunning()) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  assert.throws(() => importConversations({
    ids: [ROOT], target, env: fixture.env, stores,
  }), /Cursor is running/);

  fs.rmSync(fixture.root, { recursive: true, force: true });
});
