# Changelog

## 0.7.1
- The plunger lift panel and optimizer trend also work with controllers that send the optimizer as soft points (`riot/<id>/opt/SPT0`–`SPT5`, the SCADAPack OPT register map). riotdash assembles the panel from them: the timers count down in the soft points and are shown as elapsed against their setpoint, and plunger trips come from SPT4. Running is program status 1 (OPT 7.02) or 3 (OPT 5 port). Program status 5 (fast plunger) and 7 (line pressure high) show as SHUT IN with the reason.

## 0.7.0
- **RIOT controllers are recognised automatically.** A controller publishing `riot/<id>/info` appears on the new **Riots** page as *waiting for approval*, with its model, firmware, MAC, I/O and a live preview.
- **Approve to get a page.** riotdash builds the controller's page from its description (pressure gauges scaled to each Tag's range, flow, outputs, inputs, calculated values, 6-hour trends) and adds a tile to the **Riots** overview.
- **Telemetry decoding.** The 2-Tag telemetry messages become one retained topic per Tag (`riot/<id>/tag/<name>`), with quality, plus Optimizer soft points. Trends and the Explorer work on them.
- **Plunger lift panel and optimizer trend** for OPT 7.02 wells, modelled on the controller's ePaper screens. They're added automatically when a well sends `riot/<id>/opt7/1`. The overview tile shows FLOWING / SHUT IN with gas flow and casing.
- **Friendly names** per model profile (once for every Optimization Well) and per controller.
- **Clickable widgets.** Any widget can open another dashboard when tapped (*Click opens dashboard* in the editor).
- `tools/riot-sim.js` simulates an ESP32-S31-OPT for testing.
- Phones hide the layout menu, and the header uses less space.

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
