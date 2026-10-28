'use strict';

/**
 * Azure OpenAI uses the OpenAI chat-completions wire format with a different
 * URL shape and api-key header.
 */

function buildAzureUrl(opts) {
  if (opts.endpoint && /^https?:\/\//.test(opts.endpoint) && /\/(openai|chat\/completions)/.test(opts.endpoint)) {
    return opts.endpoint;
  }
  const base = (opts.baseUrl || opts.endpoint || '').replace(/\/+$/, '');
  const deployment = opts.deployment || opts.modelId;
  const apiVersion = opts.apiVersion || '2024-10-21';
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

async function streamChat(opts, onEvent, signal) {
  const adapter = require('../gateway/adapter');
  const url = buildAzureUrl(opts);
  const headers = {
    ...(opts.headers || {}),
    'api-key': opts.apiKey || '',
  };
  return adapter.streamChat({
    ...opts,
    apiKey: '',
    endpoint: url,
    headers,
  }, onEvent, signal, undefined);
}

module.exports = {
  streamChat,
  buildAzureUrl,
};
