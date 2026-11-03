# Agent instructions — AnyCursor

AnyCursor is a self-hosted model gateway and Cursor extension. The current
release line is **0.6.0**, which adds Linux server packages on top of the
Windows 0.5.x behaviour.

## Read order

1. `README.md` — product, install, Windows lifecycle, Linux packages
2. `SECURITY.md` — encryption, ABAC, remote exposure, operator checklist
3. `deploy/linux/README.md` — Linux install/configure/upgrade path
4. `packaging/` — nfpm, systemd, sysusers/tmpfiles, maintainer scripts
5. `C:\Users\dev_doctnt\.opencode\plan\anycursor-linux-release.md` — release plan

## Build and test

Gateway on Windows:

```powershell
npm start
node --check src\gateway\server.js
```

Tests live outside the public repo in `C:\Project\AnyCursor-tests`. To run them:

```powershell
Copy-Item C:\Project\AnyCursor-tests\test .\test -Recurse
node --test
Remove-Item test -Recurse -Force
```

Do not commit the `test/` folder; it is intentionally out of the public repo.

Linux packages (works on Windows, macOS and Linux):

```powershell
node scripts/build-linux.js --arch amd64 --packagers deb,rpm
```

The script verifies the official Node.js and nFPM SHA256 checksums, stages the
root filesystem, and writes `.deb`/`.rpm` plus `dist/SHA256SUMS`.

## Rules

- **Never commit secrets, host keys, `config/anycursor.json`, logs or VSIX
  output.**
- Encrypted secrets use AES-256-GCM. On Windows the host key is in Credential
  Manager; on Linux it is `/var/lib/anycursor/secrets/host.key`, `0600`.
- Do not weaken the service sandbox to make a test pass. If a systemd directive
  breaks Node, document why and change it deliberately.
- A public bind without an owner token must refuse to start. Do not add a
  default token or a default password.
- Keep telemetry blocked by default. Do not add third-party analytics.
- Linux support is limited to Ubuntu 22.04/24.04/26.04, Debian 12/13,
  AlmaLinux 9/10, Rocky Linux 9/10 and current Fedora. Do not claim other
  distributions without a decision.
- **No console flashes.** Background tasks run inside the windowless watchdog
  and spawn console tools with `CreateNoWindow`. Never add a per-minute
  `powershell.exe` scheduled task.
- Do not run `npm run package:extension` casually; it rewrites the VSIX and
  changes release artifacts.

## Releases

Releases are built locally. The release flow is:

1. run the gateway and tests locally;
2. build packages with `node scripts/build-linux.js`;
3. build the extension VSIX if the extension changed;
4. record SHA256 hashes;
5. create the GitHub release through the API using the stored credential, not a
   workflow.

Do not tag a release until the artifacts have been installed and checked on a
real Linux host. If no Linux host is available, say so and keep the release as a
draft or an explicit alpha.

## Related projects

rPanel lives at `C:\Project\rPanel` and has its own session. Do not mix rPanel
changes into this repository.
