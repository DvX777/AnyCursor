'use strict';

/**
 * Build lookup tables for configured models and resolve a Cursor model id to a
 * route. Unknown ids default to native passthrough so Cursor's own models keep
 * working even if the AnyCursor catalog is stale.
 */
function buildRegistry(config) {
  const byCursorId = new Map();
  const byId = new Map();

  for (const model of config.models) {
    if (model.enabled === false) continue;
    byCursorId.set(model.cursorId, model);
    byId.set(model.id, model);
  }

  function resolve(modelId) {
    if (byCursorId.has(modelId)) {
      return { route: 'byok', model: byCursorId.get(modelId) };
    }
    if (config.routing.nativePassthrough && config.routing.onUnknownModel === 'native') {
      return { route: 'native' };
    }
    return {
      route: 'error',
      reason: `unknown model "${modelId}" and native passthrough is disabled`,
    };
  }

  return {
    models: config.models,
    providers: config.providers,
    byCursorId,
    byId,
    resolve,
  };
}

/**
 * Metadata used when merging AnyCursor models into Cursor's AvailableModels
 * response. The native catalog renderer uses these fields for display names,
 * vendor labels, effort/context variants and capability toggles.
 */
function toCatalogMetadata(model) {
  const effortTiers = model.effort ? model.effort.tiers : [];
  return {
    name: model.cursorId,
    serverModelName: model.model,
    clientDisplayName: model.displayName,
    inputboxShortModelName: model.shortName,
    tagline: model.providerLabel,
    vendor: model.vendor || undefined,
    supportsAgent: model.capabilities.tools,
    supportsPlanMode: model.capabilities.tools,
    supportsThinking: model.capabilities.reasoning,
    supportsImages: model.capabilities.vision,
    supportsNonMaxMode: true,
    variants: effortTiers.map((tier) => ({
      id: tier.id,
      label: tier.label,
      value: tier.value,
    })),
    parameters: {
      effort: model.effort
        ? {
            supported: true,
            default: model.effort.default,
            options: effortTiers.map((tier) => ({ id: tier.id, label: tier.label })),
          }
        : { supported: false },
      context: model.contextOptions.length
        ? {
            supported: true,
            options: model.contextOptions.map((option) => ({
              id: option.id,
              label: option.label,
              value: option.value,
            })),
          }
        : { supported: false },
      fast: { supported: model.fast === true },
    },
  };
}

module.exports = {
  buildRegistry,
  toCatalogMetadata,
};
