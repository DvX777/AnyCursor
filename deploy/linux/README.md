# AnyCursor on Linux

Status: **0.6.0-alpha**. The gateway packages build and the bundled Node 24
runtime has been exercised; install and systemd validation on the full matrix is
still in progress. The table below is the target support claim, not a statement
that every cell has passed.

AnyCursor 0.6.0 ships the gateway as a native Linux service. This package is the
**server** side: it runs the gateway under systemd and can be reached from
Cursor on another machine over a private network, SSH tunnel or TLS proxy.

Linux desktop integration for Cursor itself is planned for **0.6.1**. The
existing Windows client instructions still apply to Cursor on Windows.

## Supported distributions

| Family | Versions | Package |
| --- | --- | --- |
| Ubuntu | 22.04, 24.04, 26.04 LTS | `.deb` |
| Debian | 12, 13 | `.deb` |
| AlmaLinux | 9, 10 | `.rpm` |
| Rocky Linux | 9, 10 | `.rpm` |
| Fedora | current two supported releases | `.rpm` |

`x86_64` is the first tested architecture. `arm64` packages are buildable, but
are not part of the initial support claim until CI runs them.

Other distributions may work from source. They are not officially supported.

## Install

Direct signed packages from the GitHub Release:

```bash
# Debian / Ubuntu
sudo apt install ./anycursor_0.6.0_amd64.deb

# AlmaLinux / Rocky / Fedora
sudo dnf install ./anycursor-0.6.0-1.x86_64.rpm
```

The package installs a bundled Node.js runtime, so no NodeSource repository or
system Node upgrade is required.

## What the package installs

```text
/usr/lib/anycursor/                  gateway, dashboard, schema, bundled Node
/usr/lib/systemd/system/anycursor.service
/usr/lib/sysusers.d/anycursor.conf
/usr/lib/tmpfiles.d/anycursor.conf
/etc/anycursor/config.json           seeded once, never overwritten
/etc/anycursor/anycursor.env         provider keys and owner token, 0600
/var/lib/anycursor/                  config data, logs, secrets, backups
```

The service runs as the unprivileged `anycursor` user. It binds to
`127.0.0.1:43110` by default.

## Configure

Generate an owner token:

```bash
openssl rand -hex 32
```

Edit `/etc/anycursor/anycursor.env`:

```ini
ANY_CURSOR_ACCESS_TOKEN=<the generated token>
ANY_CURSOR_PUBLIC_URL=https://anycursor.example.com
OPENCODE_API_KEY=...
```

Then edit `/etc/anycursor/config.json` for the bind address, port, providers and
models. Keep provider keys in the environment file, not in the JSON.

For local-only use, leave the token empty and keep `gateway.host` at
`127.0.0.1`. Cursor and the dashboard run on the same machine.

For remote use, set a token **and** a reachable address:

```json
{
  "gateway": {
    "host": "0.0.0.0",
    "port": 43110,
    "publicUrl": "https://anycursor.example.com",
    "accessToken": "${ANY_CURSOR_ACCESS_TOKEN}",
    "allowInsecureRemote": false,
    "trustPrivateNetworks": false
  }
}
```

A public bind without a token refuses to start. `trustPrivateNetworks` is
`false` in the Linux package, so Tailscale and LAN clients also need the token.
That is deliberate: private networks are not automatically trusted.

Supported remote paths:

1. **Tailscale / private network** — bind to the private IP; Cursor reaches it
   over WireGuard.
2. **SSH tunnel** — keep the service on loopback and forward the port.
3. **Caddy + TLS** — terminate TLS in front of the dashboard. Cursor should
   still use Tailscale or SSH, because it cannot send basic-auth credentials.

## Service

```bash
sudo systemctl status anycursor
sudo systemctl restart anycursor
sudo journalctl -u anycursor -f
```

Health:

```bash
curl -s http://127.0.0.1:43110/health
```

The response includes `version`, configured models, `privacy.blocked` and any
configuration warnings. It never contains secrets.

## Data and secrets

| Path | Purpose |
| --- | --- |
| `/etc/anycursor/config.json` | panel configuration, `0600` |
| `/etc/anycursor/anycursor.env` | provider keys and token, `0600` |
| `/var/lib/anycursor/logs/` | traffic, access and fatal logs |
| `/var/lib/anycursor/secrets/host.key` | AES-256-GCM host key, `0600` |
| `/var/lib/anycursor/backups/` | encrypted migration backups |

**Back up `host.key` separately from the config.** Without it, encrypted
values cannot be recovered. On Linux there is no DPAPI equivalent; the boundary
is the `anycursor` user, file permissions and full-disk encryption.

## Upgrade

Install the newer package over the old one:

```bash
sudo apt install ./anycursor_0.6.1_amd64.deb
# or
sudo dnf upgrade ./anycursor-0.6.1-1.x86_64.rpm
```

`/etc/anycursor` and `/var/lib/anycursor` are preserved. The post-install script
restarts the service. Check `/health` and `journalctl -u anycursor` after an
upgrade.

## Uninstall

```bash
sudo apt remove anycursor
# or
sudo dnf remove anycursor
```

This stops and disables the service and removes the package, but keeps
`/etc/anycursor` and `/var/lib/anycursor`. Delete those explicitly if you want
to remove configuration and data.

## SELinux and AppArmor

The package uses standard paths and runs `restorecon` when SELinux is present.
Test on AlmaLinux, Rocky Linux and Fedora with `getenforce` set to `Enforcing`.
If local policy produces AVC denials, inspect them with:

```bash
sudo ausearch -m avc -ts recent
```

Do not disable SELinux to work around a labeling issue.

## Security notes

- The service binds to loopback by default.
- A public bind requires `gateway.accessToken`; `allowInsecureRemote: true` is
  an explicit override and is not recommended.
- Provider keys are encrypted at rest with the host key.
- Telemetry from Cursor is blocked by default (`privacy.blockTelemetry`).
- The package opens no firewall ports.
- Keep the host key out of backups that are stored on the same host.

## Build from source

From the repository root:

```bash
node scripts/build-linux.js --arch amd64 --packagers deb,rpm
```

The script downloads the official Node.js Linux binary and nFPM, verifies their
checksums, stages the root filesystem and writes artifacts to `dist/`. It works
on Windows, macOS and Linux. CI builds `amd64` and `arm64`.

## Troubleshooting

**Service exits immediately**

```bash
sudo journalctl -u anycursor -n 50 --no-pager
```

Common causes: a public bind without a token, invalid JSON, or a provider
configuration that fails validation.

**Dashboard unreachable from another machine**

Check `gateway.host`, the firewall and the token. A loopback bind is not
reachable remotely by design.

**Encrypted config cannot be read**

The host key is missing or the config was copied from another machine. Restore
`/var/lib/anycursor/secrets/host.key` from your backup, or restore the config
from a backup made with the same key.
