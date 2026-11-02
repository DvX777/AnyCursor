# AnyCursor

<img src="https://raw.githubusercontent.com/DvX777/AnyCursor/main/extension/assets/banner.png?v=0.3.9" alt="AnyCursor" height="56">

Use your own models inside Cursor — with Cursor's native Agent, tools, MCP,
subagents and approvals.

This extension supervises the local AnyCursor gateway that makes that possible.
It is not a second app: you open Cursor the normal way and switch between
Cursor's own models and your BYOK models in the native model picker.

> Cursor's default Agent Window does not load third-party extensions, so this
> extension activates in an IDE window (`Cursor.exe --classic`). Your models keep
> working in the Agent Window anyway: the gateway and its watchdog run
> independently, and only these commands are IDE-only.
>
> Hosting the gateway on a VPS or another machine? Set `cursor.supervise` to
> `false` and point `cursor.backendUrl` at the server; the extension checks it
> instead of starting its own gateway.

## What it does

- starts with Cursor and supervises the gateway
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
variables. BYOK traffic goes from Cursor to your provider through the gateway;
nothing is proxied through a third-party service.

By default the gateway refuses to forward Cursor's analytics, metrics, traces
and log uploads, even though Cursor sends them to the same backend URL. Only the
blocked path is logged. See the repository README, "Cursor updates and
telemetry", for the optional hosts-file block and its limits.

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
