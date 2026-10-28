'use strict';

/**
 * AWS Bedrock Converse adapter.
 *
 * The first implementation uses the non-streaming Converse API and signs the
 * request with SigV4 directly, so AnyCursor does not need the AWS SDK.
 * Streaming can be added later without changing the provider contract.
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

async function streamChat(opts, onEvent, signal) {
  const region = opts.region || 'us-east-1';
  const modelId = opts.modelId;
  const endpoint = opts.endpoint
    ? String(opts.endpoint).replace(/\{model\}/g, encodeURIComponent(modelId))
    : `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
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
    headers: { 'content-type': 'application/json' },
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
  const json = await res.json();
  const content = (json.output && json.output.message && json.output.message.content) || [];
  let text = '';
  const toolCalls = [];
  for (const block of content) {
    if (block.text) {
      text += block.text;
      onEvent({ kind: 'text', text: block.text });
    }
    if (block.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId || `tool_${toolCalls.length}`,
        name: block.toolUse.name || 'tool',
        args: JSON.stringify(block.toolUse.input || {}),
      });
    }
  }
  return {
    text,
    thinking: '',
    usage: json.usage || null,
    stopReason: json.stopReason || '',
    toolCalls,
  };
}

module.exports = {
  streamChat,
  signRequest,
  toConverse,
  toTools,
};
