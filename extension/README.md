# AnyCursor

<img src="assets/banner.png" alt="AnyCursor" height="56">

Use your own models inside Cursor — with Cursor's native Agent, tools, MCP,
subagents and approvals.

This extension supervises the local AnyCursor gateway that makes that possible.
It is not a second app: you open Cursor the normal way and switch between
Cursor's own models and your BYOK models in the native model picker.

## What it does

- starts with Cursor and supervises the local gateway
- starts the gateway when it is not running, and restarts it after a crash
- runs the packaged gateway from `vendor/anycursor`, so no source checkout is
  required after installation
- reads `%LOCALAPPDATA%\AnyCursor\config.json` (or `ANY_CURSOR_CONFIG`)
- opens the settings dashboard, the config file, and the diagnostics report

## Commands

| Command | What it does |
| --- | --- |
| `AnyCursor: Open Settings` | Opens the local settings dashboard |
| `AnyCursor: Open Configuration File` | Opens the JSON config in Cursor |
| `AnyCursor: Doctor` | Config path, gateway status, health, models and warnings |
| `AnyCursor: Start Gateway` | Forces a start attempt |
| `AnyCursor: Repair Cursor Shortcuts` | Points Desktop/Start Menu/Taskbar shortcuts at the local backend, keeping `*.lnk.anycursor.bak` backups |

## Dashboard

The gateway serves the settings UI at `http://127.0.0.1:<gateway.port>/`.

From there you can add providers (OpenAI-compatible, Anthropic, Google, Azure,
Bedrock), add models, choose effort tiers and context sizes, and watch usage.
Model and provider changes apply without a gateway restart; host, port,
upstream and data-directory changes need one.

## Privacy

Credentials stay on the machine, in Windows Credential Manager or environment
variables. BYOK traffic goes from Cursor to your provider through
`127.0.0.1`; nothing is proxied through a third-party service.

## Development

Start the gateway from the repository root:

```powershell
npm start
```

Then sideload this folder as an unpacked extension, or build the VSIX:

```powershell
npm run package:extension
```

## License

MIT. Not affiliated with Cursor or Anysphere; "Cursor" is a trademark of its
respective owner and is used only to describe compatibility.
