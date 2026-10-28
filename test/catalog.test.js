'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');

const { loadConfig } = require('../src/config/load');
const { encodeAvailableModel, appendModels, readFields } = require('../src/catalog/available-models');
const { transformCatalog } = require('../src/catalog/response');

const EXAMPLE = path.join(__dirname, '..', 'config', 'anycursor.example.json');
const ENV = {
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  OPENCODE_API_KEY: 'opencode-key',
  ANTHROPIC_API_KEY: 'anthropic-key',
  GEMINI_API_KEY: 'gemini-key',
  AZURE_OPENAI_API_KEY: 'azure-key',
  AWS_ACCESS_KEY_ID: 'aws-id',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_SESSION_TOKEN: 'aws-session',
};

function one(fields, no, wire = 2) {
  const f = fields.find((x) => x.no === no && x.wire === wire);
  return f ? f.value : undefined;
}
function text(fields, no) {
  const v = one(fields, no);
  return v === undefined ? undefined : v.toString('utf8');
}
function num(fields, no) {
  const v = one(fields, no, 0);
  return v === undefined ? undefined : v;
}

test('encodes model display name, real model id, effort and capabilities', () => {
  const { config } = loadConfig(EXAMPLE, { env: ENV });
  const model = config.models[0];
  const fields = readFields(encodeAvailableModel(model));

  assert.equal(text(fields, 1), 'anycursor/opencode/deepseek-v4.1-flash');
  assert.equal(text(fields, 17), 'DeepSeek V4.1 Flash');
  assert.equal(text(fields, 18), 'deepseek-v4.1-flash');
  assert.equal(text(fields, 24), 'DeepSeek V4.1');
  assert.equal(text(fields, 39), 'OpenCode Go');
  assert.equal(num(fields, 5), 1);
  assert.equal(num(fields, 9), 1);
  assert.equal(num(fields, 10), 1);
  assert.equal(num(fields, 15), 200000);
  assert.equal(num(fields, 16), 1000000);
  assert.equal(fields.filter((f) => f.no === 29).length, 2);
  assert.equal(fields.filter((f) => f.no === 30).length, 3);
});

test('appends models without changing native response bytes', () => {
  const { config } = loadConfig(EXAMPLE, { env: ENV });
  const raw = Buffer.from([0x12, 0x03, 0x61, 0x62, 0x63]); // arbitrary native models field
  const merged = appendModels(raw, config.models);
  assert.deepEqual(merged.subarray(0, raw.length), raw);

  const fields = readFields(merged);
  const names = fields.filter((f) => f.no === 1).map((f) => f.value.toString('utf8'));
  assert.ok(names.includes('anycursor/opencode/deepseek-v4.1-flash'));
  assert.ok(names.includes('anycursor/anthropic/claude-sonnet-5.5'));
  assert.equal(fields.filter((f) => f.no === 2).length, 3); // 1 native + 2 appended
  assert.equal(num(fields, 11), 1);
});

test('merges gzip-compressed native responses', () => {
  const { config } = loadConfig(EXAMPLE, { env: ENV });
  const raw = Buffer.from([0x12, 0x03, 0x61, 0x62, 0x63]);
  const gz = zlib.gzipSync(raw);
  const result = transformCatalog(gz, { 'content-encoding': 'gzip' }, config.models);
  assert.equal(result.encoding, 'gzip');
  const decoded = zlib.gunzipSync(result.body);
  assert.deepEqual(decoded.subarray(0, raw.length), raw);

  const fields = readFields(decoded);
  assert.equal(fields.filter((f) => f.no === 2).length, 3);
  assert.ok(fields.filter((f) => f.no === 1).some((f) => f.value.toString('utf8') === 'anycursor/opencode/deepseek-v4.1-flash'));
});

test('omits unsupported parameter definitions', () => {
  const model = {
    cursorId: 'anycursor/p/plain',
    displayName: 'Plain',
    shortName: 'Plain',
    model: 'plain',
    providerLabel: 'P',
    vendor: '',
    effort: null,
    contextOptions: [],
    fast: false,
    capabilities: { tools: true, reasoning: false, vision: false },
  };
  const fields = readFields(encodeAvailableModel(model));
  assert.equal(fields.filter((f) => f.no === 29).length, 0);
  assert.equal(fields.filter((f) => f.no === 30).length, 0);
  assert.equal(num(fields, 9), undefined);
  assert.equal(num(fields, 10), undefined);

  const merged = appendModels(Buffer.alloc(0), [model]);
  assert.equal(num(readFields(merged), 11), undefined);
});
