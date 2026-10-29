# AnyCursor extension

Cursor extension that supervises the local AnyCursor gateway.

## What it does

- activates when Cursor starts
- reads `%LOCALAPPDATA%\AnyCursor\config.json` (or `ANY_CURSOR_CONFIG`)
- checks the gateway health endpoint
- starts the gateway when it is not running and restarts it after a crash
- runs the packaged gateway from `vendor/anycursor`, so no source checkout is
  needed after installation

## Commands

- `AnyCursor: Open Settings` — opens the local web settings UI
- `AnyCursor: Open Configuration File` — opens the JSON config in Cursor
- `AnyCursor: Doctor` — config, gateway path, health, models and warnings
- `AnyCursor: Start Gateway` — force a start attempt
- `AnyCursor: Repair Cursor Shortcuts` — updates Desktop/Start Menu/Taskbar
  shortcuts with `--test-backend-url` and keeps `*.lnk.anycursor.bak` backups

## Configuration and dashboard

The gateway serves the dashboard and settings UI at
`http://127.0.0.1:<gateway.port>/`. Host, port, upstream and data directory are
read from the config file; model and provider changes apply without restart.

## Development

The extension falls back to `config/anycursor.json` in the repo when the
per-user config does not exist. Start the gateway manually:

```powershell
npm start
```

Then sideload this folder as an unpacked extension, or package it from the
repository root:

```powershell
npm run package:extension
```
