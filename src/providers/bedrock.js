'use strict';

/**
 * AWS Bedrock Converse / ConverseStream adapter.
 *
 * Signs requests with SigV4 directly and parses the AWS event-stream binary
 * protocol for streaming responses, so AnyCursor does not need the AWS SDK.
 */

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full: iso, short: iso.slice(0, 8) };
}

function signRequest({ method, url, headers, body, region, accessKeyId, secretAccessKey, sessionToken, now }) {
  const parsed = new URL(url);
  const { full, short } = amzDate(now);
  const lower = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    lower[String(key).toLowerCase()] = String(value);
  }
  lower.host = parsed.host;
  lower['x-amz-date'] = full;
  if (sessionToken) lower['x-amz-security-token'] = sessionToken;

  const sortedKeys = Object.keys(lower).sort();
  const canonicalHeaders = sortedKeys.map((key) => `${key}:${lower[key].trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const payloadHash = sha256(body || '');
  const canonicalRequest = [
    method,
    parsed.pathname || '/',
    parsed.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${short}/${region}/bedrock/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    full,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, short);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'bedrock');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function textContent(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return { text: part };
      if (part && part.text) return { text: String(part.text) };
      return null;
    }).filter(Boolean);
  }
  return content ? [{ text: String(content) }] : [];
}

function toConverse(messages) {
  const system = [];
  const out = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : textContent(message.content).map((p) => p.text).join('\n');
      if (text) system.push({ text });
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          toolResult: {
            toolUseId: message.tool_call_id || message.toolCallId || '',
            content: [{ text: String(message.content || '') }],
          },
        }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const content = textContent(message.content);
      for (const call of message.tool_calls || []) {
        const fn = call.function || {};
        let input = {};
        try { input = JSON.parse(fn.arguments || '{}'); } catch (_) { input = {}; }
        content.push({
          toolUse: {
            toolUseId: call.id || `tool_${out.length}`,
            name: fn.name || 'tool',
            input,
          },
        });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    const content = textContent(message.content);
    if (content.length) out.push({ role: 'user', content });
  }
  return { system, messages: out };
}

function toTools(tools) {
  const specs = (tools || []).map((tool) => {
    const fn = tool.function || tool;
    return {
      toolSpec: {
        name: fn.name,
        description: fn.description || '',
        inputSchema: { json: fn.parameters || { type: 'object', properties: {} } },
      },
    };
  });
  return specs.length ? { tools: specs } : undefined;
}

function readHeaderValue(buf, offset, type) {
  if (type === 0) return [true, offset];
  if (type === 1) return [false, offset];
  if (type === 2) return [buf.readInt8(offset), offset + 1];
  if (type === 3) return [buf.readInt16BE(offset), offset + 2];
  if (type === 4) return [buf.readInt32BE(offset), offset + 4];
  if (type === 5) {
    const value = Number(buf.readBigInt64BE(offset));
    return [value, offset + 8];
  }
  if (type === 6 || type === 7) {
    const length = buf.readUInt16BE(offset);
    const start = offset + 2;
    const raw = buf.subarray(start, start + length);
    return [type === 7 ? raw.toString('utf8') : raw, start + length];
  }
  if (type === 8) {
    const value = Number(buf.readBigInt64BE(offset));
    return [value, offset + 8];
  }
  if (type === 9) {
    const raw = buf.subarray(offset, offset + 16).toString('hex');
    return [raw, offset + 16];
  }
  return [undefined, offset];
}

/** Parse one or more AWS event-stream messages; returns parsed events + leftover bytes. */
function parseEventStream(buf) {
  const events = [];
  let offset = 0;
  while (buf.length - offset >= 16) {
    const total = buf.readUInt32BE(offset);
    const headersLength = buf.readUInt32BE(offset + 4);
    if (total < 16 || offset + total > buf.length) break;
    const headersEnd = offset + 12 + headersLength;
    if (headersEnd > offset + total - 4) break;
    let p = offset + 12;
    const headers = {};
    while (p < headersEnd) {
      const nameLength = buf[p++];
      const name = buf.subarray(p, p + nameLength).toString('utf8');
      p += nameLength;
      const type = buf[p++];
      const [value, next] = readHeaderValue(buf, p, type);
      p = next;
      headers[name] = value;
    }
    const payload = buf.subarray(headersEnd, offset + total - 4);
    events.push({ headers, payload });
    offset += total;
  }
  return { events, rest: buf.subarray(offset) };
}

function parseConverseOutput(json, onEvent) {
  const content = (json.output && json.output.message && json.output.message.content) || [];
  let text = '';
  let thinking = '';
  const toolCalls = [];
  for (const block of content) {
    if (block.text) {
      text += block.text;
      onEvent({ kind: 'text', text: block.text });
    }
    if (block.reasoningContent && block.reasoningContent.reasoningText) {
      const piece = block.reasoningContent.reasoningText.text || '';
      if (piece) {
        thinking += piece;
        onEvent({ kind: 'thinking', text: piece });
      }
    }
    if (block.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId || `tool_${toolCalls.length}`,
        name: block.toolUse.name || 'tool',
        args: JSON.stringify(block.toolUse.input || {}),
      });
    }
  }
  return { text, thinking, usage: json.usage || null, stopReason: json.stopReason || '', toolCalls };
}

function processConverseStreamEvent(event, state, onEvent) {
  const type = event.headers[':event-type'] || event.headers['event-type'];
  if (!type) return;
  let body;
  try { body = JSON.parse(event.payload.toString('utf8') || '{}'); } catch (_) { return; }

  if (type === 'contentBlockStart') {
    const index = body.contentBlockIndex || 0;
    const tool = body.start && body.start.toolUse;
    if (tool) {
      state.blocks[index] = {
        toolUseId: tool.toolUseId || '',
        name: tool.name || '',
        input: '',
      };
    }
    return;
  }
  if (type === 'contentBlockDelta') {
    const index = body.contentBlockIndex || 0;
    const delta = body.delta || {};
    if (delta.text) {
      state.text += delta.text;
      onEvent({ kind: 'text', text: delta.text });
    }
    if (delta.reasoningContent) {
      const piece = (delta.reasoningContent.reasoningText && delta.reasoningContent.reasoningText.text)
        || delta.reasoningContent.text
        || '';
      if (piece) {
        state.thinking += piece;
        onEvent({ kind: 'thinking', text: piece });
      }
    }
    if (delta.toolUse) {
      const block = state.blocks[index] || (state.blocks[index] = { toolUseId: '', name: '', input: '' });
      if (delta.toolUse.toolUseId) block.toolUseId = delta.toolUse.toolUseId;
      if (delta.toolUse.name) block.name = delta.toolUse.name;
      if (delta.toolUse.input) block.input += delta.toolUse.input;
    }
    return;
  }
  if (type === 'contentBlockStop') {
    const index = body.contentBlockIndex || 0;
    const block = state.blocks[index];
    if (block && block.name) {
      state.toolCalls.push({
        id: block.toolUseId || `tool_${state.toolCalls.length}`,
        name: block.name,
        args: block.input || '{}',
      });
    }
    delete state.blocks[index];
    return;
  }
  if (type === 'messageStop') {
    state.stopReason = body.stopReason || '';
    return;
  }
  if (type === 'metadata') {
    state.usage = body.usage || null;
  }
}

async function streamChat(opts, onEvent, signal) {
  const region = opts.region || 'us-east-1';
  const modelId = opts.modelId;
  const endpoint = opts.endpoint
    ? String(opts.endpoint)
      .replace(/\{model\}/g, encodeURIComponent(modelId))
      .replace(/\/converse$/, '/converse-stream')
    : `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse-stream`;
  const converted = toConverse(opts.messages);
  const body = {
    messages: converted.messages,
    inferenceConfig: { maxTokens: Number(opts.maxOutput) || 4096 },
  };
  if (converted.system.length) body.system = converted.system;
  const toolConfig = toTools(opts.tools);
  if (toolConfig) body.toolConfig = toolConfig;

  const payload = JSON.stringify(body);
  const headers = signRequest({
    method: 'POST',
    url: endpoint,
    headers: {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
    },
    body: payload,
    region,
    accessKeyId: opts.accessKeyId || '',
    secretAccessKey: opts.secretAccessKey || '',
    sessionToken: opts.sessionToken || '',
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: payload,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bedrock ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    return parseConverseOutput(json, onEvent);
  }
  if (!res.body) throw new Error('bedrock returned no body');

  const state = { text: '', thinking: '', toolCalls: [], blocks: {}, usage: null, stopReason: '' };
  const reader = res.body.getReader();
  let buffer = Buffer.alloc(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    const parsed = parseEventStream(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) processConverseStreamEvent(event, state, onEvent);
  }

  return {
    text: state.text,
    thinking: state.thinking,
    usage: state.usage,
    stopReason: state.stopReason,
    toolCalls: state.toolCalls,
  };
}

module.exports = {
  streamChat,
  signRequest,
  toConverse,
  toTools,
  parseEventStream,
  processConverseStreamEvent,
};
