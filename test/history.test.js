'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  listConversations,
  loadConversationFromDb,
  loadTranscript,
  loadConversation,
  parseNestedText,
} = require('../src/history/cursor-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-history-'));
}

function makeDb() {
  const dir = tempDir();
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      recency INTEGER,
      checkpointAt INTEGER,
      subagentTypeName TEXT,
      value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  return { dir, file, db };
}

function insert(db, key, value) {
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value);
}

test('lists and loads a conversation from Cursor bubble stores', () => {
  const { db } = makeDb();
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, ?)').run(
    'conv1', 'ws1', 100, 200,
    JSON.stringify({ type: 'head', name: 'Repo inspection', createdAt: 100, lastUpdatedAt: 200, status: 'completed' }),
  );
  insert(db, 'composerData:conv1', JSON.stringify({ _v: 18, composerId: 'conv1', status: 'completed' }));
  insert(db, 'composerConvHeaders:conv1:000000', JSON.stringify([
    { bubbleId: 'b1' },
    { bubbleId: 'b2' },
  ]));
  insert(db, 'bubbleId:conv1:b1', JSON.stringify({
    _v: 3, type: 1, bubbleId: 'b1', text: 'hello', createdAt: '2026-01-01T00:00:00Z',
  }));
  insert(db, 'bubbleId:conv1:b2', JSON.stringify({
    _v: 3,
    type: 2,
    bubbleId: 'b2',
    text: 'checking',
    createdAt: '2026-01-01T00:00:01Z',
    toolFormerData: {
      toolCallId: 'call1',
      name: 'Read',
      rawArgs: JSON.stringify({ path: 'x.js' }),
      status: 'completed',
      result: JSON.stringify({ content: 'file text' }),
    },
  }));

  const list = listConversations(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Repo inspection');
  assert.equal(list[0].isSubagent, false);

  const conversation = loadConversationFromDb(db, 'conv1');
  assert.equal(conversation.source, 'bubbles');
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages[0].role, 'user');
  assert.equal(conversation.messages[0].content, 'hello');
  assert.equal(conversation.messages[1].role, 'assistant');
  assert.equal(conversation.messages[1].toolCalls[0].name, 'Read');
  assert.deepEqual(conversation.messages[1].toolCalls[0].input, { path: 'x.js' });
  assert.equal(conversation.messages[1].toolResults[0].output, 'file text');
  db.close();
});

test('falls back to agent transcript JSONL', () => {
  const home = tempDir();
  const conv = 'conv2';
  const dir = path.join(home, '.cursor', 'projects', 'proj', 'agent-transcripts', conv);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${conv}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'find auth' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'call2', name: 'Grep', input: { pattern: 'auth' } },
    ] } }),
  ].join('\n'));

  const env = { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
  const transcript = loadTranscript(conv, env);
  assert.equal(transcript.source, 'transcript');
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[1].toolCalls[0].name, 'Grep');

  const fallback = loadConversation(conv, { env, stores: [] });
  assert.equal(fallback.source, 'transcript');
  assert.equal(fallback.messages.length, 2);
});

test('extracts nested result text', () => {
  assert.equal(parseNestedText(JSON.stringify({ result: JSON.stringify({ content: [{ text: 'ok' }] }) })), 'ok');
  assert.equal(parseNestedText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
});
