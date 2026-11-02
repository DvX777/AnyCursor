'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeConfig } = require('./load');
const { createSecretStore, targetName } = require('./secrets');
const { Vault, ALGORITHM } = require('./vault');

const PROVIDER_SECRETS = [
  ['apiKey', 'apiKeyRef'],
  ['secretAccessKey', 'secretAccessKeyRef'],
  ['sessionToken', 'sessionTokenRef'],
];
const MODEL_SECRETS = [['apiKey', 'apiKeyRef']];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isEnv(value) {
  return typeof value === 'string' && /^\$\{[^}]+\}$/.test(value.trim());
}

function targetFor(scope, name, field) {
  return targetName(scope, name, field);
}

function resolveSecrets(raw, store) {
  const out = clone(raw || {});
  if (!store) return out;
  for (const [name, provider] of Object.entries(out.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    for (const [field, refField] of PROVIDER_SECRETS) {
      if (provider[field] || !provider[refField]) continue;
      provider[field] = store.get(provider[refField]) || '';
    }
  }
  for (const model of out.models || []) {
    if (!model || typeof model !== 'object') continue;
    for (const [field, refField] of MODEL_SECRETS) {
      if (model[field] || !model[refField]) continue;
      model[field] = store.get(model[refField]) || '';
    }
  }
  return out;
}

function extractSecrets(raw, store) {
  const out = clone(raw || {});
  if (!store) return out;
  for (const [name, provider] of Object.entries(out.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    for (const [field, refField] of PROVIDER_SECRETS) {
      const value = provider[field];
      delete provider[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`];
      if (value && !isEnv(value)) {
        const target = targetFor('provider', name, field);
        store.set(target, value);
        delete provider[field];
        provider[refField] = target;
      }
      delete provider[`clear${field.charAt(0).toUpperCase()}${field.slice(1)}`];
    }
  }
  for (const model of out.models || []) {
    if (!model || typeof model !== 'object') continue;
    for (const [field, refField] of MODEL_SECRETS) {
      const value = model[field];
      delete model.hasApiKey;
      if (value && !isEnv(value)) {
        const target = targetFor('model', model.id || model.model || 'model', field);
        store.set(target, value);
        delete model[field];
        model[refField] = target;
      }
      delete model.clearApiKey;
    }
  }
  return out;
}

function redactRaw(raw, store) {
  const out = clone(raw || {});
  if (out.gateway && typeof out.gateway === 'object') {
    out.gateway.accessToken = '';
    if (Array.isArray(out.gateway.grants)) {
      out.gateway.grants = out.gateway.grants.map((grant) => (
        grant && typeof grant === 'object' ? { ...grant, tokenHash: '' } : grant
      ));
    }
  }
  for (const [name, provider] of Object.entries(out.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    const storedKey = provider.apiKeyRef && store ? store.get(provider.apiKeyRef) : '';
    provider.hasApiKey = !!(provider.apiKey || storedKey);
    provider.apiKey = '';
    const storedSecret = provider.secretAccessKeyRef && store ? store.get(provider.secretAccessKeyRef) : '';
    if (provider.secretAccessKey || storedSecret) provider.hasSecretAccessKey = true;
    provider.secretAccessKey = '';
    const storedSession = provider.sessionTokenRef && store ? store.get(provider.sessionTokenRef) : '';
    if (provider.sessionToken || storedSession) provider.hasSessionToken = true;
    provider.sessionToken = '';
  }
  for (const model of out.models || []) {
    if (!model || typeof model !== 'object') continue;
    const stored = model.apiKeyRef && store ? store.get(model.apiKeyRef) : '';
    const hadKey = !!(model.apiKey || stored);
    if (hadKey) model.hasApiKey = true;
    model.apiKey = '';
    if (hadKey && !model.apiKeyRef) model.apiKeyRef = targetFor('model', model.id || model.model || 'model', 'apiKey');
  }
  return out;
}

function mergeSecrets(next, previous) {
  const out = clone(next || {});
  if (out.gateway && typeof out.gateway === 'object' && previous && previous.gateway) {
    if (!out.gateway.accessToken && previous.gateway.accessToken) {
      out.gateway.accessToken = previous.gateway.accessToken;
    }
    const nextGrants = out.gateway.grants;
    const invalidGrants = !Array.isArray(nextGrants) || nextGrants.some((grant) => !grant || !grant.tokenHash);
    if (invalidGrants && Array.isArray(previous.gateway.grants)) {
      out.gateway.grants = clone(previous.gateway.grants);
    }
  }
  for (const [name, provider] of Object.entries(out.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    const old = previous && previous.providers && previous.providers[name];
    for (const [field, refField] of PROVIDER_SECRETS) {
      const clearField = `clear${field.charAt(0).toUpperCase()}${field.slice(1)}`;
      const clear = provider[clearField] === true;
      if (clear) {
        delete provider[field];
        delete provider[refField];
      } else {
        if (!provider[field]) {
          if (old && old[field]) provider[field] = old[field];
          else if (old && old[refField]) provider[refField] = old[refField];
        }
      }
      delete provider[clearField];
      delete provider[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`];
    }
  }
  const previousModels = (previous && Array.isArray(previous.models)) ? previous.models : [];
  for (const model of (out.models || [])) {
    if (!model || typeof model !== 'object') continue;
    const old = previousModels.find((candidate) => candidate && (
      (model.id && candidate.id === model.id)
      || (model.model && candidate.model === model.model)
    ));
    if (model.clearApiKey === true) {
      delete model.apiKey;
      delete model.apiKeyRef;
    } else if (!model.apiKey) {
      if (old && old.apiKey) model.apiKey = old.apiKey;
      else if (old && old.apiKeyRef) model.apiKeyRef = old.apiKeyRef;
    }
    delete model.clearApiKey;
    delete model.hasApiKey;
  }
  return out;
}

class ConfigService {
  constructor(file, options = {}) {
    this.file = file;
    this.secrets = options.secrets === undefined ? createSecretStore() : options.secrets;
    this.vault = null;
    this.encryption = { enabled: false, algorithm: ALGORITHM };
    this.encryptionError = '';
    this.raw = null;
    this.config = null;
    this.warnings = [];
    this.error = '';
    this.load();
  }

  load() {
    this.encryptionError = '';
    try {
      const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(text);
      this.vault = Vault.forConfig(this.file, raw);
      let diskRaw = raw;
      if (this.vault.enabled) {
        try {
          const encrypted = this.vault.encryptConfig(raw);
          if (JSON.stringify(encrypted) !== JSON.stringify(raw)) {
            const backup = `${this.file}.${Date.now()}.encryption.bak`;
            fs.copyFileSync(this.file, backup);
            const temp = `${this.file}.${process.pid}.enc.tmp`;
            fs.writeFileSync(temp, JSON.stringify(encrypted, null, 2) + '\n');
            fs.renameSync(temp, this.file);
            diskRaw = encrypted;
          }
        } catch (error) {
          this.encryptionError = String(error && error.message ? error.message : error);
        }
      }
      const effectiveRaw = this.vault.enabled ? this.vault.decryptConfig(diskRaw) : diskRaw;
      const loaded = normalizeConfig(resolveSecrets(effectiveRaw, this.secrets));
      if (!this.secrets) {
        loaded.warnings.unshift(this.vault.enabled
          ? 'Windows Credential Manager is unavailable; secrets are encrypted at rest with the host key'
          : 'Windows Credential Manager is unavailable; secrets remain in the config file');
      }
      if (this.encryptionError) {
        loaded.warnings.unshift(`Secret encryption warning: ${this.encryptionError}`);
      }
      this.raw = diskRaw;
      this.config = loaded.config;
      this.warnings = loaded.warnings;
      this.error = '';
      this.encryption = {
        enabled: this.vault.enabled && !this.encryptionError,
        algorithm: ALGORITHM,
        keyPath: this.vault.enabled ? this.vault.keyPath : '',
      };
      return loaded;
    } catch (error) {
      this.error = String(error && error.message ? error.message : error);
      return null;
    }
  }

  redacted() {
    return {
      path: this.file,
      config: redactRaw(this.raw || {}, this.secrets),
      warnings: this.warnings,
      error: this.error,
      encryption: { enabled: this.encryption.enabled, algorithm: this.encryption.algorithm },
    };
  }

  save(nextRaw) {
    if (!nextRaw || typeof nextRaw !== 'object') throw new Error('config must be an object');
    const previous = this.vault && this.vault.enabled ? this.vault.decryptConfig(this.raw || {}) : (this.raw || {});
    const merged = mergeSecrets(nextRaw, previous);
    let persisted = extractSecrets(merged, this.secrets);
    if (this.vault && this.vault.enabled) persisted = this.vault.encryptConfig(persisted);
    const effective = this.vault && this.vault.enabled ? this.vault.decryptConfig(persisted) : persisted;
    const loaded = normalizeConfig(resolveSecrets(effective, this.secrets)); // validate before writing
    const backup = `${this.file}.${Date.now()}.bak`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, backup);
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(persisted, null, 2) + '\n');
    fs.renameSync(temp, this.file);
    this.raw = persisted;
    this.config = loaded.config;
    this.warnings = loaded.warnings;
    this.error = '';
    this.encryption = {
      enabled: !!this.vault && this.vault.enabled,
      algorithm: ALGORITHM,
      keyPath: this.vault && this.vault.enabled ? this.vault.keyPath : '',
    };
    return { config: this.config, warnings: this.warnings, backup };
  }

  mutate(mutator) {
    if (typeof mutator !== 'function') throw new Error('mutator must be a function');
    const previous = this.vault && this.vault.enabled ? this.vault.decryptConfig(this.raw || {}) : clone(this.raw || {});
    mutator(previous);
    return this.save(previous);
  }
}

module.exports = {
  ConfigService,
  redactRaw,
  mergeSecrets,
  resolveSecrets,
  extractSecrets,
};
