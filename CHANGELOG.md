# Changelog

## 0.5.0
- Updates from GitHub: Settings → Updates checks github.com/homershaw/riotdash and installs a new version with one click.
- A new version is published by merging to `main` with a higher `version` in package.json.
- The ⚙ button shows a dot when an update is available.
- Optional `"channel": "stable"` under `updates` in config.json follows version tags (vX.Y.Z) instead of main.
- Install from a file is still available as a fallback.
- Documentation moved to the docs/ folder.

## 0.4.0
- In-app updates: Settings → Updates. Upload a new mqtt-dash .tar.gz and it installs and restarts itself.
- Every update keeps a backup of the previous version, with one-click rollback (last 3 kept).
- config.json and the data folder are never touched by updates. Packages now ship config.example.json instead.
- New CLI commands: `node server/index.js update <file>` and `node server/index.js set-admin-password <pw>`.

## 0.3.0
- Phone and tablet layouts for dashboards (Auto / List / Fit to width / Actual size).
- Per-widget "hide in list view" and list order.
- Explorer works on phones (Topics / Details / Publish tabs).
- Add to Home Screen support (app icon, full-screen).

## 0.2.0
- MQTT Explorer page: live topic tree, payload viewer, history chart, message list, publish, clients.

## 0.1.0
- First release: MQTT 3.1.1 broker (TCP + WebSockets), drag-and-drop dashboard editor, 17 widgets, demo simulator, Cloudflare Tunnel guide.
