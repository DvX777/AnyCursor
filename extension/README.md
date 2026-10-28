# AnyCursor extension

Cursor extension that supervises the local AnyCursor gateway.

Current scope:

- activates on Cursor startup
- reads `%LOCALAPPDATA%\AnyCursor\config.json` (or `ANY_CURSOR_CONFIG`)
- checks the gateway health endpoint
- starts the gateway if it is not running
- exposes commands:
  - `AnyCursor: Open Settings`
  - `AnyCursor: Doctor`
  - `AnyCursor: Start Gateway`
  - `AnyCursor: Repair Cursor Shortcuts` (placeholder)

The extension does not modify Cursor state. Shortcut patching and the full
settings UI are the next lifecycle steps.

## Development

The extension falls back to `config/anycursor.json` in the repo when the
per-user config does not exist. Start the gateway manually:

```powershell
npm start
```

Then sideload this folder as an unpacked extension, or package it with `vsce`.
