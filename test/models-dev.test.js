'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadConfig } = require('../src/config/load');
const { effortTiers, findModel, enrichConfig } = require('../src/catalog/models-dev');

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

test('extracts effort tiers from models.dev reasoning options', () => {
  const tiers = effortTiers({
    reasoning_options: { type: 'effort', values: ['low', 'high', 'max'] },
  });
  assert.deepEqual(tiers.map((t) => t.id), ['low', 'high', 'max']);
  assert.deepEqual(tiers.map((t) => t.label), ['Low', 'High', 'Max']);
});

test('finds an opencode-go model and applies its effort tiers', () => {
  const catalog = {
    'opencode-go': {
      models: {
        'deepseek-v4.1-flash': {
          reasoning_options: { type: 'effort', values: ['low', 'high', 'max'] },
        },
      },
    },
  };
  assert.ok(findModel(catalog, 'opencode-go', 'deepseek-v4.1-flash'));

  const { config } = loadConfig(EXAMPLE, { env: ENV });
  const enriched = enrichConfig(config, catalog);
  const model = enriched.models.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.deepEqual(model.effort.tiers.map((t) => t.id), ['low', 'high', 'max']);
  assert.equal(model.effort.default, 'high');
});
