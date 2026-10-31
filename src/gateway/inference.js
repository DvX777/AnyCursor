'use strict';

/*
 * Cursor 3.x Agent Host "managed-local" inference transport.
 *
 * The local loop calls aiserver.v1.InferenceService/RunInference (bidi Connect
 * stream). For AnyCursor/BYOK models we answer that stream ourselves instead of
 * forwarding it to Cursor's backend, which does not know the model.
 *
 * Client messages (RunInferenceClientMessage):
 *   1 run_request, 2 invoke_model, 3 cancel_invocation, 4 finish_run, 5 heartbeat
 * Server messages (RunInferenceServerMessage):
 *   1 heartbeat, 2 run_ready, 3 invocation_response, 4 invocation_end
 */

const providers = require('../providers');
const selections = require('./selections');
const usage = require('./usage');

/* ---------------- protobuf primitives ---------------- */

function rv(buf, i) {
  let shift = 0;
  let val = 0;
  while (true) {
    if (i >= buf.length) throw new RangeError('eof');
    const c = buf[i++];
    val |= (c & 0x7f) << shift;
    if (!(c & 0x80)) return [val, i];
    shift += 7;
  }
}

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function ld(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

function vi(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

function frame(payload, flags = 0) {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function fields(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  let i = 0;
  while (i < buf.length) {
    let key;
    try { [key, i] = rv(buf, i); } catch (_) { break; }
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v;
      try { [v, i] = rv(buf, i); } catch (_) { break; }
      out.push({ no, wire, value: v });
    } else if (wire === 2) {
      let len;
      try { [len, i] = rv(buf, i); } catch (_) { break; }
      if (i + len > buf.length) break;
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ no, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > buf.length) break;
      out.push({ no, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

function one(buf, no, wire) {
  return fields(buf).find((f) => f.no === no && (wire === undefined || f.wire === wire));
}

function bytes(buf, no) {
  const f = one(buf, no, 2);
  return f ? f.value : undefined;
}

function text(buf, no) {
  const b = bytes(buf, no);
  return b === undefined ? undefined : b.toString('utf8');
}

function int(buf, no) {
  const f = one(buf, no, 0);
  return f ? f.value : undefined;
}

function fixed(buf, no, kind) {
  const f = one(buf, no, kind === 'double' ? 1 : 5);
  if (!f) return undefined;
  return kind === 'double' ? f.value.readDoubleBE(0) : f.value.readFloatBE(0);
}

function all(buf, no) {
  return fields(buf).filter((f) => f.no === no && f.wire === 2).map((f) => f.value);
}

/* ---------------- google.protobuf.Struct ---------------- */

function decodeValue(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  for (const f of fields(buf)) {
    if (f.no === 1) return null;
    if (f.no === 2 && f.wire === 1) return f.value.readDoubleBE(0);
    if (f.no === 3) return f.value.toString('utf8');
    if (f.no === 4) return !!f.value;
    if (f.no === 5) return decodeStruct(f.value);
    if (f.no === 6) return all(f.value, 1).map(decodeValue);
  }
  return null;
}

function decodeStruct(buf) {
  const out = {};
  for (const entry of all(buf, 1)) {
    const key = text(entry, 1) || '';
    const value = bytes(entry, 2);
    out[key] = value === undefined ? null : decodeValue(value);
  }
  return out;
}

function decodeMaybe(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  const str = buf.toString('utf8');
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(str)) return str;
  try {
    const value = decodeValue(buf);
    if (value !== null && value !== undefined) return typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) { /* ignore */ }
  return str;
}

/* ---------------- request parsing ---------------- */

function parseRequestedModel(buf) {
  if (!Buffer.isBuffer(buf)) return {};
  const parameters = {};
  for (const item of all(buf, 3)) {
    const id = text(item, 1);
    if (id) parameters[id] = text(item, 2) || '';
  }
  return {
    modelId: text(buf, 1) || '',
    maxMode: !!int(buf, 2),
    parameters,
    builtIn: !!int(buf, 4),
  };
}

function parseRunRequest(buf) {
  const requested = parseRequestedModel(bytes(buf, 3));
  return {
    conversationId: text(buf, 1) || '',
    conversationGroupId: text(buf, 2) || '',
    requestedModel: requested,
    modelId: requested.modelId,
    agentMode: text(buf, 5) || '',
    subagentType: text(buf, 6) || '',
    isSummarize: !!int(buf, 9),
  };
}

function parseToolCall(buf) {
  const args = bytes(buf, 3);
  return {
    id: text(buf, 1) || '',
    name: text(buf, 2) || '',
    args: args === undefined ? {} : decodeStruct(args),
    rawArgs: text(buf, 4) || '',
  };
}

function parseContentParts(buf) {
  const result = { text: '', images: [], files: [] };
  for (const part of all(buf, 1)) {
    const textPart = bytes(part, 1);
    if (textPart !== undefined) {
      result.text += text(textPart, 1) || '';
      continue;
    }
    const image = bytes(part, 2);
    if (image !== undefined) {
      const data = text(image, 1) || '';
      if (data) result.images.push({ data, mimeType: text(image, 2) || 'image/png' });
      continue;
    }
    const file = bytes(part, 3);
    if (file !== undefined) {
      const data = text(file, 1) || '';
      if (data) {
        result.files.push({
          data,
          mediaType: text(file, 2) || 'application/octet-stream',
          filename: text(file, 3) || 'attachment',
        });
      }
    }
  }
  return result;
}

function parseToolResult(buf) {
  const parts = [];
  for (const part of all(buf, 1)) {
    const id = text(part, 1) || '';
    let content = '';
    for (const block of all(part, 5)) content += parseContentParts(block).text;
    if (!content) content = decodeMaybe(bytes(part, 3));
    parts.push({ id, content, isError: !!int(part, 4) });
  }
  return parts;
}

function parseCoreMessage(buf) {
  const roleNo = int(buf, 1) || 0;
  const role = { 1: 'user', 2: 'assistant', 3: 'tool', 4: 'system' }[roleNo] || 'user';
  let content = text(buf, 2) || '';
  const parts = bytes(buf, 3);
  let images = [];
  let files = [];
  if (parts !== undefined) {
    const parsed = parseContentParts(parts);
    content += parsed.text;
    images = parsed.images;
    files = parsed.files;
  }
  const toolCalls = all(buf, 4).map(parseToolCall);
  const toolResult = bytes(buf, 6);
  return {
    role,
    content,
    images,
    files,
    toolCalls,
    toolResults: toolResult === undefined ? [] : parseToolResult(toolResult),
  };
}

function parseStreamRequest(buf) {
  const requested = parseRequestedModel(bytes(buf, 7));
  const params = {};
  if (requested.parameters) Object.assign(params, requested.parameters);
  return {
    modelId: text(buf, 5) || requested.modelId || '',
    requestedModel: requested,
    conversationId: text(buf, 8) || '',
    parameters: params,
    messages: all(buf, 1).map(parseCoreMessage),
    tools: all(buf, 2).map(parseTool).filter((tool) => tool.name),
    modelConfig: parseModelConfig(bytes(buf, 4)),
  };
}

function parseModelConfig(buf) {
  if (!Buffer.isBuffer(buf)) return {};
  return {
    maxTokens: int(buf, 1),
    temperature: fixed(buf, 2, 'float'),
    topP: fixed(buf, 3, 'float'),
  };
}

function parseTool(buf) {
  const schema = bytes(buf, 3);
  return {
    name: text(buf, 1) || '',
    description: text(buf, 2) || '',
    parameters: schema === undefined ? { type: 'object', properties: {} } : decodeStruct(schema),
  };
}

function parseInvokeModel(buf) {
  return {
    invocationId: text(buf, 1) || '',
    request: bytes(buf, 2),
    purpose: int(buf, 3) || 0,
  };
}

function parseSubagentResolution(buf) {
  return {
    resolutionId: text(buf, 1) || '',
    requestedModels: all(buf, 2).map((item) => item.toString('utf8')).filter(Boolean),
  };
}

function parseClientMessage(payload) {
  const f = fields(payload);
  const out = {};
  for (const item of f) {
    if (item.no === 1) out.runRequest = parseRunRequest(item.value);
    else if (item.no === 2) out.invokeModel = parseInvokeModel(item.value);
    else if (item.no === 3) out.cancel = { invocationId: text(item.value, 1) || '' };
    else if (item.no === 4) out.finishRun = { aborted: !!int(item.value, 1) };
    else if (item.no === 5) out.heartbeat = true;
    else if (item.no === 9) out.resolveSubagentModels = parseSubagentResolution(item.value);
  }
  return out;
}

/* ---------------- provider message conversion ---------------- */

function imageUrl(image) {
  if (/^https?:|^data:/i.test(image.data)) return image.data;
  return `data:${image.mimeType || 'image/png'};base64,${image.data}`;
}

function convertMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool' && message.toolResults.length) {
      for (const result of message.toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: result.id || message.toolCalls[0]?.id || '',
          content: result.content,
        });
      }
      continue;
    }
    const converted = { role: message.role };
    const images = Array.isArray(message.images) ? message.images : [];
    const files = Array.isArray(message.files) ? message.files : [];
    let content = message.content || '';
    if (files.length) {
      const notes = files.map((file) => `[Attached file: ${file.filename || 'attachment'} (${file.mediaType || 'file'})]`);
      content = [content, ...notes].filter(Boolean).join('\n\n');
    }
    if (images.length) {
      const blocks = [];
      if (content) blocks.push({ type: 'text', text: content });
      for (const image of images) {
        blocks.push({ type: 'image_url', image_url: { url: imageUrl(image) } });
      }
      converted.content = blocks;
    } else if (content) {
      converted.content = content;
    }
    if (message.toolCalls.length) {
      converted.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.rawArgs || JSON.stringify(call.args || {}),
        },
      }));
      if (!converted.content && !images.length) delete converted.content;
    }
    out.push(converted);
  }
  return out;
}

function convertTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

function selectedEffort(model, parameters) {
  if (!model || !model.effort) return undefined;
  const field = model.effort.requestField || 'reasoning_effort';
  const value = parameters[field] || parameters.reasoning_effort || parameters.reasoning;
  if (value) return value;
  return model.effort.default;
}

/* ---------------- server frames ---------------- */

function serverMessage(field, payload) {
  return frame(ld(field, payload));
}

function heartbeatFrame() {
  return serverMessage(1, vi(1, 0));
}

function agentModeConfig(modeId) {
  return ld(1, Buffer.from(modeId));
}

function runReadyFrame(model, requested, effort) {
  const resolved = Buffer.concat([
    ld(1, Buffer.from(model.cursorId)),
    requested && requested.maxMode ? vi(2, 1) : Buffer.alloc(0),
  ]);
  const modeConfigs = ['agent', 'chat', 'plan', 'debug', 'triage', 'multitask']
    .map((modeId) => ld(46, agentModeConfig(modeId)));
  const promptMetadata = Buffer.concat([
    ld(1, Buffer.from('openai')),
    ld(2, Buffer.from('latest')),
    effort ? ld(30, Buffer.from(String(effort))) : Buffer.alloc(0),
    ld(44, Buffer.from(model.displayName || model.model || model.cursorId)),
    ...modeConfigs,
    ld(48, Buffer.concat([
      ld(1, Buffer.from('AskQuestion')),
      vi(2, 0),
    ])),
  ]);
  const ready = Buffer.concat([
    ld(1, resolved),
    vi(2, 1),           // supports_self_summary
    ld(3, Buffer.from(model.displayName || model.cursorId)),
    ld(4, promptMetadata),
    vi(7, 1),           // accepts_client_heartbeat
    vi(8, 1),           // accepts_agent_events
    vi(13, 1),          // accepts_aborted_finish
    vi(14, 1),          // accepts_subagent_model_resolution
    vi(15, 1),          // accepts_tool_call_events
    vi(16, 1),          // accepts_client_first_call_timings
  ]);
  return serverMessage(2, ready);
}

function invocationResponseFrame(invocationId, response) {
  return serverMessage(3, Buffer.concat([
    ld(1, Buffer.from(invocationId)),
    ld(2, response),
  ]));
}

function textPart(textValue, isFinal) {
  return Buffer.concat([
    ld(1, Buffer.from(textValue)),
    vi(2, isFinal ? 1 : 0),
  ]);
}

function thinkingPart(textValue, isFinal) {
  return Buffer.concat([
    ld(1, Buffer.from(textValue)),
    vi(3, isFinal ? 1 : 0),
  ]);
}

function toolCallPart(call, index) {
  return Buffer.concat([
    ld(1, Buffer.from(call.id || `call_${index}`)),
    ld(2, Buffer.from(call.name || '')),
    ld(3, Buffer.from(call.args || '{}')),
    vi(4, 1),
    vi(5, index),
  ]);
}

function invocationEndFrame(invocationId, error) {
  const parts = [ld(1, Buffer.from(invocationId))];
  if (error) {
    parts.push(ld(2, Buffer.concat([
      vi(1, 13),
      ld(2, Buffer.from(error)),
    ])));
  }
  return serverMessage(4, Buffer.concat(parts));
}

function subagentModelsFrame(resolution) {
  const models = resolution.models.map((entry) => Buffer.concat([
    ld(1, Buffer.from(entry.requested)),
    entry.resolvedSlug ? ld(2, Buffer.from(entry.resolvedSlug)) : Buffer.alloc(0),
  ]));
  return serverMessage(5, Buffer.concat([
    ld(1, Buffer.from(resolution.resolutionId)),
    ...models.map((model) => ld(2, model)),
  ]));
}

/* ---------------- stream handler ---------------- */

function handleRunInference(stream, hdrs, id, reqPath, options) {
  const { forward, resolve, prepare, log } = options;
  let buffer = Buffer.alloc(0);
  let raw = Buffer.alloc(0);
  let decided = false;
  let ready = false;
  let ended = false;
  let stopped = false;
  let currentAbort = null;
  let queue = Promise.resolve();
  let conversationId = '';
  let selected = null;
  let heartbeat = null;

  const send = (payload) => {
    if (!ended && !stream.destroyed) {
      try { stream.write(payload); } catch (_) { ended = true; }
    }
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    if (currentAbort) { try { currentAbort.abort(); } catch (_) {} }
    if (heartbeat) clearInterval(heartbeat);
    try { stream.end(); } catch (_) {}
  };

  const fail = (message) => {
    log({ id, ts: new Date().toISOString(), dir: 'inference-error', model: selected && selected.cursorId, error: message });
    finish();
  };

  const start = (runRequest) => {
    decided = true;
    conversationId = runRequest.conversationId || conversationId;
    const resolved = resolve(runRequest.modelId);
    if (!resolved || resolved.route !== 'byok') {
      stopped = true;
      stream.removeListener('data', onData);
      forward(raw);
      return false;
    }
    selected = resolved.model;
    const modelOptions = prepare(selected);
    if (!modelOptions) {
      stream.respond({ ':status': 503, 'content-type': 'text/plain; charset=utf-8' });
      stream.end('AnyCursor provider is not configured');
      ended = true;
      return false;
    }
    stream.respond({
      ':status': 200,
      'content-type': 'application/connect+proto',
      'connect-content-encoding': 'identity',
    });
    send(runReadyFrame(selected, runRequest.requestedModel, selectedEffort(selected, runRequest.requestedModel && runRequest.requestedModel.parameters)));
    ready = true;
    heartbeat = setInterval(() => send(heartbeatFrame()), 10000);
    log({
      id, ts: new Date().toISOString(), dir: 'inference-ready',
      model: selected.cursorId, requested: runRequest.modelId, conversationId,
    });
    return true;
  };

  const runInvocation = async (invoke) => {
    if (!ready || !selected) return;
    const request = invoke.request ? parseStreamRequest(invoke.request) : { messages: [], tools: [], parameters: {}, modelConfig: {} };
    const invocationId = invoke.invocationId || request.invocationId || `inv_${Date.now()}`;
    const modelOptions = prepare(selected);
    if (!modelOptions) {
      send(invocationEndFrame(invocationId, `provider for ${selected.provider} is not configured`));
      return;
    }
    const messages = convertMessages(request.messages);
    const tools = convertTools(request.tools);
    const parameters = { ...request.parameters, ...(request.requestedModel && request.requestedModel.parameters) };
    const effort = selectedEffort(selected, parameters);
    selections.record(selected, { effort, context: parameters.context, fast: parameters.fast });
    const adapter = providers.getAdapter(selected.api);
    const abort = new AbortController();
    currentAbort = abort;
    const started = Date.now();
    let textChars = 0;
    let thinkingChars = 0;
    let toolCalls = 0;
    try {
      const result = await adapter.streamChat({
        modelId: selected.model,
        apiKey: modelOptions.apiKey,
        baseUrl: modelOptions.baseUrl,
        endpoint: modelOptions.endpoint,
        conversationId: conversationId || request.conversationId,
        runId: invocationId,
        messages,
        tools,
        maxOutput: request.modelConfig.maxTokens || selected.maxOutput,
        effort,
        reasoningEffortField: selected.effort && selected.effort.requestField,
        context: parameters.context,
        fast: parameters.fast === 'true',
        headers: modelOptions.headers,
        region: modelOptions.region,
        accessKeyId: modelOptions.accessKeyId,
        secretAccessKey: modelOptions.secretAccessKey,
        sessionToken: modelOptions.sessionToken,
      }, async (event) => {
        if (event.kind === 'text' && event.text) {
          textChars += event.text.length;
          send(invocationResponseFrame(invocationId, ld(1, textPart(event.text, false))));
        } else if (event.kind === 'thinking' && event.text) {
          thinkingChars += event.text.length;
          send(invocationResponseFrame(invocationId, ld(9, thinkingPart(event.text, false))));
        }
      }, abort.signal);
      if (textChars) send(invocationResponseFrame(invocationId, ld(1, textPart('', true))));
      if (thinkingChars) send(invocationResponseFrame(invocationId, ld(9, thinkingPart('', true))));
      if (result && Array.isArray(result.toolCalls)) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          toolCalls++;
          send(invocationResponseFrame(invocationId, ld(2, toolCallPart(result.toolCalls[i], i))));
        }
      }
      send(invocationEndFrame(invocationId));
      usage.record(selected.cursorId, {
        tokensIn: usage.textSize(messages),
        tokensOut: Math.ceil((textChars + thinkingChars) / 4),
      });
      log({
        id, ts: new Date().toISOString(), dir: 'inference-turn',
        model: selected.cursorId, invocationId, messages: messages.length, tools: tools.length,
        textChars, thinkingChars, toolCalls, ms: Date.now() - started,
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      send(invocationEndFrame(invocationId, message));
      log({
        id, ts: new Date().toISOString(), dir: 'inference-turn-error',
        model: selected.cursorId, invocationId, error: message, ms: Date.now() - started,
      });
    } finally {
      if (currentAbort === abort) currentAbort = null;
    }
  };

  const processFrame = (payload) => {
    let message;
    try { message = parseClientMessage(payload); } catch (error) {
      log({ id, ts: new Date().toISOString(), dir: 'inference-parse-error', error: String(error) });
      return;
    }
    if (message.runRequest && !decided) {
      start(message.runRequest);
      return;
    }
    if (!ready) return;
    if (message.resolveSubagentModels) {
      const resolution = {
        resolutionId: message.resolveSubagentModels.resolutionId,
        models: message.resolveSubagentModels.requestedModels.map((requested) => {
          const resolved = resolve(requested);
          return {
            requested,
            resolvedSlug: resolved && resolved.route === 'byok' ? resolved.model.cursorId : requested,
          };
        }),
      };
      send(subagentModelsFrame(resolution));
    } else if (message.invokeModel) {
      queue = queue.then(() => runInvocation(message.invokeModel)).catch(() => {});
    } else if (message.cancel && currentAbort) {
      try { currentAbort.abort(); } catch (_) {}
    } else if (message.finishRun) {
      queue = queue.then(() => { if (!message.finishRun.aborted) send(heartbeatFrame()); finish(); });
    }
  };

  const pump = () => {
    while (!stopped) {
      if (buffer.length < 5) return;
      const flags = buffer[0];
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) return;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (flags & 2) { finish(); return; }
      if (flags & 1) {
        try { processFrame(require('zlib').gunzipSync(payload)); } catch (_) { /* ignore */ }
      } else {
        processFrame(payload);
      }
    }
  };

  const onData = (chunk) => {
    raw = Buffer.concat([raw, chunk]);
    buffer = Buffer.concat([buffer, chunk]);
    pump();
    if (raw.length > 8 * 1024 * 1024) raw = Buffer.alloc(0);
  };

  stream.on('data', onData);
  stream.on('end', () => { queue = queue.then(finish); });
  stream.on('error', () => finish());

  setTimeout(() => {
    if (!decided) {
      stream.removeListener('data', onData);
      forward(raw);
    }
  }, 5000);
}

module.exports = {
  handleRunInference,
  parseClientMessage,
  parseRunRequest,
  parseStreamRequest,
  convertMessages,
  convertTools,
  runReadyFrame,
  invocationResponseFrame,
  invocationEndFrame,
};
