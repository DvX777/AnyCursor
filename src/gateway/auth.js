'use strict';

const crypto = require('crypto');

const COOKIE = 'anycursor_token';

function normalizeAddress(address) {
  let value = String(address || '').trim();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
  return value;
}

function isPrivateAddress(address) {
  const value = normalizeAddress(address);
  if (!value) return false;
  if (value === '::1' || value === '::' || value === '0.0.0.0') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
  return false;
}

function isPublicBind(host) {
  const value = String(host || '').trim();
  if (!value || value === 'localhost') return false;
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return true;
  const parts = value.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return !isPrivateAddress(value);
  }
  if (value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')) {
    return false;
  }
  return true; // hostname: assume it can be public
}

function clientAddress(req) {
  return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '';
}

function readCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function tokenFromRequest(req, url) {
  const headers = req.headers || {};
  const authorization = String(headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  const custom = headers['x-anycursor-token'];
  if (custom) return String(custom).trim();
  const cookies = readCookies(req);
  if (cookies[COOKIE]) return cookies[COOKIE];
  if (url) {
    const query = url.searchParams.get('token') || url.searchParams.get('access_token');
    if (query) return query;
  }
  return '';
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorized(req, url, options = {}) {
  const token = String(options.token || '');
  if (!token) return true;
  if (options.trustPrivate && isPrivateAddress(clientAddress(req))) return true;
  return safeEqual(tokenFromRequest(req, url), token);
}

function secureRequest(req, options = {}) {
  const forwarded = String((req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase();
  if (forwarded.split(',')[0].trim() === 'https') return true;
  return /^https:\/\//i.test(String(options.publicUrl || ''));
}

function authCookie(token, req, options = {}) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=604800',
  ];
  if (secureRequest(req, options)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req, options = {}) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secureRequest(req, options)) parts.push('Secure');
  return parts.join('; ');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loginPage(error) {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AnyCursor Login</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #14171c; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #eef1f6; } .card { background: #171a20 !important; border-color: #262b34 !important; } input { background: #0f1115 !important; color: #eef1f6 !important; border-color: #2b313b !important; } }
  .card { width: min(380px, calc(100vw - 32px)); background: #fff; border: 1px solid #e3e6eb; border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -0.02em; }
  p { margin: 0 0 18px; color: #6b7280; font-size: 13px; }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #d9dde4; border-radius: 8px; font: inherit; background: #fff; color: inherit; }
  button { width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: #b91c1c; font-size: 13px; margin-top: 10px; }
</style>
</head>
<body>
  <main class="card">
    <h1>AnyCursor</h1>
    <p>This gateway is hosted remotely. Enter its access token to continue.</p>
    <form method="post" action="/login">
      <label for="token">Access token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Open dashboard</button>
    </form>
    ${message}
  </main>
</body>
</html>`;
}

module.exports = {
  COOKIE,
  isPrivateAddress,
  isPublicBind,
  clientAddress,
  tokenFromRequest,
  authorized,
  safeEqual,
  authCookie,
  clearCookie,
  loginPage,
};
