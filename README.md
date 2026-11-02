<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/anycursor-logo.png">
  <img alt="AnyCursor" src="assets/anycursor-logo-light.png" width="460">
</picture>

<sub>Independent project · not affiliated with, endorsed by, or sponsored by Cursor or Anysphere.<br>"Cursor" is a trademark of its respective owner, used only to describe compatibility.</sub>

**Use your own models inside Cursor — with Cursor's native Agent, tools, MCP, subagents and approvals.**

_Your keys. Your models. Cursor's native experience. No second app to open._

<p>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?style=for-the-badge&logo=windows&logoColor=white">
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-3.x-000000?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-purple?style=for-the-badge">
</p>
<p>
  <img alt="BYOK" src="https://img.shields.io/badge/BYOK-OpenAI%20%7C%20Anthropic%20%7C%20Google%20%7C%20Azure%20%7C%20Bedrock-blue?style=for-the-badge">
  <img alt="Private" src="https://img.shields.io/badge/Privacy-100%25%20local-success?style=for-the-badge">
  <img alt="No launcher" src="https://img.shields.io/badge/Launcher-None-orange?style=for-the-badge">
</p>

[Features](#features) · [Quick Start](#quick-start) · [Providers](#supported-providers) · [Architecture](#architecture) · [Configuration](#configuration) · [Development](#development)

</div>

---

AnyCursor is a local model gateway and Cursor extension that lets you run **your own API keys and models** through Cursor's normal Agent/Edit experience. Cursor keeps its native UI, tools, MCP servers, subagents, approvals and history. AnyCursor handles the model transport locally.

It is built for people who want their own models in Cursor without opening a second app, changing their workflow, or giving up native Cursor features.

## Features

| Capability | Status |
| --- | --- |
| Native Cursor models | Raw passthrough, untouched |
| BYOK OpenAI-compatible models | Streaming text, thinking, tools, vision |
| Anthropic Messages | Streaming text, thinking, tool use/results |
| Google Gemini | Streaming text, thinking, function calls |
| Azure OpenAI | Deployment and API-version aware |
| AWS Bedrock | Converse + ConverseStream with SigV4 |
| Agent / Ask / Plan / Debug modes | Verified through the Agent Host local loop |
| Agents Window | Verified, including background-composer picker |
| Native tools, shell, edits | Verified, with native approvals |
| MCP tools | Verified end-to-end |
| Image attachments | Verified |
| Subagents | Verified, including explore and approvals |
| Effort / context / fast controls | Native model-picker metadata |
| Secrets | Windows Credential Manager |
| Runtime | Local-only gateway, configuration-driven |

> **No launcher. No visible app. Open Cursor normally.** The gateway is pre-warmed at login and supervised by the Cursor extension.

## Quick Start

### Requirements

- Windows 10 or 11
- Cursor 3.x
- Node.js 22+ with `node:sqlite`
- Your own provider API key or endpoint

### Install

```powershell
git clone https://github.com/DvX777/Anycursor.git
cd Anycursor
npm run install:windows
```

Then open Cursor normally — from the Desktop, Start Menu or Taskbar shortcut.

> **Cursor's Agent Window does not load extensions.** Cursor 3.x opens its glass/Agent window by default, and that surface only scans a fixed list of Cursor's own extensions, so no third-party extension activates there — not just AnyCursor. Your models do not depend on that: the gateway is a separate local service, and the installer's watchdog keeps it running without any extension activation. The AnyCursor commands, status bar item and doctor report are extras that appear in an IDE window, opened with `Cursor.exe --classic`. See [Agent Window and the IDE window](#agent-window-and-the-ide-window).

The installer:

1. seeds `%LOCALAPPDATA%\AnyCursor\config.json`
2. stages the gateway inside the extension and builds a VSIX
3. installs the extension with the Cursor CLI
4. registers the **AnyCursor Gateway Watchdog**, a per-user task that supervises the gateway (restarts it within seconds)
5. registers a login pre-warm task, or falls back to a hidden Startup entry
6. patches Cursor shortcuts with the local backend flag
7. waits for the gateway health endpoint

Admin variant, one UAC prompt:

```powershell
npm run install:windows:admin
```

If task registration is blocked by policy, the installer uses a hidden `AnyCursor Gateway.exe` prewarm helper. Users never launch it; it has no window and exits after ensuring the gateway is running.

### Configure

Open:

```text
http://127.0.0.1:43110/
```

Add a provider, add a model, choose its display name and effort/context options, then **Save changes**. Changes apply to new requests without restarting the gateway.

### Cursor settings AnyCursor does not need

AnyCursor does not add an API key to Cursor and does not use Cursor's **Override OpenAI Base URL**. Keep Cursor's API key empty and the override **off** when using AnyCursor: that path belongs to Cursor's own OpenAI/xAI models, and while it is active Cursor can refuse first-party models with "This model does not support custom API keys".

With both left empty, AnyCursor handles routing and native tools, MCP servers, subagents and approvals keep working exactly as before, with Cursor's own models and with AnyCursor models.

If you do configure a Cursor key or override URL, Cursor can refuse first-party models with "This model does not support custom API keys". That is Cursor's key mode, not an AnyCursor error. Configure providers and models in the AnyCursor dashboard instead; the two paths are independent.

Manual routing, only if you skip shortcut patching: launch Cursor with `--test-backend-url http://127.0.0.1:43110`, or run **AnyCursor: Repair Cursor Shortcuts**. Nothing else needs to change in Cursor.

## Run It Anywhere

**AnyCursor has no limit.** Local, LAN, VPS, homelab or Tailscale — it is the same gateway, wherever it runs.

AnyCursor is not tied to `127.0.0.1`. The gateway can run on a VPS, a dedicated server, a homelab box or a Tailscale node, and Cursor can point at it from another machine.

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 43110,
    "publicUrl": "https://anycursor.example.com",
    "accessToken": "${ANY_CURSOR_ACCESS_TOKEN}"
  },
  "cursor": {
    "backendUrl": "https://anycursor.example.com",
    "supervise": false
  }
}
```

- `host` controls the bind address. Loopback, RFC1918 and Tailscale/CGNAT clients are trusted by default.
- `publicUrl` is the address clients actually use; it becomes the default `cursor.backendUrl`.
- `accessToken` protects the dashboard and API when a public client connects. A public bind without a token refuses to start.
- `supervise: false` stops the local extension from starting a second gateway on the client machine.

The supported remote path for Cursor is a private network — **Tailscale** or an **SSH tunnel** — because Cursor cannot send the dashboard token. A public domain is fine for the dashboard behind Caddy basic auth. Full steps, systemd, Docker, Caddy and a security checklist live in [deploy/README.md](deploy/README.md).

## Supported Providers

| Provider | Type | Transport |
| --- | --- | --- |
| OpenAI-compatible | `openai-compatible` | Chat completions streaming, tools, vision |
| Anthropic | `anthropic` | Messages streaming, thinking, tool use |
| Google Gemini | `google` | `streamGenerateContent`, function calls |
| Azure OpenAI | `azure-openai` | Deployment URL + API version |
| AWS Bedrock | `bedrock` | Converse / ConverseStream, SigV4 |
| Any custom endpoint | `openai-compatible` | Base URL, endpoint path and headers |

The provider layer is configuration-driven. Nothing about URLs, ports, model names or display names is hardcoded.

## Architecture

```text
┌───────────────────────────────┐
│           Cursor UI           │
│  Agent · Edit · Ask · Plan    │
│  Tools · MCP · Subagents      │
└──────────────┬────────────────┘
               │ Cursor backend protocol
┌──────────────▼────────────────┐
│        AnyCursor Gateway      │
│  local h1/h2c · 127.0.0.1     │
│                               │
│  • AvailableModels merge      │
│  • BYOK routing               │
│  • RunInference local loop    │
│  • native passthrough         │
│  • config + settings API      │
└──────────────┬────────────────┘
               │ streaming provider APIs
┌──────────────▼────────────────┐
│  OpenAI · Anthropic · Google  │
│  Azure · Bedrock · Custom     │
└───────────────────────────────┘
```

Cursor's own models are forwarded byte-for-byte to Cursor's backend. BYOK models are intercepted locally and sent to the configured provider.

With Cursor 3.x, Agent Host turns arrive as `InferenceService/RunInference` streams. AnyCursor answers `run_ready`, converts messages/tools, streams text and thinking deltas, returns tool calls, and ends each invocation. Native approvals and the agent loop remain Cursor's.

## Configuration

See [`config/anycursor.example.json`](config/anycursor.example.json).

A model has a stable AnyCursor ID, a Cursor-facing ID, the real provider model ID, and a display name:

```json
{
  "id": "deepseek-v4.1-flash",
  "cursorId": "claude-anycursor-deepseek-v4.1-flash",
  "displayName": "DeepSeek V4.1 Flash",
  "provider": "opencode",
  "model": "deepseek-v4.1-flash"
}
```

- Cursor sees `cursorId`
- the provider receives `model`
- the picker shows `displayName`

### Cursor 3.x Agent Host IDs

Cursor routes model IDs it classifies as BYOK back to its own backend. AnyCursor avoids that by generating non-BYOK Cursor IDs with a configurable prefix:

```json
"cursor": {
  "modelIdPrefix": "claude-anycursor"
}
```

That produces IDs such as:

```text
claude-anycursor-opencode-deepseek-v4.1-flash
```

Use an explicit `cursorId` to override the generated value. The prefix is configurable because Cursor's classification depends on which built-in API-key toggles are enabled.

### Secret Storage

On Windows, API keys and AWS secrets are stored in **Windows Credential Manager**:

```text
AnyCursor/provider/<name>/apiKey
AnyCursor/provider/<name>/secretAccessKey
AnyCursor/model/<model>/apiKey
```

The config file keeps references only:

```json
"apiKeyRef": "AnyCursor/provider/opencode/apiKey"
```

Environment references such as `${OPENCODE_API_KEY}` remain supported and are not copied into the credential store. Clearing a key in the dashboard deletes its credential-manager entry.

### Dashboard and API

```text
GET  /api/status          gateway, config, providers, active models
GET  /api/models          effective model list
GET  /api/config          redacted config + warnings + restart requirements
POST /api/config          validate, back up, save, apply live
POST /api/config/reload   reload the file from disk
POST /api/lookup-model    limits, reasoning and capabilities for a model id
GET  /api/models-dev/providers   catalogue providers for the picker
GET  /health              health endpoint
```

Host, port, upstream and data-directory changes require a gateway restart. Model, provider and routing changes apply live.

## Windows Lifecycle

```powershell
npm run install:windows
npm run install:windows:admin
npm run uninstall:windows
```

Uninstall removes the extension, the watchdog and login/Startup prewarm, and the shortcut flag. Your config and logs stay in `%LOCALAPPDATA%\AnyCursor` unless you pass `-RemoveData`.

Shortcut backups live in:

```text
%LOCALAPPDATA%\AnyCursor\backups\shortcuts
```

Cursor command palette:

```text
AnyCursor: Open Settings
AnyCursor: Open Configuration File
AnyCursor: Doctor
AnyCursor: Repair Cursor Shortcuts
AnyCursor: Start Gateway
```

### Agent Window and the IDE window

Cursor 3.x has two surfaces:

| Surface | Third-party extensions | AnyCursor models | AnyCursor commands |
| --- | --- | --- | --- |
| Agent Window (glass, default) | No — Cursor scans a fixed allowlist of its own extensions | Yes | No |
| IDE window (`Cursor.exe --classic`) | Yes | Yes | Yes |

Models work in both because Cursor calls the local gateway for `AvailableModels` and `RunInference` regardless of the window. The gateway is a normal background process, not an extension: the watchdog task starts it at login and restarts it within seconds if it exits. Nothing needs to be activated first.

Open an IDE window when you want the status bar item, `AnyCursor: Doctor`, or the other commands. Shortcuts keep opening the Agent Window, and that is fine.

### About `--test-backend-url`

This is Cursor's own internal switch for pointing the desktop app at another backend. Cursor exposes no public alternative. AnyCursor keeps shortcuts pointed at `Cursor.exe` with this flag instead of routing users through a separate launcher.

## Development

```powershell
cd C:\Project\AnyCursor
```

Run the gateway manually:

```powershell
node src\gateway\index.js --config C:\path\to\anycursor.json
```

### Project Layout

```text
AnyCursor/
|-- assets/          logo artwork
|-- extension/       Cursor extension: supervision, settings, lifecycle
|-- public/          Local dashboard and settings UI
|-- deploy/          VPS, systemd, Docker and Caddy recipes
|-- src/
|   |-- gateway/     h1/h2c gateway, RunInference, live turns
|   |-- providers/   OpenAI, Anthropic, Google, Azure, Bedrock
|   |-- catalog/     AvailableModels merge, model metadata
|   |-- config/      validation, hot reload, credential storage
|   `-- cursor/      Cursor state and model IDs
|-- scripts/         installer, shortcuts, migrations, diagnostics
`-- schema/          configuration schema
```

## Troubleshooting

### Cursor says "Cursor Subscription Required"

Cursor is blocking the turn before it reaches AnyCursor. Check:

- the selected model uses a non-BYOK `cursorId` such as `claude-anycursor-...`
- old chats and the composer selection were migrated to that ID
- Cursor's cached model catalog does not still contain the old ID

### "Local loop can't run this model"

The local loop needs `run_ready` prompt metadata and a recognized model family. Update AnyCursor, then select the AnyCursor model again. If the message names an unrecognized family, the cached Cursor catalog is stale.

### Extensions don't load in Cursor's Agent Window

Expected in Cursor 3.x: the Agent Window scans a fixed allowlist of Cursor's own extensions, so AnyCursor's status bar item and commands stay absent there. That does not affect models — the gateway runs independently of the extension. Open an IDE window (`Cursor.exe --classic`) if you need the commands. See [Agent Window and the IDE window](#agent-window-and-the-ide-window).

### Models are missing from the model picker

Cursor reads the model catalog when a window opens. If the gateway was down at that exact moment, that window lists native models only. The watchdog starts the gateway within seconds; reload the window (command palette → **Reload Window**) or reopen Cursor to fetch the catalog again.

### Context usage chart is empty for AnyCursor models

Cursor fills the **Context Usage** tray while it assembles a turn on its connect path. BYOK turns that run in the agent host's local loop give Cursor character counts but no token estimates, so the tray stays empty (the ring percentage can still appear). This is Cursor-side and does not affect context handling, tools or the models themselves.

### Cursor refuses a native model ("does not support custom API keys")

Cursor gates its own models by plan. On a free plan the agent backend allows only the included set (often just Auto); selecting another native model is refused by Cursor before the request reaches AnyCursor, so nothing appears in `traffic.ndjson` and no AnyCursor setting can unlock it. Models you add to AnyCursor keep working.

On a paid plan the same message can also appear when a custom provider key or an **Override OpenAI Base URL** is stored in Cursor's **Settings → Models → API Keys**: Cursor tries the custom-key path, and some first-party models do not accept it. AnyCursor never reads or changes that configuration. See [Cursor settings AnyCursor does not need](#cursor-settings-anycursor-does-not-need).

### Gateway is down

```powershell
Invoke-RestMethod http://127.0.0.1:43110/health
```

Then run **AnyCursor: Doctor** from the Cursor command palette.

## Principles

- **Cursor stays Cursor.** Native models, tools, MCP, subagents, approvals and history remain native; native model availability follows your Cursor plan.
- **No localhost lock-in.** Run the gateway on a VPS, homelab or Tailscale node; Cursor connects to any reachable address.
- **AnyCursor has no limit.** Local, LAN, VPS, homelab or Tailscale — the same gateway, wherever it runs.
- **Your keys stay yours.** BYOK traffic is routed locally, not through a separate hosted service.
- **Open Cursor normally.** No launcher and no visible companion app.
- **Configuration over hardcoding.** Providers, endpoints, models and display names are data.
- **Local by default.** Secrets live in Windows Credential Manager or environment variables.

## License

MIT © AnyCursor
