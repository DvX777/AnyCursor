'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  cursorModelId,
  normalizeConfig,
  loadConfig,
} = require('../src/config/load');

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

test('loads the example config and keeps display name separate from model id', () => {
  const { config, warnings } = loadConfig(EXAMPLE, { env: ENV });
  assert.deepEqual(warnings, []);
  assert.equal(config.models.length, 2);

  const model = config.models[0];
  assert.equal(model.id, 'deepseek-v4.1-flash');
  assert.equal(model.displayName, 'DeepSeek V4.1 Flash');
  assert.equal(model.model, 'deepseek-v4.1-flash');
  assert.equal(model.cursorId, 'claude-anycursor-opencode-deepseek-v4.1-flash');
  assert.equal(model.providerLabel, 'OpenCode Go');
  assert.equal(model.effort.default, 'high');
  assert.equal(model.contextOptions.length, 2);
  assert.equal(model.fast, false);
  assert.equal(config.routing.defaultModel, model.cursorId);
});

test('interpolates environment variables and reports missing ones', () => {
  const raw = {
    providers: {
      p: { type: 'openai-compatible', baseUrl: '${TEST_BASE}', apiKey: '${TEST_KEY}' },
    },
    models: [{ displayName: 'Test', provider: 'p', model: 'test-model' }],
  };
  const missing = normalizeConfig(raw, { env: {} });
  assert.equal(missing.config.providers.p.apiKey, '');
  assert.ok(missing.warnings.some((w) => w.includes('TEST_BASE')));
  assert.ok(!missing.warnings.some((w) => w.includes('TEST_KEY')));

  const present = normalizeConfig(raw, { env: { TEST_BASE: 'https://example.test', TEST_KEY: 'secret' } });
  assert.equal(present.config.providers.p.apiKey, 'secret');
});

test('supports environment defaults', () => {
  const raw = {
    gateway: { port: '${PORT:-43111}' },
    providers: { p: { type: 'openai-compatible', baseUrl: 'https://x.test' } },
    models: [{ displayName: 'M', provider: 'p', model: 'm' }],
  };
  assert.equal(normalizeConfig(raw, { env: {} }).config.gateway.port, 43111);
  assert.equal(normalizeConfig(raw, { env: { PORT: '43112' } }).config.gateway.port, 43112);
});

test('rejects duplicate namespaced model ids', () => {
  const raw = {
    providers: { p: { type: 'openai-compatible', baseUrl: 'https://x.test' } },
    models: [
      { displayName: 'A', provider: 'p', model: 'same' },
      { displayName: 'B', provider: 'p', model: 'same' },
    ],
  };
  assert.throws(() => normalizeConfig(raw, { env: {} }), /duplicate model id/);
});

test('rejects unknown providers and invalid default models', () => {
  const unknown = {
    providers: { p: { type: 'openai-compatible', baseUrl: 'https://x.test' } },
    models: [{ displayName: 'A', provider: 'nope', model: 'm' }],
  };
  assert.throws(() => normalizeConfig(unknown, { env: {} }), /unknown provider/);

  const badDefault = {
    providers: { p: { type: 'openai-compatible', baseUrl: 'https://x.test' } },
    models: [{ displayName: 'A', provider: 'p', model: 'm' }],
    routing: { defaultModel: 'anycursor/p/nope' },
  };
  assert.throws(() => normalizeConfig(badDefault, { env: {} }), /defaultModel/);
});

test('namespaced ids are stable and provider-scoped', () => {
  assert.equal(cursorModelId('OpenCode', 'DeepSeek V4.1 Flash'), 'claude-anycursor-opencode-deepseek-v4.1-flash');
  assert.notEqual(cursorModelId('a', 'm'), cursorModelId('b', 'm'));
});
