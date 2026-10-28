'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadConfig } = require('../src/config/load');
const { buildRegistry, toCatalogMetadata } = require('../src/catalog/registry');

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

function registry() {
  return buildRegistry(loadConfig(EXAMPLE, { env: ENV }).config);
}

test('routes a configured model to BYOK', () => {
  const r = registry();
  const resolved = r.resolve('anycursor/opencode/deepseek-v4.1-flash');
  assert.equal(resolved.route, 'byok');
  assert.equal(resolved.model.displayName, 'DeepSeek V4.1 Flash');
});

test('routes legacy model ids to the configured BYOK model', () => {
  const r = registry();
  const resolved = r.resolve('deepseek-v4.1-flash');
  assert.equal(resolved.route, 'byok');
  assert.equal(resolved.legacy, true);
  assert.equal(resolved.model.cursorId, 'anycursor/opencode/deepseek-v4.1-flash');
});

test('routes unknown models to native passthrough by default', () => {
  const r = registry();
  assert.equal(r.resolve('claude-sonnet-5-5').route, 'native');
  assert.equal(r.resolve('auto').route, 'native');
});

test('can disable native passthrough', () => {
  const { config } = loadConfig(EXAMPLE, { env: ENV });
  config.routing.nativePassthrough = false;
  config.routing.onUnknownModel = 'error';
  const r = buildRegistry(config);
  const resolved = r.resolve('gpt-5');
  assert.equal(resolved.route, 'error');
  assert.match(resolved.reason, /unknown model/);
});

test('catalog metadata exposes display name, effort and capabilities', () => {
  const r = registry();
  const model = r.byCursorId.get('anycursor/opencode/deepseek-v4.1-flash');
  const meta = toCatalogMetadata(model);
  assert.equal(meta.name, model.cursorId);
  assert.equal(meta.serverModelName, 'deepseek-v4.1-flash');
  assert.equal(meta.clientDisplayName, 'DeepSeek V4.1 Flash');
  assert.equal(meta.tagline, 'OpenCode Go');
  assert.equal(meta.supportsThinking, true);
  assert.equal(meta.supportsImages, true);
  assert.equal(meta.variants.length, 3);
  assert.equal(meta.parameters.effort.default, 'high');
  assert.equal(meta.parameters.context.options.length, 2);
  assert.equal(meta.parameters.fast.supported, false);
});

test('disabled models are not routable but remain in the registry list', () => {
  const { config } = loadConfig(EXAMPLE, { env: ENV });
  config.models[0].enabled = false;
  const r = buildRegistry(config);
  assert.equal(r.resolve(config.models[0].cursorId).route, 'native');
  assert.equal(r.models.length, 2);
});
