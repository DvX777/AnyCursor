'use strict';

const MODELS_DEV_URL = 'https://models.dev/api.json';

const LABELS = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

function effortEntries(reasoningOptions) {
  if (!reasoningOptions) return [];
  const list = Array.isArray(reasoningOptions) ? reasoningOptions : [reasoningOptions];
  return list.filter((item) => item && item.type === 'effort' && Array.isArray(item.values));
}

function effortTiers(modelEntry) {
  const tiers = [];
  const seen = new Set();
  for (const entry of effortEntries(modelEntry && modelEntry.reasoning_options)) {
    for (const value of entry.values) {
      const id = String(value || '').trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tiers.push({
        id,
        label: LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1),
        value: id,
      });
    }
  }
  return tiers;
}

function findModel(catalog, providerId, modelId) {
  const provider = catalog && catalog[providerId];
  if (!provider || !provider.models) return null;
  if (provider.models[modelId]) return provider.models[modelId];
  // Some catalogs use provider-prefixed ids.
  for (const [id, entry] of Object.entries(provider.models)) {
    if (id.endsWith(`/${modelId}`) || id.endsWith(`:${modelId}`) || id === modelId) return entry;
  }
  return null;
}

function enrichModel(model, catalog) {
  if (!model || !model.provider || !catalog) return null;
  const provider = model.providerConfig;
  const providerId = provider && (provider.modelsDevProvider || provider.id);
  if (!providerId) return null;
  const entry = findModel(catalog, providerId, model.model);
  if (!entry) return null;
  const tiers = effortTiers(entry);
  if (!tiers.length) return null;
  const previousDefault = model.effort && model.effort.default;
  const defaultId = tiers.some((tier) => tier.id === previousDefault)
    ? previousDefault
    : (tiers.some((tier) => tier.id === 'high') ? 'high' : tiers[0].id);
  return {
    ...model,
    effort: {
      tiers,
      default: defaultId,
      requestField: (model.effort && model.effort.requestField) || 'reasoning_effort',
    },
  };
}

async function fetchModelsDev(fetchImpl = fetch) {
  const res = await fetchImpl(MODELS_DEV_URL, {
    headers: { 'user-agent': 'anycursor/0.1' },
  });
  if (!res.ok) throw new Error(`models.dev ${res.status} ${res.statusText}`);
  return res.json();
}


/**
 * Normalise a models.dev entry into the fields the dashboard can apply.
 * @param {object} entry
 */
function describe(entry) {
  if (!entry) return null;
  const limit = entry.limit || {};
  const cost = entry.cost || {};
  const inputs = (entry.modalities && entry.modalities.input) || [];
  const tiers = effortTiers(entry);
  const options = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : (entry.reasoning_options ? [entry.reasoning_options] : []);
  const reasoningMode = tiers.length ? 'effort' : (options.some((o) => o && o.type === 'toggle') ? 'toggle' : (entry.reasoning ? 'flag' : 'none'));
  return {
    id: entry.id || '',
    name: entry.name || entry.id || '',
    family: entry.family || '',
    contextWindow: Number(limit.context) || 0,
    maxOutput: Number(limit.output) || 0,
    capabilities: {
      tools: entry.tool_call === true,
      vision: entry.attachment === true || inputs.includes('image'),
      reasoning: entry.reasoning === true,
      streaming: true,
      cache: cost.cache_read != null || cost.cache_write != null,
    },
    reasoningMode,
    effortTiers: tiers,
    effortDefault: tiers.some((tier) => tier.id === 'high')
      ? 'high'
      : (tiers.length ? tiers[0].id : ''),
  };
}

function enrichConfig(config, catalog) {
  const models = config.models.map((model) => {
    const provider = config.providers[model.provider] || {};
    const enriched = enrichModel({ ...model, providerConfig: provider }, catalog);
    return enriched || model;
  });
  return { ...config, models };
}

module.exports = {
  MODELS_DEV_URL,
  LABELS,
  effortTiers,
  findModel,
  enrichModel,
  enrichConfig,
  describe,
  fetchModelsDev,
};
