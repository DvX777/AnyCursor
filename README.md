<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/anycursor-logo.png">
  <img alt="AnyCursor" src="assets/anycursor-logo-light.png" width="460">
</picture>

**Use your own models inside Cursor — with Cursor's native Agent, tools, MCP, subagents and approvals.**

_Your keys. Your models. Cursor's native experience. No second app to open._

<p>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?style=for-the-badge&logo=windows&logoColor=white">
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-3.x-000000?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-purple?style=for-the-badge">
  <img alt="Tests" src="https://img.shields.io/badge/Tests-48%20passing-brightgreen?style=for-the-badge">
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

The installer:

1. seeds `%LOCALAPPDATA%\AnyCursor\config.json`
2. stages the gateway inside the extension and builds a VSIX
3. installs the extension with the Cursor CLI
4. registers a login pre-warm task, or falls back to a hidden Startup entry
5. patches Cursor shortcuts with the local backend flag
6. waits for the gateway health endpoint

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
GET  /health              health endpoint
```

Host, port, upstream and data-directory changes require a gateway restart. Model, provider and routing changes apply live.

## Windows Lifecycle

```powershell
npm run install:windows
npm run install:windows:admin
npm run uninstall:windows
```

Uninstall removes the extension, login/Startup prewarm, and the shortcut flag. Your config and logs stay in `%LOCALAPPDATA%\AnyCursor` unless you pass `-RemoveData`.

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

### About `--test-backend-url`

This is Cursor's own internal switch for pointing the desktop app at another backend. Cursor exposes no public alternative. AnyCursor keeps shortcuts pointed at `Cursor.exe` with this flag instead of routing users through a separate launcher.

## Development

```powershell
cd C:\Project\AnyCursor
npm test
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

### Gateway is down

```powershell
Invoke-RestMethod http://127.0.0.1:43110/health
```

Then run **AnyCursor: Doctor** from the Cursor command palette.

## Principles

- **Cursor stays Cursor.** Native models, tools, MCP, subagents, approvals and history remain native.
- **Your keys stay yours.** BYOK traffic is routed locally, not through a separate hosted service.
- **Open Cursor normally.** No launcher and no visible companion app.
- **Configuration over hardcoding.** Providers, endpoints, models and display names are data.
- **Local by default.** Secrets live in Windows Credential Manager or environment variables.

## License

MIT © AnyCursor

AnyCursor is an independent project. It is not affiliated with, endorsed by, or
sponsored by Cursor or Anysphere. "Cursor" is a trademark of its respective
owner and is used only to describe compatibility.
