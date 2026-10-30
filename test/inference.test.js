'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseClientMessage,
  parseStreamRequest,
  convertMessages,
  convertTools,
  runReadyFrame,
} = require('../src/gateway/inference');

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}
function tag(field, wire) { return varint((field << 3) | wire); }
function ld(field, buf) { return Buffer.concat([tag(field, 2), varint(buf.length), buf]); }
function vi(field, n) { return Buffer.concat([tag(field, 0), varint(n)]); }

function readFields(buf) {
  const out = [];
  let i = 0;
  const rv = () => {
    let shift = 0;
    let val = 0;
    while (true) {
      const c = buf[i++];
      val |= (c & 0x7f) << shift;
      if (!(c & 0x80)) return val;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = rv();
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, value: rv() });
    else if (wire === 2) {
      const len = rv();
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else break;
  }
  return out;
}
function one(buf, no) {
  const f = readFields(buf).find((x) => x.no === no && x.wire === 2);
  return f && f.value;
}
function str(buf, no) { const v = one(buf, no); return v === undefined ? undefined : v.toString('utf8'); }

test('parses run_request model id and parameters', () => {
  const requested = Buffer.concat([
    ld(1, Buffer.from('claude-anycursor-deepseek')),
    ld(3, Buffer.concat([ld(1, Buffer.from('reasoning_effort')), ld(2, Buffer.from('max'))])),
  ]);
  const run = Buffer.concat([
    ld(1, Buffer.from('conversation-1')),
    ld(3, requested),
  ]);
  const message = parseClientMessage(ld(1, run));
  assert.equal(message.runRequest.modelId, 'claude-anycursor-deepseek');
  assert.equal(message.runRequest.conversationId, 'conversation-1');
  assert.equal(message.runRequest.requestedModel.parameters.reasoning_effort, 'max');
});

test('parses invoke_model messages and tools', () => {
  const user = Buffer.concat([vi(1, 1), ld(2, Buffer.from('hello'))]);
  const tool = Buffer.concat([
    ld(1, Buffer.from('read_file')),
    ld(2, Buffer.from('Read a file')),
  ]);
  const request = Buffer.concat([
    ld(1, user),
    ld(2, tool),
    ld(5, Buffer.from('deepseek-v4.1-flash')),
  ]);
  const invoke = Buffer.concat([ld(1, Buffer.from('inv-1')), ld(2, request)]);
  const message = parseClientMessage(ld(2, invoke));
  assert.equal(message.invokeModel.invocationId, 'inv-1');

  const parsed = parseStreamRequest(message.invokeModel.request);
  assert.equal(parsed.modelId, 'deepseek-v4.1-flash');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[0].content, 'hello');
  assert.equal(parsed.tools[0].name, 'read_file');
});

test('converts assistant tool calls and tool results to provider messages', () => {
  const toolCall = Buffer.concat([
    ld(1, Buffer.from('call-1')),
    ld(2, Buffer.from('read_file')),
    ld(4, Buffer.from('{"path":"a.js"}')),
  ]);
  const assistant = Buffer.concat([vi(1, 2), ld(4, toolCall)]);
  const resultPart = Buffer.concat([
    ld(1, Buffer.from('call-1')),
    ld(2, Buffer.from('read_file')),
    ld(5, ld(1, Buffer.from('file body'))),
  ]);
  const toolResult = Buffer.concat([vi(1, 3), ld(6, ld(1, resultPart))]);

  const messages = convertMessages([
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', args: {}, rawArgs: '{"path":"a.js"}' }], toolResults: [] },
    { role: 'tool', content: '', toolCalls: [], toolResults: [{ id: 'call-1', content: 'file body' }] },
  ]);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].tool_calls[0].function.name, 'read_file');
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].tool_call_id, 'call-1');
  assert.equal(messages[1].content, 'file body');

  // The raw wire messages above should parse into the same shape.
  const parsed = convertMessages([
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', args: {}, rawArgs: '{"path":"a.js"}' }], toolResults: [] },
    { role: 'tool', content: '', toolCalls: [], toolResults: [{ id: 'call-1', content: 'file body' }] },
  ]);
  assert.equal(parsed.length, 2);
  assert.ok(assistant.length > 0 && toolResult.length > 0);
});

test('converts Cursor tools to provider function tools', () => {
  const tools = convertTools([{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'read_file');
});

test('parses subagent model resolution requests', () => {
  const resolution = Buffer.concat([
    ld(1, Buffer.from('resolution-1')),
    ld(2, Buffer.from('claude-anycursor-deepseek')),
    ld(2, Buffer.from('gpt-5')),
  ]);
  const message = parseClientMessage(ld(9, resolution));
  assert.equal(message.resolveSubagentModels.resolutionId, 'resolution-1');
  assert.deepEqual(message.resolveSubagentModels.requestedModels, [
    'claude-anycursor-deepseek',
    'gpt-5',
  ]);
});

test('parses image parts and converts them to provider image blocks', () => {
  const image = ld(2, Buffer.concat([
    ld(1, Buffer.from('aGVsbG8=')),
    ld(2, Buffer.from('image/png')),
  ]));
  const user = Buffer.concat([
    vi(1, 1),
    ld(2, Buffer.from('look at this')),
    ld(3, ld(1, image)),
  ]);
  const request = Buffer.concat([ld(1, user), ld(5, Buffer.from('model'))]);
  const parsed = parseStreamRequest(request);
  assert.equal(parsed.messages[0].images.length, 1);
  assert.equal(parsed.messages[0].images[0].mimeType, 'image/png');

  const converted = convertMessages(parsed.messages);
  assert.ok(Array.isArray(converted[0].content));
  assert.equal(converted[0].content[0].text, 'look at this');
  assert.equal(converted[0].content[1].type, 'image_url');
  assert.match(converted[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('run_ready carries recognized prompt metadata and display name', () => {
  const frame = runReadyFrame({
    cursorId: 'claude-anycursor-deepseek',
    displayName: 'DeepSeek',
    maxOutput: 8192,
  }, { maxMode: false }, 'high');
  const payload = frame.subarray(5);
  const ready = one(payload, 2);
  assert.ok(ready);
  const metadata = one(ready, 4);
  assert.equal(str(metadata, 1), 'openai');
  assert.equal(str(metadata, 2), 'latest');
  assert.equal(str(metadata, 30), 'high');
  assert.equal(str(ready, 3), 'DeepSeek');
  const modes = readFields(metadata).filter((f) => f.no === 46).map((f) => str(f.value, 1));
  assert.deepEqual(modes, ['agent', 'chat', 'plan', 'debug']);
  assert.ok(one(metadata, 48));
});
