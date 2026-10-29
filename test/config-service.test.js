'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigService, redactRaw, mergeSecrets } = require('../src/config/service');

const BASE = {
  gateway: { host: '127.0.0.1', port: 43110 },
  routing: {
    nativePassthrough: true,
    onUnknownModel: 'native',
    defaultModel: 'anycursor/local/model-a',
  },
  providers: {
    local: {
      type: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-secret-value',
    },
    aws: {
      type: 'bedrock',
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'aws-secret',
      sessionToken: 'aws-session',
    },
  },
  models: [
    {
      id: 'model-a',
      displayName: 'Model A',
      provider: 'local',
      model: 'model-a',
      apiKey: 'model-secret',
      capabilities: { tools: true },
    },
  ],
};

function writeTempConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-config-'));
  const file = path.join(dir, 'anycursor.json');
  fs.writeFileSync(file, JSON.stringify({ ...BASE, ...overrides }, null, 2));
  return { dir, file };
}

test('redacts provider and model secrets but reports their presence', () => {
  const redacted = redactRaw(BASE);
  assert.equal(redacted.providers.local.apiKey, '');
  assert.equal(redacted.providers.local.hasApiKey, true);
  assert.equal(redacted.providers.aws.secretAccessKey, '');
  assert.equal(redacted.providers.aws.hasSecretAccessKey, true);
  assert.equal(redacted.providers.aws.hasSessionToken, true);
  assert.equal(redacted.models[0].apiKey, '');
  assert.equal(redacted.models[0].hasApiKey, true);
});

test('keeps existing secrets when the edited config omits them', () => {
  const merged = mergeSecrets({
    providers: { local: { type: 'openai-compatible', baseUrl: 'https://example.test/v1' } },
    models: [{ id: 'model-a', model: 'model-a' }],
  }, BASE);
  assert.equal(merged.providers.local.apiKey, 'sk-secret-value');
  assert.equal(merged.models[0].apiKey, 'model-secret');
});

test('clear flags remove stored secrets', () => {
  const merged = mergeSecrets({
    providers: { local: { apiKey: '', clearApiKey: true } },
    models: [{ id: 'model-a', model: 'model-a', apiKey: '', clearApiKey: true }],
  }, BASE);
  assert.equal(merged.providers.local.apiKey, undefined);
  assert.equal(merged.models[0].apiKey, undefined);
  assert.equal(merged.providers.local.clearApiKey, undefined);
});

test('saves, validates, backs up, and reloads a config', () => {
  const { dir, file } = writeTempConfig();
  const service = new ConfigService(file);
  assert.equal(service.config.models.length, 1);

  const redacted = service.redacted();
  redacted.config.models[0].displayName = 'Model A Renamed';

  const result = service.save(redacted.config);
  assert.ok(fs.existsSync(result.backup));

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.models[0].displayName, 'Model A Renamed');
  assert.equal(written.providers.local.apiKey, 'sk-secret-value');
  assert.equal(written.models[0].apiKey, 'model-secret');

  const reloaded = new ConfigService(file);
  assert.equal(reloaded.config.models[0].displayName, 'Model A Renamed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects an invalid config without overwriting the file', () => {
  const { dir, file } = writeTempConfig();
  const before = fs.readFileSync(file, 'utf8');
  const service = new ConfigService(file);

  assert.throws(() => service.save({ providers: {}, models: [] }), /provider/i);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loads a config saved with a UTF-8 BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-config-'));
  const file = path.join(dir, 'anycursor.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(BASE, null, 2));

  const service = new ConfigService(file);
  assert.equal(service.error, '');
  assert.equal(service.config.models[0].displayName, 'Model A');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('reports a load error without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycursor-config-'));
  const file = path.join(dir, 'anycursor.json');
  fs.writeFileSync(file, '{ not json');

  const service = new ConfigService(file);
  assert.equal(service.config, null);
  assert.match(service.error, /JSON/i);

  fs.rmSync(dir, { recursive: true, force: true });
});
