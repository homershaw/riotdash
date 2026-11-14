# Changelog

## 0.6.4
- `bash deploy/install-service.sh` runs riotdash as a system service straight from its folder. It starts at boot, restarts on crashes, and keeps your config and data where they are. `--uninstall` removes it.
- A clear message instead of a crash when a port is already in use ("riotdash may already be running").

## 0.6.3
- Fix: "Updates" hanging and "fetch failed" on networks without working IPv6. riotdash now prefers IPv4 for outgoing connections (GitHub, Cloudflare).
- Cloudflare setup writes `protocol: http2` to the tunnel config, so it works on networks that block QUIC/UDP. It also uses IPv4 for the tunnel when the machine has no public IPv6, and waits until the tunnel has actually connected before reporting success.

## 0.6.2
- Cloudflare setup installs cloudflared from Cloudflare's apt/yum package repository (it then updates with the rest of the system), falling back to a curl/wget download. This fixes "Could not install cloudflared: fetch failed".
- Clearer error messages when a download fails.

## 0.6.1
- Fix: scripts such as `deploy/cloudflare/setup.sh` kept their "executable" permission after an in-app update. Updating to this version also fixes the scripts installed by the 0.6.0 update.

## 0.6.0
- One-command Cloudflare setup: `./deploy/cloudflare/setup.sh --hostname dash.example.com`. You log in to Cloudflare with a link (no API token needed); the script then creates the tunnel and DNS record, runs cloudflared as a service and checks the site. `--token` uses an API token instead.
- Internet visitors must log in. Anything arriving through Cloudflare needs a riotdash username/password, for both the dashboard and MQTT. Your home network works as before.
- Browsers that have logged in connect to MQTT automatically.
- New commands: `add-user`, `list-users`, `remove-user`. Changes to config.json logins apply without a restart.

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
