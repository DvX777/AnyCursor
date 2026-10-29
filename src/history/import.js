'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const { listStores, openReadonly, listConversations, parseHead } = require('./cursor-store');

function openWritable(file) {
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout = 3000'); } catch (_) { /* best effort */ }
  return db;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function isCursorRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return /cursor\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

function globalStore(stores) {
  return stores.find((store) => store.scope === 'global') || null;
}

function normalizeFolder(uriOrPath) {
  if (!uriOrPath) return '';
  let value = String(uriOrPath);
  if (value.startsWith('file://')) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch (_) { /* keep */ }
  }
  return path.resolve(value.replace(/^\/([a-zA-Z]:)/, '$1')).toLowerCase();
}

function workspaceIdentifierFor(store) {
  const folder = store.workspace && store.workspace.startsWith('file://')
    ? decodeURIComponent(new URL(store.workspace).pathname).replace(/^\/([a-zA-Z]:)/, '$1')
    : store.workspace;
  if (!folder) return null;
  const external = store.workspace;
  return {
    id: store.workspaceId,
    uri: {
      $mid: 1,
      fsPath: folder,
      _sep: 1,
      external,
      path: `/${folder.replace(/\\/g, '/')}`,
      scheme: 'file',
    },
  };
}

function targetIdentifierFromDb(db, targetStore) {
  try {
    const row = db.prepare(
      'SELECT value FROM composerHeaders WHERE workspaceId = ? AND value LIKE ? LIMIT 1'
    ).get(targetStore.workspaceId, '%workspaceIdentifier%');
    const head = parseJson(row && row.value, null);
    if (head && head.workspaceIdentifier && head.workspaceIdentifier.id) return head.workspaceIdentifier;
  } catch (_) { /* fall through */ }
  return workspaceIdentifierFor(targetStore);
}

function listWorkspaces(options = {}) {
  const stores = options.stores || listStores(options.env);
  const global = globalStore(stores);
  const counts = new Map();
  let db;
  try {
    if (!global) return [];
    db = openReadonly(global.dbPath);
    const rows = db.prepare(`
      SELECT workspaceId, COUNT(*) AS total,
        SUM(CASE WHEN length(value) > 700 THEN 1 ELSE 0 END) AS marked
      FROM composerHeaders GROUP BY workspaceId
    `).all();
    for (const row of rows) counts.set(row.workspaceId || '', { total: row.total, marked: row.marked });
  } finally {
    if (db) { try { db.close(); } catch (_) { /* ignore */ } }
  }
  return stores
    .filter((store) => store.scope === 'workspace')
    .map((store) => {
      const count = counts.get(store.workspaceId) || { total: 0, marked: 0 };
      return {
        id: store.workspaceId,
        folder: store.workspace || '',
        conversations: count.total,
      };
    });
}

function resolveWorkspace(selector, options = {}) {
  const stores = (options.stores || listStores(options.env)).filter((store) => store.scope === 'workspace');
  if (!selector) {
    const cwd = normalizeFolder(options.cwd || process.cwd());
    return stores.find((store) => normalizeFolder(store.workspace) === cwd) || null;
  }
  const exact = stores.find((store) => store.workspaceId === selector);
  if (exact) return exact;
  const raw = selector.replace(/^file:\/\//, '');
  const needle = normalizeFolder(raw);
  const simple = path.basename(needle);
  const matches = stores.filter((store) => {
    const folder = normalizeFolder(store.workspace);
    return folder === needle || path.basename(folder) === simple || folder.includes(needle) || folder.includes(simple);
  });
  if (matches.length > 1) {
    throw new Error(`workspace "${selector}" matches ${matches.length} workspaces; use the workspace id`);
  }
  return matches[0] || null;
}

function relatedIds(db, rootId) {
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`);
    const data = parseJson(row && row.value, null);
    if (!data) continue;
    for (const field of ['subComposerIds', 'subagentComposerIds']) {
      for (const child of data[field] || []) {
        if (child && !seen.has(child)) queue.push(child);
      }
    }
  }
  return seen;
}

function replaceIds(text, mapping) {
  let out = String(text);
  for (const [from, to] of mapping) {
    if (from !== to) out = out.split(from).join(to);
  }
  return out;
}

function applyWorkspace(value, identifier) {
  if (!identifier) return value;
  const parsed = parseJson(value, null);
  if (!parsed || typeof parsed !== 'object') return value;
  parsed.workspaceIdentifier = identifier;
  return JSON.stringify(parsed);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function insertHeader(db, row, id, workspaceId, value) {
  const columns = tableColumns(db, 'composerHeaders');
  const source = {
    composerId: id,
    workspaceId,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    isArchived: row.isArchived,
    isSubagent: row.isSubagent,
    recency: row.recency,
    checkpointAt: row.checkpointAt,
    subagentTypeName: row.subagentTypeName,
    value,
  };
  const present = columns.filter((column) => source[column] !== undefined);
  const sql = `INSERT OR REPLACE INTO composerHeaders (${present.join(', ')}) VALUES (${present.map((c) => '@' + c).join(', ')})`;
  const params = {};
  for (const column of present) params[column] = source[column];
  db.prepare(sql).run(params);
}

function backupDatabase(file) {
  const backup = `${file}.anycursor-history-${Date.now()}.bak`;
  fs.copyFileSync(file, backup);
  return backup;
}

/**
 * Copy or move conversations between Cursor workspaces.
 *
 * Copy mode creates new composer ids and duplicates every related
 * cursorDiskKV row, so the original conversation stays intact.
 * Move mode only changes workspace metadata on the existing rows.
 */
function importConversations(options) {
  const {
    ids = [],
    target,
    move = false,
    force = false,
    dryRun = false,
    env = process.env,
  } = options;

  if (!target) throw new Error('target workspace is required');
  if (!ids.length) throw new Error('at least one conversation id is required');
  if (!dryRun && isCursorRunning() && !force) {
    throw new Error('Cursor is running; quit Cursor first or pass --force');
  }

  const stores = options.stores || listStores(env);
  const global = globalStore(stores);
  if (!global) throw new Error('Cursor global state database not found');

  const targetStore = typeof target === 'string'
    ? resolveWorkspace(target, { stores, env })
    : target;
  if (!targetStore) throw new Error(`workspace not found: ${target}`);

  let db;
  let backup = '';
  try {
    db = openReadonly(global.dbPath);
    const identifier = targetIdentifierFromDb(db, targetStore);
    const plan = [];
    const allIds = new Set();
    const headers = new Map();
    for (const rootId of ids) {
      const header = db.prepare('SELECT * FROM composerHeaders WHERE composerId = ?').get(rootId);
      if (!header) throw new Error(`conversation not found: ${rootId}`);
      for (const id of relatedIds(db, rootId)) allIds.add(id);
      plan.push({ rootId, header });
    }
    for (const id of allIds) {
      const header = db.prepare('SELECT * FROM composerHeaders WHERE composerId = ?').get(id);
      if (header) headers.set(id, header);
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        mode: move ? 'move' : 'copy',
        target: { id: targetStore.workspaceId, folder: targetStore.workspace },
        conversations: plan.length,
        related: allIds.size,
        backup: '',
      };
    }

    db.close();
    db = null;
    backup = backupDatabase(global.dbPath);
    db = openWritable(global.dbPath);

    const mapping = new Map();
    for (const id of allIds) mapping.set(id, move ? id : crypto.randomUUID());

    const kvRows = [];
    const seenKeys = new Set();
    for (const id of allIds) {
      const rows = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ?').all(`%${id}%`);
      for (const row of rows) {
        if (seenKeys.has(row.key)) continue;
        seenKeys.add(row.key);
        kvRows.push(row);
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of kvRows) {
        const key = replaceIds(row.key, mapping);
        let value = replaceIds(row.value, mapping);
        if (/^composerData:/.test(key)) value = applyWorkspace(value, identifier);
        db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value);
      }

      for (const [oldId, newId] of mapping) {
        const header = headers.get(oldId);
        if (!header) continue;
        let value = replaceIds(header.value, mapping);
        value = applyWorkspace(value, identifier);
        insertHeader(db, header, newId, targetStore.workspaceId, value);
      }

      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw error;
    }

    return {
      ok: true,
      mode: move ? 'move' : 'copy',
      target: { id: targetStore.workspaceId, folder: targetStore.workspace },
      conversations: plan.length,
      related: allIds.size,
      keys: kvRows.length,
      backup,
      ids: plan.map((item) => ({ from: item.rootId, to: mapping.get(item.rootId) })),
    };
  } finally {
    if (db) { try { db.close(); } catch (_) { /* ignore */ } }
  }
}

function listHistory(options = {}) {
  const stores = options.stores || listStores(options.env);
  const global = globalStore(stores);
  if (!global) return [];
  const workspace = options.workspace
    ? resolveWorkspace(options.workspace, { stores, env: options.env })
    : null;
  let db;
  try {
    db = openReadonly(global.dbPath);
    let rows = listConversations(db, { includeSubagents: options.includeSubagents === true });
    if (workspace) rows = rows.filter((row) => row.workspaceId === workspace.workspaceId);
    if (!options.includeEmpty) {
      rows = rows.filter((row) => {
        const data = parseJson(
          (db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${row.id}`) || {}).value,
          {},
        );
        return (data.fullConversationHeadersOnly || []).length > 0 || row.title !== row.id;
      });
    }
    return rows.map((row) => {
      const store = stores.find((candidate) => candidate.workspaceId === row.workspaceId);
      return { ...row, workspace: store ? store.workspace : '' };
    });
  } finally {
    if (db) { try { db.close(); } catch (_) { /* ignore */ } }
  }
}

module.exports = {
  isCursorRunning,
  listWorkspaces,
  resolveWorkspace,
  relatedIds,
  importConversations,
  listHistory,
  normalizeFolder,
  workspaceIdentifierFor,
  backupDatabase,
};
