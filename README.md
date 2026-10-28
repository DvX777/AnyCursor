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
- shortcut repair and pre-warmed gateway service
- settings UI editing
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

## Development

```powershell
cd C:\Project\AnyCursor
npm test
```

No dependencies are required yet.

## License

MIT
