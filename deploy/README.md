# Host AnyCursor on a VPS or dedicated server

AnyCursor is not tied to `127.0.0.1`. The gateway can run on a VPS, a homelab
box or a Tailscale node, and Cursor can point at it from another machine.

The important part is **how you expose it**. A gateway without protection gives
anyone your provider keys and model access, so the server refuses a public bind
unless you set one of:

- `gateway.accessToken` (or `ANY_CURSOR_ACCESS_TOKEN`), or
- `gateway.allowInsecureRemote: true` behind a firewall, VPN or authenticating
  proxy that you control.

Loopback, RFC1918, Tailscale/CGNAT (`100.64.0.0/10`), link-local and ULA clients
are trusted by default. Set `gateway.trustPrivateNetworks: false` if you want a
token even from those networks.

## Recommended: Tailscale

Tailscale keeps the gateway off the public internet while making it reachable
from anywhere, with WireGuard encryption and a stable `100.x` IP / MagicDNS name.

On the server:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4        # e.g. 100.101.102.103
```

Use that address in `config.json` so the gateway only listens on the tailnet:

```json
{
  "gateway": {
    "host": "100.101.102.103",
    "port": 43110,
    "publicUrl": "http://100.101.102.103:43110"
  },
  "cursor": {
    "backendUrl": "http://100.101.102.103:43110",
    "supervise": false
  }
}
```

Then on the client, either patch the Cursor shortcut:

```powershell
.\scripts\repair-shortcuts.ps1 -BackendUrl "http://100.101.102.103:43110"
```

or launch Cursor once with:

```powershell
Cursor.exe --test-backend-url http://100.101.102.103:43110
```

Because the client is on the tailnet, the gateway treats it as a private client
and does not require the dashboard token. MagicDNS works too:
`http://<machine>.<tailnet>.ts.net:43110`.

## Alternative: SSH tunnel

Keep the gateway on loopback and forward the port from your machine:

```bash
ssh -N -L 43110:127.0.0.1:43110 user@your-server
```

Cursor keeps using `http://127.0.0.1:43110`; only the gateway lives on the
server. This is the smallest attack surface and keeps h2c end-to-end.

## Public domain + Caddy

Use this for the dashboard, not for Cursor traffic: Cursor cannot send HTTP
Basic credentials, so point Cursor at Tailscale/SSH instead.

```bash
sudo apt install caddy
sudo caddy hash-password --plaintext 'choose-a-long-password'
```

Use the hash in [`caddy/Caddyfile`](caddy/Caddyfile), then:

```bash
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The gateway stays on `127.0.0.1:43110`; Caddy terminates TLS on your domain and
requires basic auth for every path.

If you really want Cursor over the public domain, set
`gateway.allowInsecureRemote: true` and remove the proxy auth — only do this if
another layer (Cloudflare Tunnel + WARP, firewall allowlist, mTLS) protects the
port. That is your call and your responsibility.

## systemd

```bash
sudo useradd --system --home /opt/anycursor --shell /usr/sbin/nologin anycursor
sudo mkdir -p /opt/anycursor /etc/anycursor /var/lib/anycursor
sudo chown -R anycursor:anycursor /opt/anycursor /var/lib/anycursor
# copy the repository to /opt/anycursor, then:
sudo cp deploy/systemd/anycursor.service /etc/systemd/system/
sudo cp deploy/anycursor.server.example.json /etc/anycursor/config.json
sudo nano /etc/anycursor/config.json      # fill providers/models
sudo nano /etc/anycursor/anycursor.env    # provider keys + ANY_CURSOR_ACCESS_TOKEN
sudo systemctl daemon-reload
sudo systemctl enable --now anycursor
```

Logs:

```bash
journalctl -u anycursor -f
curl http://127.0.0.1:43110/health
```

## Docker

The compose file uses host networking so the gateway can be reached by Caddy or
SSH on the same machine without publishing a port:

```bash
cd deploy/docker
cp .env.example .env        # provider keys + ANY_CURSOR_ACCESS_TOKEN
mkdir -p data
cp ../anycursor.server.example.json data/config.json
docker compose up -d --build
docker compose logs -f
```

The container expects `data/config.json`; its `gateway.dataDir` should be
`/data` inside the container.

## Dashboard token

When `gateway.accessToken` is set and the client is not on a trusted private
network, the dashboard shows a login page. `/health` stays open for monitoring.
The token can also be sent as `Authorization: Bearer <token>` or
`X-AnyCursor-Token` for scripts.

## Encryption and delegated access

Sensitive values are encrypted at rest with AES-256-GCM. On Windows the host
key lives in Windows Credential Manager; on Linux it is at:

```text
<gateway.dataDir>/secrets/host.key
```

Keep it readable only by the service user and **back it up**. The config file is
useless on another machine without this key.

Create scoped tokens from **Dashboard → Access** (owner only) or with the API:

```bash
curl -s -X POST http://127.0.0.1:43110/api/access/grants \
  -H "Authorization: Bearer $ANY_CURSOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"QA","role":"viewer","expiresInDays":30}'
```

- `admin` — read the dashboard and run inference; no writes, no secrets, no grants.
- `viewer` — read-only dashboard.
- `client` — inference only, suitable for Cursor clients.
- Public-network principals can never write or manage grants.

Tokens are shown once and stored only as SHA-256 hashes. Revoke with
`DELETE /api/access/grants?id=<id>`.

See [SECURITY.md](../SECURITY.md) for the full role matrix and threat model.

## Cursor client settings

On the client, in `config.json`:

```json
"cursor": {
  "backendUrl": "http://100.101.102.103:43110",
  "supervise": false,
  "patchShortcuts": true
}
```

`supervise: false` tells the extension not to start a local gateway; it checks
the remote one instead. If you do not install the extension, patch the shortcut
or pass `--test-backend-url` yourself.

## Checklist

- [ ] Gateway bound to loopback, a private IP, or Tailscale — not the public internet.
- [ ] `gateway.publicUrl` and `cursor.backendUrl` use the address clients actually reach.
- [ ] `gateway.accessToken` set if the bind can be reached publicly.
- [ ] Keep `secrets/host.key` backed up and readable only by the service user.
- [ ] Provider keys live in environment variables, not in the repository.
- [ ] Create per-person grants instead of sharing the owner token.
- [ ] TLS is terminated by Caddy/Tailscale if traffic leaves a trusted network.
- [ ] Firewall allows only the ports you intend to expose.
