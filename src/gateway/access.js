'use strict';

const crypto = require('crypto');
const auth = require('./auth');

const ROLES = ['owner', 'admin', 'viewer', 'private', 'client'];

const POLICY = {
  owner: { read: '*', write: '*', run: '*', manage: '*' },
  admin: {
    read: ['dashboard', 'status', 'config', 'models', 'providers', 'usage', 'inference'],
    write: [],
    run: ['inference'],
    manage: [],
  },
  viewer: {
    read: ['dashboard', 'status', 'config', 'models', 'providers', 'usage'],
    write: [],
    run: [],
    manage: [],
  },
  // Private network without a token: Cursor can infer, the dashboard is read-only.
  private: {
    read: ['dashboard', 'status', 'config', 'models', 'providers', 'usage'],
    write: [],
    run: ['inference'],
    manage: [],
  },
  client: {
    read: [],
    write: [],
    run: ['inference'],
    manage: [],
  },
};

function normalizeAddress(address) {
  let value = String(address || '').trim();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
  return value;
}

function isLoopback(address) {
  const value = normalizeAddress(address);
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function networkOf(req) {
  const address = auth.clientAddress(req);
  if (isLoopback(address)) return 'loopback';
  if (auth.isPrivateAddress(address)) return 'private';
  return 'public';
}

function hashToken(token) {
  return `sha256:${crypto.createHash('sha256').update(String(token || '')).digest('hex')}`;
}

function newToken() {
  return `ac_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashesEqual(left, right) {
  const a = Buffer.from(String(left || '').replace(/^sha256:/, ''), 'hex');
  const b = Buffer.from(String(right || '').replace(/^sha256:/, ''), 'hex');
  if (a.length !== b.length || a.length !== 32) return false;
  return crypto.timingSafeEqual(a, b);
}

function grantActive(grant, now = Date.now()) {
  if (!grant || !grant.expiresAt) return true;
  const expires = Date.parse(grant.expiresAt);
  return Number.isFinite(expires) ? expires > now : true;
}

function findGrant(grants, supplied) {
  if (!supplied) return null;
  const hash = hashToken(supplied);
  for (const grant of grants || []) {
    if (!grantActive(grant)) continue;
    if (hashesEqual(hash, grant.tokenHash)) return grant;
  }
  return null;
}

function principal(req, url, options = {}, config = null) {
  const network = networkOf(req);
  const grants = (config && config.gateway && config.gateway.grants) || [];
  const hasAuth = !!options.token || grants.length > 0;

  if (!hasAuth) {
    return { role: network === 'loopback' ? 'owner' : 'private', via: 'open', network };
  }

  if (network === 'loopback' && options.trustPrivate) {
    return { role: 'owner', via: 'loopback', network };
  }

  const supplied = auth.tokenFromRequest(req, url);
  if (options.token && auth.safeEqual(supplied, options.token)) {
    return { role: 'owner', via: 'owner-token', network };
  }

  const grant = findGrant(grants, supplied);
  if (grant) {
    return {
      role: grant.role,
      via: 'grant',
      network,
      name: grant.name,
      grantId: grant.id,
    };
  }

  if (network === 'private' && options.trustPrivate) {
    return { role: 'private', via: 'private', network };
  }

  return { role: 'anonymous', via: 'none', network };
}

function can(principalValue, action, resource) {
  const p = principalValue;
  if (!p || p.role === 'anonymous' || !ROLES.includes(p.role)) return false;
  if (p.role === 'owner') return true;
  if (resource === 'secrets') return false;
  // ABAC: a public-network principal can read and run scoped inference, but
  // never write configuration or manage grants.
  if (p.network === 'public' && (action === 'write' || action === 'manage')) return false;

  const policy = POLICY[p.role];
  if (!policy) return false;
  const allowed = policy[action];
  if (allowed === '*') return true;
  return Array.isArray(allowed) && allowed.includes(resource);
}

function sanitizeGrant(grant) {
  return {
    id: grant.id,
    name: grant.name,
    role: grant.role,
    createdAt: grant.createdAt || '',
    expiresAt: grant.expiresAt || '',
  };
}

function publicPrincipal(p) {
  return {
    role: p.role,
    via: p.via,
    network: p.network,
    ...(p.name ? { name: p.name } : {}),
    ...(p.grantId ? { grantId: p.grantId } : {}),
  };
}

module.exports = {
  ROLES,
  POLICY,
  networkOf,
  hashToken,
  newToken,
  grantActive,
  findGrant,
  principal,
  can,
  sanitizeGrant,
  publicPrincipal,
  isLoopback,
};
