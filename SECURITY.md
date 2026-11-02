# Security model

AnyCursor runs a gateway that can hold provider keys and serve inference. This
document describes what is protected, how, and what remains the operator's
responsibility.

## Trust boundary

The **host that runs the gateway** is the trust boundary. The owner — the person
who installed AnyCursor on that host — controls the configuration, the host key
and the owner token.

Anything outside that host is untrusted:

- browsers and API clients,
- LAN, tailnet and public network peers,
- delegated users (admin, viewer, client grants),
- copies of the config file or backup files.

If the operating system or the gateway process is compromised, the attacker is
inside the trust boundary. No application-level control can undo that.

## Secrets at rest

Provider keys, model keys, AWS secrets and `gateway.accessToken` are encrypted
with **AES-256-GCM** before they are written to disk.

- The key is a random 32-byte host key at
  `<gateway.dataDir>/secrets/host.key`.
- The file is created with owner-only permissions (mode `0600`; `icacls` on
  Windows) and is **outside** the config file.
- The config stores values as `enc:v1:<iv>:<tag>:<ciphertext>`.
- Existing plaintext configs are migrated on load; a
  `*.encryption.bak` backup is written first.
- Environment placeholders such as `${OPENCODE_API_KEY}` are not encrypted;
  they are resolved at load time.

On Windows, the Credential Manager store is still used for provider keys when
available; the host vault covers everything that remains inline (including the
owner token).

**Back up the host key.** Without it, encrypted values cannot be recovered.
Copying `config.json` to another machine does not reveal the secrets.

## ABAC, not just roles

Authorization is evaluated from attributes, not only a role name:

| Attribute | Values |
| --- | --- |
| role | owner, admin, viewer, private, client |
| token type | owner token, scoped grant, private/loopback session |
| network | loopback, private (RFC1918/Tailscale/ULA), public |
| resource | dashboard, status, config, models, providers, usage, grants, inference, secrets |
| action | read, write, run, manage |
| grant expiry | active / expired |

Policy:

| Role | Read | Write config | Run inference | Manage grants |
| --- | --- | --- | --- | --- |
| owner | everything | yes | yes | yes |
| admin | dashboard, status, config, models, providers, usage | no | yes | no |
| viewer | dashboard, status, config, models, providers, usage | no | no | no |
| private (no token, trusted network) | dashboard, status, config, models, providers, usage | no | yes | no |
| client (scoped token) | nothing | no | yes | no |

Additional attribute rules:

- a **public**-network principal can read and run scoped inference, but can
  never write configuration or manage grants, even as admin;
- `secrets` is denied to every role except owner and is **not exposed by any
  API**; the dashboard only shows whether a secret exists;
- expired grants resolve to anonymous;
- loopback with private trust is the only implicit owner session.

## Delegation

The owner creates scoped grants from **Dashboard → Access** or `POST
/api/access/grants`.

- Tokens are random 256-bit values, shown once; only a SHA-256 hash is stored.
- Roles: `admin`, `viewer`, `client`.
- Optional expiry, up to 365 days.
- Revoke immediately with `DELETE /api/access/grants?id=...`.
- A delegated user never sees provider keys, the owner token or the host key.
  Encrypted config data is useless without the host key, which stays on the
  server.

## Dashboard and API hardening

- login page with an HttpOnly, SameSite=Strict cookie;
- owner token or scoped grant for login; client grants cannot open the dashboard;
- cross-origin state-changing requests are rejected (Origin/Host check);
- per-IP login rate limit (8/minute) and write rate limit (30/minute);
- security headers: CSP, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, HSTS when TLS is detected;
- `/health` is the only unauthenticated endpoint; it contains no secrets;
- access decisions and grant changes are appended to
  `<dataDir>/logs/access.ndjson` (no tokens are logged);
- request bodies are size-limited; config is validated before it is written.

## Public exposure

A public bind without a token refuses to start. The supported remote paths are:

1. **Tailscale / private network** — the gateway binds to a private IP; Cursor
   connects over WireGuard.
2. **SSH tunnel** — the gateway binds to loopback; only the tunnel is exposed.
3. **Caddy + TLS + basic auth** — for the dashboard. Cursor cannot send basic
   auth credentials, so keep Cursor on Tailscale/SSH.

`gateway.allowInsecureRemote: true` is an explicit operator override. Use it
only behind another network control you trust.

## Out of scope

- a compromised host, root/admin account or malware inside the trust boundary;
- anyone who can read `host.key` or the owner token;
- Cursor's own account, telemetry and backend;
- provider-side logging, retention and abuse policies;
- denial of service at the network layer (use a firewall / proxy).

## Operator checklist

- [ ] Bind to loopback, a private IP or Tailscale; never expose 43110 directly.
- [ ] Keep `host.key` backed up and readable only by the service user.
- [ ] Use a long random owner token; rotate it with
      `ANY_CURSOR_ACCESS_TOKEN` if it may have leaked.
- [ ] Create per-person grants instead of sharing the owner token.
- [ ] Put TLS in front of any public dashboard.
- [ ] Review `logs/access.ndjson` after adding users.
- [ ] Keep Node.js and AnyCursor updated.

Report vulnerabilities privately through the repository's security advisory
form rather than a public issue.
