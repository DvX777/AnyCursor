'use strict';

/*
 * Per-model usage observed by the gateway.
 *
 * Requests are exact. Token counts use provider usage when an adapter reports
 * it and a character-based estimate otherwise (~4 characters per token), so
 * the dashboard can show relative usage without claiming billing accuracy.
 */

const models = new Map();
const since = new Date().toISOString();

function record(modelId, tokens = {}) {
  if (!modelId) return;
  const entry = models.get(modelId) || { requests: 0, tokensIn: 0, tokensOut: 0, lastAt: null };
  entry.requests += 1;
  entry.tokensIn += Math.max(0, Math.round(Number(tokens.tokensIn) || 0));
  entry.tokensOut += Math.max(0, Math.round(Number(tokens.tokensOut) || 0));
  entry.lastAt = new Date().toISOString();
  models.set(modelId, entry);
}

function textSize(messages) {
  let chars = 0;
  for (const message of messages || []) {
    const content = message && message.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) if (part && typeof part.text === 'string') chars += part.text.length;
    }
    if (message && Array.isArray(message.tool_calls)) {
      chars += JSON.stringify(message.tool_calls).length;
    }
  }
  return Math.ceil(chars / 4);
}

function snapshot() {
  const items = [...models.entries()].map(([id, value]) => ({ id, ...value }));
  const total = items.reduce((acc, item) => ({
    requests: acc.requests + item.requests,
    tokensIn: acc.tokensIn + item.tokensIn,
    tokensOut: acc.tokensOut + item.tokensOut,
  }), { requests: 0, tokensIn: 0, tokensOut: 0 });
  items.sort((a, b) => b.requests - a.requests || b.tokensOut - a.tokensOut);
  return { since, total, models: items };
}

function reset() {
  models.clear();
}

module.exports = { record, textSize, snapshot, reset };
