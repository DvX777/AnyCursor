'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER_TYPES = new Set([
  'openai-compatible',
  'anthropic',
  'google',
  'azure-openai',
  'bedrock',
]);

const GATEWAY_DEFAULTS = {
  host: '127.0.0.1',
  port: 43110,
  logLevel: 'info',
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultDataDir(env = process.env) {
  const base = env.LOCALAPPDATA
    || env.XDG_DATA_HOME
    || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'AnyCursor');
}

/**
 * Replace ${VAR} and ${VAR:-default} in strings. Missing variables become an
 * empty string and are reported as warnings; they never make the whole config
 * unreadable.
 */
function interpolate(value, env, warnings, keyPath = '') {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      if (env[name] !== undefined && env[name] !== '') return env[name];
      if (fallback !== undefined) return fallback;
      if (!/\.(apiKey|accessKeyId|secretAccessKey|sessionToken)$/.test(keyPath)) {
        warnings.push(`missing environment variable ${name}${keyPath ? ` at ${keyPath}` : ''}`);
      }
      return '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolate(item, env, warnings, `${keyPath}[${index}]`));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolate(v, env, warnings, keyPath ? `${keyPath}.${k}` : k);
    }
    return out;
  }
  return value;
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^anycursor\/+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'model';
}

function cursorModelId(provider, id) {
  return `anycursor/${slug(provider)}/${slug(id)}`;
}

function normalizeHeaders(headers) {
  if (!isPlainObject(headers)) return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

function normalizeProvider(name, raw, warnings) {
  if (!isPlainObject(raw)) throw new Error(`provider "${name}" must be an object`);
  if (!PROVIDER_TYPES.has(raw.type)) {
    throw new Error(`provider "${name}" has unsupported type "${raw.type}"`);
  }

  const provider = {
    id: name,
    type: raw.type,
    baseUrl: raw.baseUrl || '',
    endpoint: raw.endpoint || '',
    apiKey: raw.apiKey || '',
    headers: normalizeHeaders(raw.headers),
    query: isPlainObject(raw.query) ? { ...raw.query } : {},
    version: raw.version || '',
    deployment: raw.deployment || '',
    apiVersion: raw.apiVersion || '',
    region: raw.region || '',
    accessKeyId: raw.accessKeyId || '',
    secretAccessKey: raw.secretAccessKey || '',
    sessionToken: raw.sessionToken || '',
  };

  if (provider.type === 'azure-openai' && !provider.endpoint) {
    warnings.push(`provider "${name}" is azure-openai but has no endpoint`);
  }
  if (provider.type === 'bedrock' && !provider.region) {
    warnings.push(`provider "${name}" is bedrock but has no region`);
  }
  if (provider.type !== 'bedrock' && provider.type !== 'azure-openai' && !provider.baseUrl) {
    warnings.push(`provider "${name}" has no baseUrl`);
  }
  return provider;
}

function normalizeEffort(raw, warnings, context) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new Error(`${context}.effort must be an object`);
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) {
    throw new Error(`${context}.effort.tiers must be a non-empty array`);
  }

  const seen = new Set();
  const tiers = raw.tiers.map((tier, index) => {
    if (!isPlainObject(tier)) throw new Error(`${context}.effort.tiers[${index}] must be an object`);
    const id = String(tier.id || '').trim();
    if (!id) throw new Error(`${context}.effort.tiers[${index}].id is required`);
    if (seen.has(id)) throw new Error(`${context}.effort.tiers has duplicate id "${id}"`);
    seen.add(id);
    return {
      id,
      label: String(tier.label || id),
      value: tier.value === undefined ? id : tier.value,
    };
  });

  const fallback = String(raw.default || tiers[0].id);
  if (!seen.has(fallback)) {
    warnings.push(`${context}.effort.default "${fallback}" is not a listed tier; using "${tiers[0].id}"`);
  }

  return {
    tiers,
    default: seen.has(fallback) ? fallback : tiers[0].id,
    requestField: raw.requestField ? String(raw.requestField) : '',
  };
}

function normalizeContextOptions(raw, warnings, context) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${context}.contextOptions must be an array`);
  return raw.map((option, index) => {
    if (!isPlainObject(option)) throw new Error(`${context}.contextOptions[${index}] must be an object`);
    const id = String(option.id || '').trim();
    if (!id) throw new Error(`${context}.contextOptions[${index}].id is required`);
    if (option.value !== undefined && (!Number.isInteger(option.value) || option.value <= 0)) {
      warnings.push(`${context}.contextOptions[${index}].value must be a positive integer`);
    }
    return {
      id,
      label: String(option.label || id),
      value: Number.isInteger(option.value) && option.value > 0 ? option.value : undefined,
    };
  });
}

function normalizeCapabilities(raw) {
  const caps = isPlainObject(raw) ? raw : {};
  return {
    tools: caps.tools !== false,
    vision: caps.vision === true,
    reasoning: caps.reasoning === true,
    streaming: caps.streaming !== false,
    cache: caps.cache === true,
  };
}

function normalizeModel(raw, providers, warnings, index) {
  if (!isPlainObject(raw)) throw new Error(`models[${index}] must be an object`);
  const providerName = String(raw.provider || '').trim();
  if (!providerName) throw new Error(`models[${index}].provider is required`);
  const provider = providers[providerName];
  if (!provider) throw new Error(`models[${index}] references unknown provider "${providerName}"`);

  const modelName = String(raw.model || '').trim();
  if (!modelName) throw new Error(`models[${index}].model is required`);
  const displayName = String(raw.displayName || '').trim();
  if (!displayName) throw new Error(`models[${index}].displayName is required`);

  const api = raw.api || provider.type;
  if (!PROVIDER_TYPES.has(api)) {
    throw new Error(`models[${index}].api "${api}" is unsupported`);
  }

  const id = slug(raw.id || modelName);
  const context = `models[${index}]`;
  const effort = normalizeEffort(raw.effort, warnings, context);
  const contextOptions = normalizeContextOptions(raw.contextOptions, warnings, context);

  if (effort && !effort.tiers.some((tier) => tier.id === effort.default)) {
    effort.default = effort.tiers[0].id;
  }

  return {
    id,
    cursorId: cursorModelId(providerName, id),
    displayName,
    shortName: String(raw.shortName || displayName),
    providerLabel: String(raw.providerLabel || providerName),
    provider: providerName,
    model: modelName,
    api,
    baseUrl: raw.baseUrl || '',
    apiKey: raw.apiKey || '',
    endpoint: raw.endpoint || '',
    vendor: String(raw.vendor || ''),
    contextWindow: Number.isInteger(raw.contextWindow) && raw.contextWindow > 0 ? raw.contextWindow : undefined,
    maxOutput: Number.isInteger(raw.maxOutput) && raw.maxOutput > 0 ? raw.maxOutput : undefined,
    effort,
    contextOptions,
    fast: raw.fast === true,
    capabilities: normalizeCapabilities(raw.capabilities),
    pricing: {
      input: Number(raw.pricing && raw.pricing.input) || 0,
      output: Number(raw.pricing && raw.pricing.output) || 0,
      cacheRead: Number(raw.pricing && raw.pricing.cacheRead) || 0,
      cacheWrite: Number(raw.pricing && raw.pricing.cacheWrite) || 0,
    },
    order: Number.isInteger(raw.order) ? raw.order : index,
    enabled: raw.enabled !== false,
  };
}

/**
 * Validate and normalize a parsed config object.
 * Returns { config, warnings }.
 */
function normalizeConfig(raw, options = {}) {
  if (!isPlainObject(raw)) throw new Error('config must be a JSON object');
  const env = options.env || process.env;
  const warnings = [];
  const interpolated = interpolate(raw, env, warnings);

  if (!isPlainObject(interpolated.providers) || Object.keys(interpolated.providers).length === 0) {
    throw new Error('config.providers must contain at least one provider');
  }
  if (!Array.isArray(interpolated.models)) {
    throw new Error('config.models must be an array');
  }

  const gateway = {
    ...GATEWAY_DEFAULTS,
    ...(isPlainObject(interpolated.gateway) ? interpolated.gateway : {}),
  };
  const port = Number(gateway.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('config.gateway.port must be an integer between 1 and 65535');
  }
  gateway.port = port;
  gateway.dataDir = gateway.dataDir || defaultDataDir(env);

  const providers = {};
  for (const [name, provider] of Object.entries(interpolated.providers)) {
    providers[name] = normalizeProvider(name, provider, warnings);
  }

  const models = [];
  const cursorIds = new Map();
  for (const [index, rawModel] of interpolated.models.entries()) {
    const model = normalizeModel(rawModel, providers, warnings, index);
    if (cursorIds.has(model.cursorId)) {
      throw new Error(`duplicate model id "${model.cursorId}" (also used by ${cursorIds.get(model.cursorId)})`);
    }
    cursorIds.set(model.cursorId, model.id);
    models.push(model);
  }

  models.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
  for (const [index, model] of models.entries()) model.order = index;

  const cursor = {
    restartPolicy: 'ask',
    patchShortcuts: true,
    ...(isPlainObject(interpolated.cursor) ? interpolated.cursor : {}),
  };
  cursor.backendUrl = cursor.backendUrl || `http://${gateway.host}:${gateway.port}`;

  const routing = {
    nativePassthrough: true,
    onUnknownModel: 'native',
    defaultModel: '',
    ...(isPlainObject(interpolated.routing) ? interpolated.routing : {}),
  };
  if (routing.onUnknownModel !== 'native' && routing.onUnknownModel !== 'error') {
    throw new Error('config.routing.onUnknownModel must be "native" or "error"');
  }
  if (routing.defaultModel && !cursorIds.has(routing.defaultModel)) {
    throw new Error(`config.routing.defaultModel "${routing.defaultModel}" is not a configured model`);
  }

  return {
    config: {
      gateway,
      cursor,
      routing,
      providers,
      models,
    },
    warnings,
  };
}

function loadConfig(file, options = {}) {
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
  return normalizeConfig(raw, options);
}

module.exports = {
  PROVIDER_TYPES,
  GATEWAY_DEFAULTS,
  defaultDataDir,
  interpolate,
  slug,
  cursorModelId,
  normalizeConfig,
  loadConfig,
};
