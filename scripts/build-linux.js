#!/usr/bin/env node
'use strict';

/*
 * Builds AnyCursor Linux packages (.deb and .rpm) without Docker or a Linux
 * host. It downloads the official Node.js Linux binary and nFPM, stages a
 * root filesystem, renders the nFPM config and writes artifacts to dist/.
 *
 * Usage:
 *   node scripts/build-linux.js
 *   node scripts/build-linux.js --arch amd64,arm64 --packagers deb,rpm
 *   node scripts/build-linux.js --version 0.6.0 --node 24.22.2
 *
 * Environment:
 *   NFPM=/path/to/nfpm              use an existing nFPM binary
 *   ANY_CURSOR_MAINTAINER="Name <mail>"  package maintainer
 *   ANY_CURSOR_NODE_VERSION=24.22.2       bundled Node version
 *   NFPM_VERSION=2.48.0                   nFPM version to download
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUILD_DIR = path.join(ROOT, 'build', 'linux');
const CACHE_DIR = path.join(ROOT, '.cache', 'linux');
const DIST_DIR = path.join(ROOT, 'dist');

const NODE_VERSION = process.env.ANY_CURSOR_NODE_VERSION || '24.22.2';
const NFPM_VERSION = process.env.NFPM_VERSION || '2.48.0';
const MAINTAINER = process.env.ANY_CURSOR_MAINTAINER
  || 'Engram Labs Inc. <dev_docnt@proton.me>';
const HOMEPAGE = process.env.ANY_CURSOR_HOMEPAGE
  || 'https://github.com/Engram-Labs-Inc/AnyCursor';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const VERSION = arg('version', PKG.version);
const ARCHES = arg('arch', 'amd64').split(',').map((s) => s.trim()).filter(Boolean);
const PACKAGERS = arg('packagers', 'deb,rpm').split(',').map((s) => s.trim()).filter(Boolean);

function fail(message) {
  console.error(`build-linux: ${message}`);
  process.exit(1);
}

if (!/^[0-9]/.test(VERSION)) fail(`version must start with a digit: ${VERSION}`);
for (const arch of ARCHES) {
  if (arch !== 'amd64' && arch !== 'arm64') fail(`unsupported arch: ${arch}`);
}
for (const packager of PACKAGERS) {
  if (packager !== 'deb' && packager !== 'rpm') fail(`unsupported packager: ${packager}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const request = https.get(url, { headers: { 'user-agent': 'anycursor-build' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return download(new URL(response.headers.location, url).href, dest, redirects + 1)
          .then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`GET ${url} -> ${response.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    request.setTimeout(120000, () => request.destroy(new Error(`timeout: ${url}`)));
    request.on('error', reject);
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match) map.set(match[2], match[1].toLowerCase());
  }
  return map;
}

async function cachedDownload(url, dest, checksum) {
  if (fs.existsSync(dest)) {
    if (!checksum || sha256(dest) === checksum) return dest;
    fs.rmSync(dest, { force: true });
  }
  console.log(`download ${url}`);
  await download(url, dest);
  if (checksum) {
    const actual = sha256(dest);
    if (actual !== checksum) {
      fs.rmSync(dest, { force: true });
      throw new Error(`checksum mismatch for ${path.basename(dest)}: ${actual} != ${checksum}`);
    }
  }
  return dest;
}

function extract(archive, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  run('tar', ['-xf', archive, '-C', dest]);
}

function hostPlatformAsset(version, platform, arch) {
  if (platform === 'win32') return `nfpm_${version}_Windows_x86_64.zip`;
  if (platform === 'darwin') return `nfpm_${version}_Darwin_${arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`;
  return `nfpm_${version}_Linux_${arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`;
}

async function ensureNfpm() {
  if (process.env.NFPM) {
    if (!fs.existsSync(process.env.NFPM)) fail(`NFPM does not exist: ${process.env.NFPM}`);
    return process.env.NFPM;
  }
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['nfpm'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch (_) { /* download below */ }

  const asset = hostPlatformAsset(NFPM_VERSION, process.platform, process.arch);
  const base = `https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}`;
  const checksumsPath = path.join(CACHE_DIR, 'nfpm', `checksums-${NFPM_VERSION}.txt`);
  const checksums = parseChecksums(
    fs.existsSync(checksumsPath)
      ? fs.readFileSync(checksumsPath, 'utf8')
      : await (async () => {
          await cachedDownload(`${base}/checksums.txt`, checksumsPath);
          return fs.readFileSync(checksumsPath, 'utf8');
        })(),
  );
  const expected = checksums.get(asset);
  if (!expected) fail(`no checksum for ${asset}`);

  const archive = path.join(CACHE_DIR, 'nfpm', asset);
  await cachedDownload(`${base}/${asset}`, archive, expected);
  const dir = path.join(CACHE_DIR, 'nfpm', NFPM_VERSION);
  const binary = path.join(dir, process.platform === 'win32' ? 'nfpm.exe' : 'nfpm');
  if (!fs.existsSync(binary)) {
    extract(archive, dir);
    const found = findFile(dir, process.platform === 'win32' ? 'nfpm.exe' : 'nfpm');
    if (!found) fail(`nfpm binary not found in ${archive}`);
    if (found !== binary) fs.copyFileSync(found, binary);
    fs.chmodSync(binary, 0o755);
  }
  return binary;
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    }
  }
  return null;
}

async function ensureNode(arch) {
  const nodeArch = arch === 'arm64' ? 'arm64' : 'x64';
  const tarballName = `node-v${NODE_VERSION}-linux-${nodeArch}.tar.gz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const shasumsPath = path.join(CACHE_DIR, 'node', `SHASUMS256-${NODE_VERSION}.txt`);
  const shasums = parseChecksums(
    fs.existsSync(shasumsPath)
      ? fs.readFileSync(shasumsPath, 'utf8')
      : await (async () => {
          await cachedDownload(`${base}/SHASUMS256.txt`, shasumsPath);
          return fs.readFileSync(shasumsPath, 'utf8');
        })(),
  );
  const expected = shasums.get(tarballName);
  if (!expected) fail(`no checksum for ${tarballName}`);

  const archive = path.join(CACHE_DIR, 'node', tarballName);
  await cachedDownload(`${base}/${tarballName}`, archive, expected);
  const dir = path.join(CACHE_DIR, 'node', `v${NODE_VERSION}-${arch}`);
  const node = path.join(dir, 'bin', 'node');
  const license = path.join(dir, 'LICENSE');
  if (!fs.existsSync(node) || !fs.existsSync(license)) {
    const temp = path.join(CACHE_DIR, 'node', `extract-${arch}`);
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(temp, { recursive: true });
    run('tar', [
      '-xzf', archive, '-C', temp, '--strip-components=1',
      `node-v${NODE_VERSION}-linux-${nodeArch}/bin/node`,
      `node-v${NODE_VERSION}-linux-${nodeArch}/LICENSE`,
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(temp, 'bin', 'node'), node);
    fs.copyFileSync(path.join(temp, 'LICENSE'), license);
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(node, 0o755);
  return { node, license };
}

function copyTree(src, dst, skip = new Set()) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to, skip);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function stageRootfs(arch, nodeFiles) {
  const rootfs = path.join(BUILD_DIR, `rootfs-${arch}`);
  fs.rmSync(rootfs, { recursive: true, force: true });
  const app = path.join(rootfs, 'app');
  const nodeDir = path.join(rootfs, 'node');
  const doc = path.join(rootfs, 'doc');
  fs.mkdirSync(path.join(app, 'config'), { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(doc, { recursive: true });
  fs.mkdirSync(path.join(rootfs, 'systemd'), { recursive: true });
  fs.mkdirSync(path.join(rootfs, 'sysusers'), { recursive: true });
  fs.mkdirSync(path.join(rootfs, 'tmpfiles'), { recursive: true });

  for (const name of ['src', 'public', 'schema']) {
    copyTree(path.join(ROOT, name), path.join(app, name));
  }
  for (const name of ['package.json', 'README.md', 'LICENSE']) {
    fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  }
  fs.copyFileSync(
    path.join(ROOT, 'packaging', 'config', 'anycursor.linux.example.json'),
    path.join(app, 'config', 'anycursor.linux.example.json'),
  );
  fs.copyFileSync(
    path.join(ROOT, 'packaging', 'config', 'anycursor.env.example'),
    path.join(app, 'config', 'anycursor.env.example'),
  );

  fs.copyFileSync(nodeFiles.node, path.join(nodeDir, 'node'));
  fs.copyFileSync(nodeFiles.license, path.join(nodeDir, 'LICENSE'));

  fs.copyFileSync(
    path.join(ROOT, 'packaging', 'systemd', 'anycursor.service'),
    path.join(rootfs, 'systemd', 'anycursor.service'),
  );
  fs.copyFileSync(
    path.join(ROOT, 'packaging', 'sysusers', 'anycursor.conf'),
    path.join(rootfs, 'sysusers', 'anycursor.conf'),
  );
  fs.copyFileSync(
    path.join(ROOT, 'packaging', 'tmpfiles', 'anycursor.conf'),
    path.join(rootfs, 'tmpfiles', 'anycursor.conf'),
  );

  fs.copyFileSync(path.join(ROOT, 'deploy', 'linux', 'README.md'), path.join(doc, 'README.linux.md'));
  fs.copyFileSync(path.join(ROOT, 'SECURITY.md'), path.join(doc, 'SECURITY.md'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(doc, 'LICENSE'));

  return rootfs;
}

function renderNfpm(arch, rootfs) {
  const template = fs.readFileSync(path.join(ROOT, 'packaging', 'nfpm.yaml'), 'utf8');
  const rendered = template
    .replaceAll('__ARCH__', arch)
    .replaceAll('__VERSION__', VERSION)
    .replaceAll('__MAINTAINER__', MAINTAINER)
    .replaceAll('__HOMEPAGE__', HOMEPAGE)
    .replaceAll('__ROOTFS__', rootfs.replace(/\\/g, '/'))
    .replaceAll('__SCRIPTS__', path.join(ROOT, 'packaging', 'scripts').replace(/\\/g, '/'));
  const file = path.join(BUILD_DIR, `nfpm-${arch}.yaml`);
  fs.writeFileSync(file, rendered);
  return file;
}

function filesSnapshot() {
  if (!fs.existsSync(DIST_DIR)) return new Set();
  return new Set(fs.readdirSync(DIST_DIR));
}

async function main() {
  console.log(`AnyCursor Linux build ${VERSION}`);
  console.log(`arches: ${ARCHES.join(', ')} | packagers: ${PACKAGERS.join(', ')} | node: ${NODE_VERSION}`);
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const nfpm = await ensureNfpm();
  console.log(`nfpm: ${nfpm}`);

  for (const arch of ARCHES) {
    console.log(`\n[${arch}] staging`);
    const nodeFiles = await ensureNode(arch);
    const rootfs = stageRootfs(arch, nodeFiles);
    const config = renderNfpm(arch, rootfs);

    for (const packager of PACKAGERS) {
      const before = filesSnapshot();
      console.log(`[${arch}] building ${packager}`);
      run(nfpm, ['package', '--config', config, '--packager', packager, '--target', DIST_DIR], {
        cwd: ROOT,
      });
      const after = filesSnapshot();
      const created = [...after].filter((name) => !before.has(name));
      if (!created.length) fail(`nfpm did not create a ${packager} artifact for ${arch}`);
      for (const name of created) {
        const file = path.join(DIST_DIR, name);
        console.log(`  ${name}  ${fs.statSync(file).size} bytes  sha256=${sha256(file)}`);
      }
    }
  }

  const artifacts = fs.readdirSync(DIST_DIR)
    .filter((name) => name.endsWith('.deb') || name.endsWith('.rpm'))
    .sort();
  const sums = artifacts.map((name) => `${sha256(path.join(DIST_DIR, name))}  ${name}`).join('\n');
  fs.writeFileSync(path.join(DIST_DIR, 'SHA256SUMS'), `${sums}\n`);
  console.log(`\n${artifacts.length} artifact(s) in ${DIST_DIR}`);
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
