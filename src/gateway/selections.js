'use strict';

/*
 * The last model variant selected in Cursor's picker, per model.
 *
 * Cursor sends the chosen effort / context / fast values as request
 * parameters. Keeping the latest value lets the dashboard show what the IDE
 * is actually using, instead of only the defaults from config.json.
 */

const selections = new Map();

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/**
 * Record the variant used by one inference request.
 * @param {{cursorId?: string, id?: string}} model
 * @param {{effort?: unknown, context?: unknown, fast?: unknown}} params
 */
function record(model, params) {
  if (!model || !params) return;
  const id = model.cursorId || model.id;
  if (!id) return;
  const next = {
    effort: clean(params.effort),
    context: clean(params.context),
    fast: params.fast === true || String(params.fast) === 'true',
    at: new Date().toISOString(),
  };
  const prev = selections.get(id);
  if (prev && prev.effort === next.effort && prev.context === next.context && prev.fast === next.fast) {
    prev.at = next.at;
    return;
  }
  selections.set(id, next);
}

function snapshot() {
  const out = {};
  for (const [id, value] of selections) out[id] = { ...value };
  return out;
}

function forModel(model) {
  if (!model) return undefined;
  return selections.get(model.cursorId || model.id);
}

function reset() {
  selections.clear();
}

module.exports = { record, snapshot, forModel, reset };
