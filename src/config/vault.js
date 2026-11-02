'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';

function expand(value, env) {
  return String(value || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] || '');
}

function defaultDataDir(env = process.env) {
  if (env.ANY_CURSOR_DATA_DIR) return env.ANY_CURSOR_DATA_DIR;
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'AnyCursor');
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'anycursor');
  return path.join(os.homedir(), '.local', 'share', 'anycursor');
}

class Vault {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.keyPath = options.keyPath || path.join(dataDir, 'secrets', 'host.key');
    this.env = options.env || process.env;
    this.key = null;
    this.error = '';
    try {
      this.key = this.loadOrCreateKey();
    } catch (error) {
      this.error = String(error && error.message ? error.message : error);
    }
  }

  static forConfig(file, raw, env = process.env) {
    const configured = raw && raw.gateway && raw.gateway.dataDir
      ? expand(raw.gateway.dataDir, env)
      : defaultDataDir(env);
    const dataDir = path.isAbsolute(configured)
      ? configured
      : path.resolve(path.dirname(file), configured || '.');
    return new Vault(dataDir, { env });
  }

  loadOrCreateKey() {
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.keyPath)) {
      const key = fs.readFileSync(this.keyPath);
      if (key.length !== KEY_BYTES) throw new Error(`invalid host key length (${key.length})`);
      return key;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') {
      const user = process.env.USERNAME;
      if (user) {
        try {
          execFileSync('icacls', [this.keyPath, '/inheritance:r', '/grant:r', `${user}:F`], {
            windowsHide: true,
            stdio: 'pipe',
          });
        } catch (_) { /* best effort; the file is still user-scoped by default */ }
      }
    }
    return key;
  }

  get enabled() {
    return !!this.key;
  }

  encrypt(value) {
    if (!this.key || typeof value !== 'string' || !value) return value;
    if (value.startsWith(PREFIX)) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
  }

  decrypt(value) {
    if (!this.key || typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('invalid encrypted value');
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const body = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  transform(raw, mode) {
    const out = JSON.parse(JSON.stringify(raw || {}));
    const apply = (value) => (mode === 'encrypt' ? this.encrypt(value) : this.decrypt(value));
    const secretFields = ['apiKey', 'secretAccessKey', 'sessionToken'];
    for (const provider of Object.values(out.providers || {})) {
      if (!provider || typeof provider !== 'object') continue;
      for (const field of secretFields) {
        if (typeof provider[field] === 'string' && provider[field] && !/^\$\{[^}]+\}$/.test(provider[field])) {
          provider[field] = apply(provider[field]);
        }
      }
      if (provider.headers && typeof provider.headers === 'object') {
        for (const [name, value] of Object.entries(provider.headers)) {
          if (typeof value === 'string' && /authorization|api[-_]?key|token|secret/i.test(name)) {
            provider.headers[name] = apply(value);
          }
        }
      }
    }
    for (const model of out.models || []) {
      if (model && typeof model === 'object' && typeof model.apiKey === 'string' && model.apiKey && !/^\$\{[^}]+\}$/.test(model.apiKey)) {
        model.apiKey = apply(model.apiKey);
      }
    }
    if (out.gateway && typeof out.gateway.accessToken === 'string' && out.gateway.accessToken) {
      out.gateway.accessToken = apply(out.gateway.accessToken);
    }
    return out;
  }

  encryptConfig(raw) {
    return this.enabled ? this.transform(raw, 'encrypt') : raw;
  }

  decryptConfig(raw) {
    return this.enabled ? this.transform(raw, 'decrypt') : raw;
  }
}

module.exports = {
  Vault,
  PREFIX,
  ALGORITHM,
  defaultDataDir,
};
