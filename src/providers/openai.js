'use strict';

const adapter = require('../gateway/adapter');

async function streamChat(opts, onEvent, signal) {
  return adapter.streamChat(opts, onEvent, signal, opts.baseOverride);
}

module.exports = { streamChat };
