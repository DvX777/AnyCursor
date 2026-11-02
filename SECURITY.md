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

- On Windows, the host key is stored in **Windows Credential Manager** (DPAPI)
  and is not kept next to the config. On other platforms it is a random 32-byte
  file at `<gateway.dataDir>/secrets/host.key` with owner-only permissions
  (mode `0600`).
- The config contains only an authenticated encrypted envelope; no key material
  is stored with it.
- Existing plaintext configs are migrated on load; an **encrypted**
  `*.encryption.bak` is written first.
- Environment placeholders such as `${OPENCODE_API_KEY}` are not encrypted;
  they are resolved at load time.
- On Windows with Credential Manager available, provider keys are protected by
  Windows DPAPI; the host vault covers the owner token and any remaining inline
  values.

**Back up the host key.** On Windows, export it from Credential Manager with the
credential helper before moving profiles or machines. On other platforms, back
up `secrets/host.key`. Without the key, encrypted values cannot be recovered.

Knowing the algorithm and layout does not reveal the key: AES-256-GCM is only
decryptable with it. If an attacker obtains the host key itself, or controls the
host, encryption cannot protect you — that is host compromise, and it is outside
what any application-level vault can stop.

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

## Client updates and telemetry

AnyCursor does not patch Cursor's client. The integration is a launch flag
(`--test-backend-url`) on ordinary user shortcuts plus an external gateway
supervised by a per-user task. Cursor updates replace Cursor's own files; they
cannot corrupt AnyCursor code, and AnyCursor never writes into
`resources/app`.

**Shortcut guard.** A per-user task runs at logon and every minute. It:

1. re-applies the flag when Cursor's version changes or a shortcut loses it;
2. inspects the command line of the running main `Cursor.exe` process;
3. if Cursor is running without the flag, repairs the shortcuts, writes
   `state/client-alert.json`, shows a Windows notification and surfaces the
   warning in the dashboard;
4. clears the alert once a Cursor process is seen with the flag.

A running process cannot be fixed in place; the alert says to restart Cursor.

**Telemetry.** Cursor sends analytics, metrics, traces and log uploads through
the same backend URL as inference. With `privacy.blockTelemetry` enabled
(default), the gateway returns an empty success response and does not forward
those paths. Only the path is logged; bodies and headers are not. Inference,
catalog, auth, dashboard and agent calls are not matched. The list is narrow on
purpose and can be reviewed in `src/gateway/privacy.js`. Statsig feature-gate
bootstrap is explicitly forwarded: it is a config fetch, not an upload.

Direct client endpoints are outside the gateway. `metrics.cursor.sh` can be
blocked with the optional `scripts/privacy.ps1` hosts helper (elevated,
reversible, marked block, backup). `telemetry.cursor.sh` does not resolve as of
November 2026. Sentry is not blocked because `*.ingest.sentry.io` is shared with
other applications.

**Limits.** This is privacy hardening, not a way to make an unsupported
configuration sanctioned. Blocking diagnostics does not guarantee that Cursor's
own account or abuse systems will never act on unusual usage. Do not share
Cursor accounts or tokens, and do not use the gateway to serve Cursor's paid
models to other people.

**Residual risk.** `--test-backend-url` is an internal Cursor switch. If a
release removes it, AnyCursor cannot force routing from inside the client.
Shortcut repair will fail visibly; check `AnyCursor: Doctor` and the release
notes before upgrading Cursor.

## Out of scope

- a compromised host, root/admin account or malware inside the trust boundary;
- anyone who can read `host.key` or the owner token;
- Cursor's own backend, account decisions and client updates beyond the launch
  flag; telemetry that traverses the gateway is blocked, but direct endpoints
  and Cursor's fraud systems are not controlled here;
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
- [ ] Leave `privacy.blockTelemetry` on unless you are debugging a Cursor
      client issue.
- [ ] After a Cursor update, check the dashboard for a "Cursor is running
      without the AnyCursor backend" warning.

Report vulnerabilities privately through the repository's security advisory
form rather than a public issue.
