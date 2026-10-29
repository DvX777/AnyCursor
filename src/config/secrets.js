'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const TARGET_PREFIX = 'AnyCursor';

function safePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function targetName(scope, name, field) {
  return `${TARGET_PREFIX}/${safePart(scope)}/${safePart(name)}/${safePart(field)}`;
}

function compilerPath() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

class CredentialStore {
  constructor(options = {}) {
    this.binDir = options.binDir || path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'AnyCursor',
      'bin',
    );
    this.exe = path.join(this.binDir, 'AnyCursor.Credentials.exe');
    this.source = options.source || path.join(__dirname, '..', '..', 'scripts', 'credential-helper.cs');
    this.cache = new Map();
    this.available = process.platform === 'win32';
  }

  ensureHelper() {
    if (!this.available) throw new Error('Windows Credential Manager is only available on Windows');
    if (fs.existsSync(this.exe)) return this.exe;
    const csc = compilerPath();
    if (!csc) throw new Error('C# compiler not found for the credential helper');
    if (!fs.existsSync(this.source)) throw new Error(`credential helper source missing: ${this.source}`);
    fs.mkdirSync(this.binDir, { recursive: true });
    execFileSync(csc, ['/nologo', '/target:exe', `/out:${this.exe}`, this.source], {
      windowsHide: true,
      stdio: 'pipe',
    });
    if (!fs.existsSync(this.exe)) throw new Error('credential helper compilation failed');
    return this.exe;
  }

  get(target) {
    if (this.cache.has(target)) return this.cache.get(target);
    let value = '';
    try {
      const result = spawnSync(this.ensureHelper(), ['get', target], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (result.status === 0) value = result.stdout || '';
    } catch (_) {
      value = '';
    }
    this.cache.set(target, value);
    return value;
  }

  set(target, value) {
    const secret = String(value ?? '');
    if (!secret) return this.delete(target);
    const result = spawnSync(this.ensureHelper(), ['set', target], {
      input: secret,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status !== 0) {
      throw new Error(`failed to store credential ${target}: ${result.error || result.stderr || result.status}`);
    }
    this.cache.set(target, secret);
  }

  delete(target) {
    try {
      spawnSync(this.ensureHelper(), ['delete', target], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
    } catch (_) { /* best effort */ }
    this.cache.delete(target);
  }
}

class MemoryStore {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  get(target) { return this.values.get(target) || ''; }
  set(target, value) {
    if (value) this.values.set(target, String(value));
    else this.values.delete(target);
  }
  delete(target) { this.values.delete(target); }
}

function createSecretStore(options = {}) {
  if (process.platform !== 'win32') return null;
  try {
    const store = new CredentialStore(options);
    store.ensureHelper();
    return store;
  } catch (error) {
    return null;
  }
}

module.exports = {
  CredentialStore,
  MemoryStore,
  createSecretStore,
  targetName,
  TARGET_PREFIX,
};
