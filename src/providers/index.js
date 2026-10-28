'use strict';

const openai = require('./openai');
const anthropic = require('./anthropic');
const google = require('./google');
const azure = require('./azure');
const bedrock = require('./bedrock');

const ADAPTERS = {
  'openai-compatible': openai,
  'anthropic': anthropic,
  'google': google,
  'azure-openai': azure,
  'bedrock': bedrock,
};

function getAdapter(api) {
  const adapter = ADAPTERS[api];
  if (!adapter) throw new Error(`unsupported provider api "${api}"`);
  return adapter;
}

module.exports = {
  ADAPTERS,
  getAdapter,
};
