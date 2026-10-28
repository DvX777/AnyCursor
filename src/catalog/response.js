'use strict';

const zlib = require('zlib');
const { appendModels } = require('./available-models');

/**
 * Decode a possibly compressed AvailableModelsResponse, append AnyCursor
 * models, and re-encode with the same content-encoding.
 */
function transformCatalog(body, headers, models, selectedIds = []) {
  const encoding = String((headers && headers['content-encoding']) || '').toLowerCase().trim();
  let decoded = body;
  if (encoding === 'gzip') decoded = zlib.gunzipSync(body);
  else if (encoding === 'br') decoded = zlib.brotliDecompressSync(body);
  else if (encoding === 'deflate') decoded = zlib.inflateSync(body);
  else if (encoding) throw new Error(`unsupported content-encoding "${encoding}"`);

  const merged = appendModels(decoded, models || [], selectedIds);
  let out = merged;
  if (encoding === 'gzip') out = zlib.gzipSync(merged);
  else if (encoding === 'br') out = zlib.brotliCompressSync(merged);
  else if (encoding === 'deflate') out = zlib.deflateSync(merged);
  return { body: out, models: (models || []).length, encoding };
}

module.exports = { transformCatalog };
