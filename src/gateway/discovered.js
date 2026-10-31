'use strict';

/*
 * Model ids seen in Cursor that AnyCursor does not know about.
 *
 * With the local backend flag, every inference request reaches the gateway,
 * including models configured elsewhere. Recording the unknown ids lets the
 * dashboard offer to adopt them instead of guessing or writing config silently.
 */

const seen = new Map();

function record(modelId, parameters) {
  const id = String(modelId || '').trim();
  if (!id) return;
  const entry = seen.get(id) || { id, requests: 0, firstAt: null, lastAt: null, parameters: {} };
  entry.requests += 1;
  entry.lastAt = new Date().toISOString();
  if (!entry.firstAt) entry.firstAt = entry.lastAt;
  if (parameters && typeof parameters === 'object') {
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null && value !== '') entry.parameters[key] = value;
    }
  }
  seen.set(id, entry);
}

function snapshot() {
  return [...seen.values()]
    .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
    .map((entry) => ({ ...entry }));
}

function forget(id) {
  seen.delete(String(id || ''));
}

function reset() {
  seen.clear();
}

module.exports = { record, snapshot, forget, reset };
