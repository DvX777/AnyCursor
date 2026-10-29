'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const DEFAULT_CONFIG = path.join(
  process.env.LOCALAPPDATA || process.env.USERPROFILE || '',
  'AnyCursor',
  'config.json',
);

let statusItem;
let healthTimer;
let starting = false;
let lastStartAt = 0;

function configPath() {
  if (process.env.ANY_CURSOR_CONFIG) return process.env.ANY_CURSOR_CONFIG;
  const local = DEFAULT_CONFIG;
  if (fs.existsSync(local)) return local;
  const dev = path.join(__dirname, '..', '..', 'config', 'anycursor.json');
  if (fs.existsSync(dev)) return dev;
  return local;
}

function readConfig() {
  const file = configPath();
  try {
    return { file, config: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { file, config: null, error: String(error && error.message ? error.message : error) };
  }
}

function health(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(body) }); }
        catch (_) { resolve({ ok: false, status: res.statusCode, body: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => resolve({ ok: false, error: String(error.message || error) }));
  });
}

function gatewayPath() {
  if (process.env.ANY_CURSOR_GATEWAY) return process.env.ANY_CURSOR_GATEWAY;
  const packaged = path.join(__dirname, '..', 'vendor', 'anycursor', 'src', 'gateway', 'index.js');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'src', 'gateway', 'index.js');
}

function startGateway(config) {
  const node = process.env.ANY_CURSOR_NODE || 'node';
  const script = gatewayPath();
  const cwd = path.join(path.dirname(script), '..', '..');
  const env = { ...process.env };
  const child = spawn(node, [script, '--config', configPath()], {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function setStatus(text, tooltip, state = 'ok') {
  if (!statusItem) return;
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.show();
  statusItem.color = state === 'error' ? new vscode.ThemeColor('statusBarItem.errorForeground') : undefined;
}

async function ensureGateway(force = false) {
  const { file, config, error } = readConfig();
  if (!config) {
    setStatus('AnyCursor: no config', `Create ${file}`, 'error');
    return { ok: false, reason: error || 'config missing', file };
  }

  const host = (config.gateway && config.gateway.host) || '127.0.0.1';
  const port = (config.gateway && config.gateway.port) || 43110;
  const current = await health(host, port);
  if (current.ok) {
    setStatus('AnyCursor: ready', `Gateway ${host}:${port}\nConfig: ${file}`);
    return { ok: true, host, port, health: current.body, file };
  }

  if (starting) return { ok: false, reason: 'starting', host, port, file };
  if (!force && Date.now() - lastStartAt < 5000) {
    setStatus('AnyCursor: starting', `Waiting for ${host}:${port}`);
    return { ok: false, reason: 'backoff', host, port, file };
  }

  starting = true;
  lastStartAt = Date.now();
  try {
    startGateway(config);
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const check = await health(host, port);
      if (check.ok) {
        setStatus('AnyCursor: ready', `Gateway ${host}:${port}\nConfig: ${file}`);
        return { ok: true, host, port, health: check.body, file };
      }
    }
    setStatus('AnyCursor: offline', `Gateway did not start on ${host}:${port}`, 'error');
    return { ok: false, reason: 'startup timeout', host, port, file };
  } finally {
    starting = false;
  }
}

async function openSettings() {
  const result = await ensureGateway();
  if (!result.ok) {
    vscode.window.showErrorMessage(`AnyCursor is not ready: ${result.reason || 'unknown error'}`);
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(`http://${result.host}:${result.port}/`));
}

async function openConfigFile() {
  const { file, error } = readConfig();
  if (!fs.existsSync(file)) {
    vscode.window.showErrorMessage(`AnyCursor config not found: ${file}${error ? ` (${error})` : ''}`);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
}

async function doctor() {
  const { file, config, error } = readConfig();
  const result = await ensureGateway(true);
  const lines = [
    `Config: ${file}`,
    `Config loaded: ${config ? 'yes' : 'no'}`,
    error ? `Config error: ${error}` : '',
    `Gateway script: ${gatewayPath()}`,
    `Gateway: ${result.ok ? 'ready' : (result.reason || 'offline')}`,
    result.health ? `Models: ${result.health.models ? result.health.models.length : 0}` : '',
    result.health && result.health.warnings && result.health.warnings.length
      ? `Warnings: ${result.health.warnings.join('; ')}`
      : '',
  ].filter(Boolean);
  vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

function repairShortcuts() {
  const script = path.join(path.dirname(gatewayPath()), '..', '..', 'scripts', 'repair-shortcuts.ps1');
  if (!fs.existsSync(script)) {
    vscode.window.showErrorMessage(`Shortcut repair script not found: ${script}`);
    return;
  }
  const { file, config } = readConfig();
  const port = String((config && config.gateway && config.gateway.port) || 43110);
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', port, '-Config', file],
    { windowsHide: true, timeout: 120000 },
    (error, stdout, stderr) => {
      if (error) {
        vscode.window.showErrorMessage(`Shortcut repair failed: ${stderr || error.message}`);
        return;
      }
      vscode.window.showInformationMessage(stdout.trim() || 'Cursor shortcuts updated.');
    },
  );
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusItem.command = 'anycursor.openSettings';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('anycursor.openSettings', openSettings),
    vscode.commands.registerCommand('anycursor.openConfigFile', openConfigFile),
    vscode.commands.registerCommand('anycursor.doctor', doctor),
    vscode.commands.registerCommand('anycursor.startGateway', () => ensureGateway(true)),
    vscode.commands.registerCommand('anycursor.repairShortcuts', repairShortcuts),
  );

  ensureGateway().catch((error) => {
    setStatus('AnyCursor: error', String(error), 'error');
  });

  healthTimer = setInterval(() => {
    ensureGateway().catch(() => {});
  }, 10000);
  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });
}

function deactivate() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = undefined;
}

module.exports = { activate, deactivate };
