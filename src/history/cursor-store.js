'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function cursorUserDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User');
}

function cursorProjectsDir(env = process.env) {
  return path.join(env.USERPROFILE || os.homedir(), '.cursor', 'projects');
}

function openReadonly(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (_) {
    db = new DatabaseSync(file);
    db.exec('PRAGMA query_only = ON');
  }
  try { db.exec('PRAGMA busy_timeout = 2000'); } catch (_) { /* best effort */ }
  return db;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function listStores(env = process.env) {
  const userDir = cursorUserDir(env);
  const out = [];
  const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  if (fs.existsSync(globalDb)) out.push({ scope: 'global', workspaceId: '', dbPath: globalDb });

  const workspaceRoot = path.join(userDir, 'workspaceStorage');
  if (fs.existsSync(workspaceRoot)) {
    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dbPath = path.join(workspaceRoot, entry.name, 'state.vscdb');
      if (!fs.existsSync(dbPath)) continue;
      let workspace = '';
      try {
        workspace = JSON.parse(fs.readFileSync(path.join(workspaceRoot, entry.name, 'workspace.json'), 'utf8')).folder || '';
      } catch (_) { /* workspace.json optional */ }
      out.push({ scope: 'workspace', workspaceId: entry.name, workspace, dbPath });
    }
  }
  return out;
}

function parseHead(value) {
  const head = parseJson(value, {});
  return {
    title: head.name || head.title || '',
    createdAt: head.createdAt || 0,
    updatedAt: head.lastUpdatedAt || 0,
    status: head.status || '',
  };
}

function listConversations(db, options = {}) {
  const includeSubagents = options.includeSubagents === true;
  const rows = db.prepare(`
    SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, subagentTypeName, value
    FROM composerHeaders
    ${includeSubagents ? '' : 'WHERE isSubagent = 0'}
    ORDER BY lastUpdatedAt DESC
  `).all();

  return rows.map((row) => {
    const head = parseHead(row.value);
    return {
      id: row.composerId,
      workspaceId: row.workspaceId || '',
      title: head.title || row.composerId,
      createdAt: head.createdAt || row.createdAt || 0,
      updatedAt: head.updatedAt || row.lastUpdatedAt || 0,
      status: head.status,
      isSubagent: !!row.isSubagent,
      subagentType: row.subagentTypeName || '',
    };
  });
}

function readKey(db, key) {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function parseNestedText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = parseJson(trimmed, undefined);
      if (parsed !== undefined) return parseNestedText(parsed);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => parseNestedText(item)).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return parseNestedText(value.content);
    if (value.result !== undefined) return parseNestedText(value.result);
    if (value.output !== undefined) return parseNestedText(value.output);
    if (value.message !== undefined) return parseNestedText(value.message);
    try { return JSON.stringify(value); } catch (_) { return ''; }
  }
  return value === undefined || value === null ? '' : String(value);
}

function parseToolFormerData(data) {
  if (!data || typeof data !== 'object') return null;
  const name = data.name || '';
  const args = parseJson(data.rawArgs, data.rawArgs || {});
  const output = parseNestedText(data.result);
  return {
    call: {
      id: data.toolCallId || data.modelCallId || '',
      name,
      input: args,
      status: data.status || '',
    },
    result: {
      toolCallId: data.toolCallId || data.modelCallId || '',
      name,
      output,
      status: data.status || '',
    },
  };
}

function bubbleToMessage(bubble, key) {
  if (!bubble || typeof bubble !== 'object') return null;
  const tool = parseToolFormerData(bubble.toolFormerData);
  const text = bubble.text || bubble.richText || '';
  if (!text && !tool) return null;

  return {
    id: bubble.bubbleId || key || '',
    role: bubble.type === 1 ? 'user' : 'assistant',
    content: text,
    thinking: Array.isArray(bubble.allThinkingBlocks)
      ? bubble.allThinkingBlocks.map((b) => b && (b.text || b.content)).filter(Boolean).join('\n')
      : '',
    toolCalls: tool ? [tool.call] : [],
    toolResults: tool ? [tool.result] : [],
    model: bubble.modelInfo && bubble.modelInfo.modelName ? bubble.modelInfo.modelName : '',
    createdAt: bubble.createdAt || '',
  };
}

function loadBubbles(db, composerId) {
  const rows = db.prepare(
    'SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key'
  ).all(`bubbleId:${composerId}:%`);

  const byId = new Map();
  for (const row of rows) {
    const bubble = parseJson(row.value, null);
    if (!bubble) continue;
    const id = bubble.bubbleId || String(row.key).slice(`bubbleId:${composerId}:`.length);
    byId.set(id, { key: row.key, bubble });
  }
  return byId;
}

function orderedBubbleIds(db, composerId) {
  const rows = db.prepare(
    'SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key'
  ).all(`composerConvHeaders:${composerId}:%`);

  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const list = parseJson(row.value, []);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = item && item.bubbleId;
      if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function loadConversationFromDb(db, composerId, options = {}) {
  const row = db.prepare('SELECT * FROM composerHeaders WHERE composerId = ?').get(composerId);
  if (!row) return null;

  const head = parseHead(row.value);
  const data = parseJson(readKey(db, `composerData:${composerId}`), {});
  const bubbles = loadBubbles(db, composerId);
  const ids = orderedBubbleIds(db, composerId);

  const ordered = ids.length
    ? ids.map((id) => bubbles.get(id)).filter(Boolean)
    : [...bubbles.values()].sort((a, b) => {
        const at = Date.parse(a.bubble.createdAt || 0) || 0;
        const bt = Date.parse(b.bubble.createdAt || 0) || 0;
        return at - bt;
      });

  const messages = ordered
    .map(({ key, bubble }) => bubbleToMessage(bubble, key))
    .filter(Boolean);

  return {
    id: composerId,
    workspaceId: row.workspaceId || '',
    title: head.title || composerId,
    createdAt: head.createdAt || row.createdAt || 0,
    updatedAt: head.updatedAt || row.lastUpdatedAt || 0,
    status: head.status || data.status || '',
    source: 'bubbles',
    messages,
  };
}

function findTranscriptFile(composerId, env = process.env) {
  const root = cursorProjectsDir(env);
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name, 'agent-transcripts', composerId);
    if (!fs.existsSync(dir)) continue;
    const exact = path.join(dir, `${composerId}.jsonl`);
    if (fs.existsSync(exact)) return exact;
    const first = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
    if (first) return path.join(dir, first);
  }
  return null;
}

function loadTranscript(composerId, env = process.env) {
  const file = findTranscriptFile(composerId, env);
  if (!file) return null;
  const messages = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const item = parseJson(line, null);
    if (!item || !item.role || !item.message) continue;
    const content = item.message.content;
    if (Array.isArray(content)) {
      const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).filter(Boolean).join('\n');
      const toolCalls = content.filter((c) => c && c.type === 'tool_use').map((c) => ({
        id: c.id || '',
        name: c.name || '',
        input: c.input || {},
        status: 'completed',
      }));
      if (text || toolCalls.length) {
        messages.push({
          id: '',
          role: item.role,
          content: text,
          thinking: '',
          toolCalls,
          toolResults: [],
          model: '',
          createdAt: item.createdAt || '',
        });
      }
    } else if (typeof content === 'string' && content.trim()) {
      messages.push({
        id: '',
        role: item.role,
        content,
        thinking: '',
        toolCalls: [],
        toolResults: [],
        model: '',
        createdAt: item.createdAt || '',
      });
    }
  }
  return {
    id: composerId,
    workspaceId: '',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    status: '',
    source: 'transcript',
    messages,
  };
}

function loadConversation(composerId, options = {}) {
  const env = options.env || process.env;
  const stores = options.stores || listStores(env);
  for (const store of stores) {
    let db;
    try {
      db = openReadonly(store.dbPath);
      const found = loadConversationFromDb(db, composerId, options);
      if (found && found.messages.length) {
        found.workspace = store.workspace || '';
        return found;
      }
    } catch (_) {
      // try the next store
    } finally {
      if (db) { try { db.close(); } catch (_) { /* ignore */ } }
    }
  }
  return loadTranscript(composerId, env);
}

function listAllConversations(options = {}) {
  const env = options.env || process.env;
  const seen = new Set();
  const out = [];
  for (const store of listStores(env)) {
    let db;
    try {
      db = openReadonly(store.dbPath);
      for (const conversation of listConversations(db, options)) {
        if (seen.has(conversation.id)) continue;
        seen.add(conversation.id);
        out.push({ ...conversation, workspace: store.workspace || '' });
      }
    } catch (_) {
      // skip unreadable store
    } finally {
      if (db) { try { db.close(); } catch (_) { /* ignore */ } }
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

module.exports = {
  cursorUserDir,
  cursorProjectsDir,
  listStores,
  openReadonly,
  listConversations,
  loadConversationFromDb,
  loadConversation,
  listAllConversations,
  findTranscriptFile,
  loadTranscript,
  parseNestedText,
};
