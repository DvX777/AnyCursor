'use strict';

/**
 * Anthropic Messages API adapter.
 * Input messages use the gateway's OpenAI-style canonical shape.
 */

function joinUrl(baseUrl, endpoint, fallback) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const path = endpoint || fallback;
  if (!base) return path;
  if (/^https?:\/\//.test(path)) return path;
  if (base.endsWith(path)) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}

function contentToBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return { type: 'text', text: part };
      if (part && part.type === 'text') return { type: 'text', text: String(part.text || '') };
      if (part && part.text) return { type: 'text', text: String(part.text) };
      return null;
    }).filter(Boolean);
  }
  return content ? [{ type: 'text', text: String(content) }] : [];
}

function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  const toolNames = new Map();

  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : contentToBlocks(message.content).map((b) => b.text).join('\n');
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id || message.toolCallId || '';
      push('user', [{
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: String(message.content || '') }],
      }]);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = contentToBlocks(message.content);
      for (const call of message.tool_calls || []) {
        const fn = call.function || {};
        const id = call.id || call.tool_call_id || `tool_${out.length}_${blocks.length}`;
        let input = {};
        try { input = JSON.parse(fn.arguments || '{}'); } catch (_) { input = {}; }
        blocks.push({ type: 'tool_use', id, name: fn.name || 'tool', input });
        toolNames.set(id, fn.name || 'tool');
      }
      push('assistant', blocks);
      continue;
    }
    push('user', contentToBlocks(message.content));
  }
  return { system: system.join('\n\n'), messages: out };
}

function toAnthropicTools(tools) {
  return (tools || []).map((tool) => {
    const fn = tool.function || tool;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });
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
  const toolCalls = [];
  const toolByIndex = new Map();

  const processData = (data) => {
    if (!data || data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch (_) { return; }
    if (json.type === 'error') {
      throw new Error(json.error && json.error.message ? json.error.message : 'Anthropic stream error');
    }
    if (json.type === 'content_block_start') {
      const block = json.content_block || {};
      if (block.type === 'tool_use') {
        const call = {
          id: block.id || `tool_${json.index}`,
          name: block.name || 'tool',
          args: '',
          input: block.input || {},
        };
        toolByIndex.set(json.index, call);
        toolCalls.push(call);
      } else if (block.type === 'text' && block.text) {
        text += block.text;
        onEvent({ kind: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        thinking += block.thinking;
        onEvent({ kind: 'thinking', text: block.thinking });
      }
      return;
    }
    if (json.type === 'content_block_delta') {
      const delta = json.delta || {};
      if (delta.type === 'text_delta' && delta.text) {
        text += delta.text;
        onEvent({ kind: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        thinking += delta.thinking;
        onEvent({ kind: 'thinking', text: delta.thinking });
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        const call = toolByIndex.get(json.index);
        if (call) call.args += delta.partial_json;
      }
      return;
    }
    if (json.type === 'content_block_stop') {
      const call = toolByIndex.get(json.index);
      if (call) {
        try { call.input = call.args ? JSON.parse(call.args) : (call.input || {}); } catch (_) { call.input = {}; }
      }
      return;
    }
    if (json.type === 'message_delta') {
      if (json.delta && json.delta.stop_reason) stopReason = json.delta.stop_reason;
      if (json.usage) usage = json.usage;
      return;
    }
    if (json.type === 'message_start' && json.message && json.message.usage) usage = json.message.usage;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('event:')) continue;
      if (line.startsWith('data:')) processData(line.slice(5).trim());
    }
  }
  return {
    text,
    thinking,
    stopReason,
    usage,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      args: JSON.stringify(call.input || {}),
    })),
  };
}

async function streamChat(opts, onEvent, signal) {
  const url = joinUrl(opts.baseUrl, opts.endpoint, '/v1/messages');
  const headers = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'anthropic-version': opts.version || '2023-06-01',
    ...(opts.headers || {}),
  };
  if (opts.apiKey && !headers['x-api-key'] && !headers.authorization) headers['x-api-key'] = opts.apiKey;

  const { system, messages } = toAnthropicMessages(opts.messages);
  const tools = toAnthropicTools(opts.tools);
  const budget = opts.reasoning ? thinkingBudget(opts.effort) : 0;
  const body = {
    model: opts.modelId,
    max_tokens: Math.max(Number(opts.maxOutput) || 8192, budget + 1024),
    stream: true,
    messages,
  };
  if (system) body.system = system;
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  if (budget > 0) body.thinking = { type: 'enabled', budget_tokens: budget };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error('anthropic returned no body');
  return readSse(res, onEvent);
}

module.exports = {
  streamChat,
  toAnthropicMessages,
  toAnthropicTools,
  thinkingBudget,
};
