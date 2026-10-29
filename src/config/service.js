'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeConfig } = require('./load');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function redactRaw(raw) {
  const out = clone(raw || {});
  for (const provider of Object.values(out.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    provider.hasApiKey = !!(provider.apiKey && String(provider.apiKey).trim());
    provider.apiKey = '';
    if (provider.secretAccessKey) {
      provider.hasSecretAccessKey = true;
      provider.secretAccessKey = '';
    }
    if (provider.sessionToken) {
      provider.hasSessionToken = true;
      provider.sessionToken = '';
    }
  }
  for (const model of out.models || []) {
    if (model && model.apiKey) {
      model.hasApiKey = true;
      model.apiKey = '';
    }
  }
  return out;
}

function mergeSecrets(next, previous) {
  const out = clone(next || {});
  for (const [name, provider] of Object.entries(out.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    const old = previous && previous.providers && previous.providers[name];
    const clearKey = provider.clearApiKey === true;
    const clearSecret = provider.clearSecretAccessKey === true;
    const clearSession = provider.clearSessionToken === true;
    if (clearKey) delete provider.apiKey;
    else if (old && !provider.apiKey && old.apiKey) provider.apiKey = old.apiKey;
    if (clearSecret) delete provider.secretAccessKey;
    else if (old && !provider.secretAccessKey && old.secretAccessKey) provider.secretAccessKey = old.secretAccessKey;
    if (clearSession) delete provider.sessionToken;
    else if (old && !provider.sessionToken && old.sessionToken) provider.sessionToken = old.sessionToken;
    delete provider.clearApiKey;
    delete provider.clearSecretAccessKey;
    delete provider.clearSessionToken;
    delete provider.hasApiKey;
    delete provider.hasSecretAccessKey;
    delete provider.hasSessionToken;
  }
  const previousModels = (previous && Array.isArray(previous.models)) ? previous.models : [];
  for (const model of (out.models || [])) {
    if (!model || typeof model !== 'object') continue;
    const old = previousModels.find((candidate) => candidate && (
      (model.id && candidate.id === model.id)
      || (model.model && candidate.model === model.model)
    ));
    if (model.clearApiKey === true) delete model.apiKey;
    else if (old && !model.apiKey && old.apiKey) model.apiKey = old.apiKey;
    delete model.clearApiKey;
    delete model.hasApiKey;
  }
  return out;
}

class ConfigService {
  constructor(file) {
    this.file = file;
    this.raw = null;
    this.config = null;
    this.warnings = [];
    this.error = '';
    this.load();
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(text);
      const loaded = normalizeConfig(raw);
      this.raw = raw;
      this.config = loaded.config;
      this.warnings = loaded.warnings;
      this.error = '';
      return loaded;
    } catch (error) {
      this.error = String(error && error.message ? error.message : error);
      return null;
    }
  }

  redacted() {
    return {
      path: this.file,
      config: redactRaw(this.raw || {}),
      warnings: this.warnings,
      error: this.error,
    };
  }

  save(nextRaw) {
    if (!nextRaw || typeof nextRaw !== 'object') throw new Error('config must be an object');
    const merged = mergeSecrets(nextRaw, this.raw || {});
    const loaded = normalizeConfig(merged); // validate before writing
    const backup = `${this.file}.${Date.now()}.bak`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, backup);
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(merged, null, 2) + '\n');
    fs.renameSync(temp, this.file);
    this.raw = merged;
    this.config = loaded.config;
    this.warnings = loaded.warnings;
    this.error = '';
    return { config: this.config, warnings: this.warnings, backup };
  }
}

module.exports = {
  ConfigService,
  redactRaw,
  mergeSecrets,
};
