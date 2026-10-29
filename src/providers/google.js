'use strict';

/**
 * Google Gemini generateContent adapter.
 * Canonical input is OpenAI-style messages/tools; output matches the gateway
 * provider contract: { text, toolCalls, usage, stopReason }.
 */

function joinUrl(baseUrl, endpoint, fallback) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const path = endpoint || fallback;
  if (!base) return path;
  if (/^https?:\/\//.test(path)) return path;
  if (base.endsWith(path)) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}

function geminiEndpoint(opts) {
  const model = encodeURIComponent(opts.modelId);
  const fallback = `/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  if (!opts.endpoint) return joinUrl(opts.baseUrl, fallback, fallback);
  const endpoint = String(opts.endpoint)
    .replace(/\{model\}/g, model)
    .replace(/\/+$/, '');
  return joinUrl(opts.baseUrl, endpoint, fallback);
}

function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'additionalProperties' || key === 'default') continue;
    if (value === null || value === undefined) continue;
    out[key] = cleanSchema(value);
  }
  return out;
}

function textParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return { text: part };
      if (part && part.type === 'text') return { text: String(part.text || '') };
      if (part && part.type === 'image_url') {
        const url = String(part.image_url && part.image_url.url || '');
        const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
        if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
        if (url) return { fileData: { mimeType: 'image/*', fileUri: url } };
      }
      if (part && part.text) return { text: String(part.text) };
      return null;
    }).filter(Boolean);
  }
  return content ? [{ text: String(content) }] : [];
}

function toGoogleContents(messages) {
  const system = [];
  const out = [];
  const toolNames = new Map();

  const push = (role, parts) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : textParts(message.content).map((p) => p.text).join('\n');
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id || message.toolCallId || '';
      const name = toolNames.get(id) || message.name || 'tool';
      let response = message.content;
      if (typeof response === 'string') {
        try { response = JSON.parse(response); } catch (_) { response = { result: response }; }
      }
      if (!response || typeof response !== 'object') response = { result: String(response || '') };
      push('user', [{ functionResponse: { name, response } }]);
      continue;
    }
    if (message.role === 'assistant') {
      const parts = textParts(message.content);
      for (const call of message.tool_calls || []) {
        const fn = call.function || {};
        let args = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch (_) { args = {}; }
        parts.push({ functionCall: { name: fn.name || 'tool', args } });
        if (call.id) toolNames.set(call.id, fn.name || 'tool');
      }
      push('model', parts);
      continue;
    }
    push('user', textParts(message.content));
  }
  return { system: system.join('\n\n'), contents: out };
}

function toGoogleTools(tools) {
  const declarations = (tools || []).map((tool) => {
    const fn = tool.function || tool;
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: cleanSchema(fn.parameters || { type: 'object', properties: {} }),
    };
  });
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function thinkingBudget(effort) {
  const id = String((effort && (effort.id || effort.value)) || effort || '').toLowerCase();
  if (id === 'low') return 1024;
  if (id === 'medium') return 4096;
  if (id === 'high') return 8192;
  if (id === 'extra-high' || id === 'extra_high' || id === 'xhigh') return 12000;
  if (id === 'max') return 16000;
  return 0;
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let thinking = '';
  let stopReason = '';
  let usage = null;
  const calls = [];
  let callIndex = 0;

  const process = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch (_) { return; }
    if (json.error) throw new Error(json.error.message || 'Gemini stream error');
    if (json.promptFeedback && json.promptFeedback.blockReason) {
      stopReason = json.promptFeedback.blockReason;
      return;
    }
    if (json.usageMetadata) usage = json.usageMetadata;
    const candidate = json.candidates && json.candidates[0];
    if (!candidate) return;
    if (candidate.finishReason) stopReason = candidate.finishReason;
    const parts = (candidate.content && candidate.content.parts) || [];
    for (const part of parts) {
      if (part.text) {
        if (part.thought) {
          thinking += part.text;
          onEvent({ kind: 'thinking', text: part.text });
        } else {
          text += part.text;
          onEvent({ kind: 'text', text: part.text });
        }
      }
      if (part.functionCall) {
        const call = {
          id: `call_${++callIndex}`,
          name: part.functionCall.name || 'tool',
          args: JSON.stringify(part.functionCall.args || {}),
        };
        calls.push(call);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) process(line.slice(5).trim());
    }
  }
  return { text, thinking, usage, stopReason, toolCalls: calls };
}

async function streamChat(opts, onEvent, signal) {
  const url = geminiEndpoint(opts);
  const headers = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...(opts.headers || {}),
  };
  if (opts.apiKey && !headers['x-goog-api-key'] && !headers['x-api-key']) {
    headers['x-goog-api-key'] = opts.apiKey;
  }

  const { system, contents } = toGoogleContents(opts.messages);
  const tools = toGoogleTools(opts.tools);
  const budget = opts.reasoning ? thinkingBudget(opts.effort) : 0;
  const generationConfig = {};
  if (opts.maxOutput) generationConfig.maxOutputTokens = Number(opts.maxOutput);
  if (budget > 0) generationConfig.thinkingConfig = { thinkingBudget: budget };

  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) body.tools = tools;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`google ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error('google returned no body');
  return readSse(res, onEvent);
}

module.exports = {
  streamChat,
  toGoogleContents,
  toGoogleTools,
  thinkingBudget,
  geminiEndpoint,
};
