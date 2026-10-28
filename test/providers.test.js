'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const anthropic = require('../src/providers/anthropic');
const google = require('../src/providers/google');
const azure = require('../src/providers/azure');
const bedrock = require('../src/providers/bedrock');
const providers = require('../src/providers');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

test('anthropic converts messages/tools and parses streaming text and tool calls', async () => {
  let captured;
  const { server, url } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"Read","input":{}}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"x\\"}"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n\n'));
    });
  });

  try {
    const events = [];
    const result = await anthropic.streamChat({
      modelId: 'claude-sonnet-5-5',
      apiKey: 'test-key',
      baseUrl: url,
      endpoint: '/v1/messages',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'read x' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      ],
      tools: TOOLS,
      maxOutput: 4096,
      effort: 'high',
      reasoning: true,
    }, (event) => events.push(event));

    assert.equal(captured.system, 'Be brief');
    assert.equal(captured.messages.length, 3);
    assert.equal(captured.messages[1].content[0].type, 'tool_use');
    assert.equal(captured.messages[2].content[0].type, 'tool_result');
    assert.equal(captured.tools[0].name, 'Read');
    assert.ok(captured.thinking);
    assert.equal(result.text, 'Hello');
    assert.equal(result.toolCalls[0].name, 'Read');
    assert.deepEqual(JSON.parse(result.toolCalls[0].args), { path: 'x' });
    assert.equal(result.stopReason, 'tool_use');
    assert.ok(events.some((e) => e.kind === 'text' && e.text === 'Hello'));
  } finally {
    await close(server);
  }
});

test('google converts messages/tools and parses streaming text and function calls', async () => {
  let captured;
  const { server, url } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Read","args":{"path":"x"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1}}',
        '',
      ].join('\n\n'));
    });
  });

  try {
    const events = [];
    const result = await google.streamChat({
      modelId: 'gemini-2.5-pro',
      apiKey: 'test-key',
      baseUrl: url,
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'read x' },
      ],
      tools: TOOLS,
      maxOutput: 4096,
      effort: 'medium',
      reasoning: true,
    }, (event) => events.push(event));

    assert.equal(captured.systemInstruction.parts[0].text, 'Be brief');
    assert.equal(captured.contents[0].role, 'user');
    assert.equal(captured.contents[0].parts[0].text, 'read x');
    assert.equal(captured.tools[0].functionDeclarations[0].name, 'Read');
    assert.ok(captured.generationConfig.thinkingConfig);
    assert.equal(result.text, 'Hi');
    assert.equal(result.toolCalls[0].name, 'Read');
    assert.deepEqual(JSON.parse(result.toolCalls[0].args), { path: 'x' });
    assert.ok(events.some((e) => e.kind === 'text' && e.text === 'Hi'));
  } finally {
    await close(server);
  }
});

test('azure builds a deployment URL', () => {
  assert.equal(
    azure.buildAzureUrl({ baseUrl: 'https://res.openai.azure.com', deployment: 'gpt 5', apiVersion: '2024-10-21' }),
    'https://res.openai.azure.com/openai/deployments/gpt%205/chat/completions?api-version=2024-10-21',
  );
  assert.equal(
    azure.buildAzureUrl({ endpoint: 'https://res.openai.azure.com', deployment: 'gpt-5', apiVersion: '2024-10-21' }),
    'https://res.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21',
  );
});

test('bedrock converts messages/tools and signs requests', () => {
  const converted = bedrock.toConverse([
    { role: 'system', content: 'Be brief' },
    { role: 'user', content: 'read x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
  ]);
  assert.equal(converted.system[0].text, 'Be brief');
  assert.equal(converted.messages[1].content[0].toolUse.name, 'Read');
  assert.equal(converted.messages[2].content[0].toolResult.toolUseId, 'call_1');

  const headers = bedrock.signRequest({
    method: 'POST',
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse',
    headers: { 'content-type': 'application/json' },
    body: '{"x":1}',
    region: 'us-east-1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    now: new Date('2026-01-01T00:00:00Z'),
  });
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20260101\/us-east-1\/bedrock\/aws4_request/);
  assert.ok(headers.authorization.includes('SignedHeaders=content-type;host;x-amz-date'));
  assert.equal(headers['x-amz-date'], '20260101T000000Z');
});

test('provider registry maps all supported apis', () => {
  for (const api of ['openai-compatible', 'anthropic', 'google', 'azure-openai', 'bedrock']) {
    assert.equal(typeof providers.getAdapter(api).streamChat, 'function');
  }
  assert.throws(() => providers.getAdapter('nope'), /unsupported/);
});
