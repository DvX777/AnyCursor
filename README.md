# AnyCursor

AnyCursor is an open-source local model gateway for Cursor.

It keeps Cursor's native UI, modes, tools, MCP, subagents and approvals, while
letting you use:

- Cursor's own models through Cursor's backend
- your own models through your own API keys, endpoints and providers
- both in the same Cursor install, switchable from the native model picker

## Status

Early development. Windows-only for the first release.

Working now:

- config loader with provider/model validation and namespaced model IDs
- model registry with native/BYOK routing
- Cursor local history reader (`composerHeaders`, `cursorDiskKV`, transcripts)
- gateway skeleton with h1/h2c forwarding, BYOK live-turn handling, and raw
  native passthrough routing
- append-only `AvailableModels` merge with display names, effort, context and
  fast metadata
- localhost health endpoint and web dashboard
- settings UI for providers/models with validation, backups and hot reload
- Windows installer: packaged extension, login pre-warm task, shortcut repair
- cross-workspace history browser and copy/move importer
- Cursor extension skeleton that starts/supervises the gateway on activation

Current provider adapters:

- OpenAI-compatible: streaming text/thinking, tools, vision
- Anthropic Messages: streaming text/thinking, tool use/results
- Google Gemini: streaming text/thinking, function calls
- Azure OpenAI: OpenAI chat-completions path with deployment/api-version
- AWS Bedrock: Converse with SigV4 (non-streaming first version)

Next:

- Bedrock streaming (ConverseStream)
- native model picker verification for effort/context/fast
- native/BYOK route-switch tests

## Run the gateway

```powershell
cd C:\Project\AnyCursor
Copy-Item config\anycursor.example.json config\anycursor.json
npm start
```

Open `http://127.0.0.1:43110/` for the dashboard and `/health` for diagnostics.

The example config uses environment references for keys. Missing keys are
reported as warnings and can be filled in later.

## Configure without editing JSON

The dashboard at `http://127.0.0.1:<port>/` has tabs for providers, models,
gateway/routing and raw JSON. **Save changes** validates the config, writes a
timestamped `.bak` backup, and applies it to new requests without restarting
the gateway. External edits to the config file are picked up automatically.

Stored secrets are never sent to the browser: they are replaced with empty
strings and a `has…` flag. Leaving a key field empty keeps the saved value;
use the clear checkbox to remove it.

Config API:

```text
GET  /api/config          redacted config + warnings + restart-required fields
POST /api/config          {"config": {...}} validate, back up, save, apply
POST /api/config/reload   reload the file from disk
```

Host, port, upstream and data-directory changes are reported as requiring a
gateway restart; everything else applies live.

## Install on Windows

```powershell
cd C:\Project\AnyCursor
npm run install:windows          # per-user, no admin: Startup shortcut fallback
npm run install:windows:admin    # one UAC prompt: registers a login task
```

The admin variant only elevates the login-task registration; the gateway still
runs as your normal user. If the UAC prompt is cancelled, the installer falls
back to the Startup shortcut.

The installer:

1. creates `%LOCALAPPDATA%\AnyCursor\config.json` if it does not exist
2. stages the gateway inside the extension and packages a VSIX
3. installs the extension with the Cursor CLI
4. registers a `AnyCursor Gateway` login task when permitted, or builds a
   hidden `AnyCursor Gateway.exe` helper and adds an `AnyCursor Gateway`
   Startup shortcut when Windows policy blocks tasks
5. updates Desktop, Start Menu and Taskbar Cursor shortcuts to add
   `--test-backend-url http://127.0.0.1:<port>`
6. waits for the gateway health endpoint

Shortcut backups are written next to each shortcut as `*.lnk.anycursor.bak`.
When task registration is denied, the installer builds a hidden
`%LOCALAPPDATA%\AnyCursor\AnyCursor Gateway.exe` helper, adds an `AnyCursor
Gateway` Startup shortcut, and uses it to pre-warm the gateway hidden. Task
Manager shows `AnyCursor Gateway.exe`, not `wscript.exe`. Both are removed by
the uninstaller.

`AnyCursor Gateway.exe` is not an app users open. It has no window, only
ensures the gateway is running, and exits. If it is missing or disabled, the
Cursor extension starts the gateway when Cursor starts. **Users always open
Cursor normally.**

Options: `-SkipPackage`, `-SkipExtension`, `-SkipTask`, `-SkipShortcuts`,
`-RequestAdmin`, `-Port`, `-Config`, `-TaskName`.

In Cursor, use the command palette:

```text
AnyCursor: Open Settings
AnyCursor: Open Configuration File
AnyCursor: Doctor
AnyCursor: Repair Cursor Shortcuts
AnyCursor: Start Gateway
```

Uninstall:

```powershell
npm run uninstall:windows
```

This removes the login task, restores shortcuts and uninstalls the extension.
Your config and logs stay in `%LOCALAPPDATA%\AnyCursor` unless you pass
`-RemoveData`.

Run the gateway manually with a specific config:

```powershell
node src\gateway\index.js --config C:\path\to\anycursor.json
```

### About `--test-backend-url`

This is Cursor's own internal switch for pointing the desktop app at another
backend; Cursor exposes no public alternative. It is not a leftover test value.
AnyCursor keeps Cursor shortcuts pointed at `Cursor.exe` with that flag instead
of routing the user through a separate app. The only extra executable is the
hidden gateway prewarm helper described above; users never launch it.

## Verify the native picker (development)

This test uses port `43111` and never kills Cursor or touches shortcuts:

```powershell
cd C:\Project\AnyCursor
powershell -ExecutionPolicy Bypass -File .\scripts\verify-native-picker.ps1
```

If Cursor is already running, the script starts the gateway only and prints the
command to launch Cursor with `--test-backend-url http://127.0.0.1:43111`.
Fully quit Cursor first, then run the printed command.

Check in Cursor:

- AnyCursor models appear beside native Cursor models
- display name is friendly, not the raw model ID
- effort/context/fast controls match the model capabilities
- selecting a native Cursor model still works
- selecting an AnyCursor model routes to the configured provider

Stop the test gateway with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-gateway.ps1 -Port 43111
```

## Principles

- No launcher and no visible app. Open Cursor normally.
- The gateway is pre-warmed at login and supervised by the Cursor extension.
- Native Cursor models keep Cursor's billing, plan, usage, tools and history.
- BYOK models are namespaced and routed locally.
- Nothing is hardcoded: provider, endpoint, key, model and display name are
  configuration.
- Local-only by default. Keys live in the OS keychain or environment.

## Planned architecture

```text
AnyCursor/
├─ extension/       Cursor extension: settings, health, lifecycle, shortcuts
├─ gateway/         local h1/h2c gateway + localhost web UI
├─ providers/       OpenAI, Anthropic, Google, Azure, Bedrock, local
├─ catalog/         AvailableModels merge, model metadata, effort/context
├─ history/         Cursor local conversation import and canonical history
├─ tools/           native tools, MCP, subagents
└─ config/          schema, secrets, migrations, presets
```

## Configuration

See [`config/anycursor.example.json`](config/anycursor.example.json).

Models have a stable AnyCursor ID, a provider model ID and a separate display
name:

```json
{
  "id": "deepseek-v4.1-flash",
  "displayName": "DeepSeek V4.1 Flash",
  "provider": "opencode",
  "model": "deepseek-v4.1-flash"
}
```

Cursor sees `anycursor/opencode/deepseek-v4.1-flash`; the provider receives
`deepseek-v4.1-flash`; the picker shows `DeepSeek V4.1 Flash`.

## Move chats between workspaces

Cursor stores chats globally but lists them per workspace. The dashboard's
**History** tab shows every non-empty conversation and can copy one into
another workspace while keeping the original.

CLI equivalents:

```powershell
npm run history -- --list-workspaces
npm run history -- --list --workspace vidzen
npm run history -- --latest 3 --workspace vidzen --to anycursor
npm run history -- --id <composerId> --to anycursor --move
```

Copy is the default. `--move` changes the existing conversation's workspace
instead of duplicating it. Quit Cursor before importing; the script refuses to
write while Cursor is running unless you pass `--force`. Every run writes a
`state.vscdb.anycursor-history-<timestamp>.bak` backup next to the Cursor
database first.

## Development

```powershell
cd C:\Project\AnyCursor
npm test
```

No dependencies are required yet.

## License

MIT
