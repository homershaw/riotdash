# Changelog

## 0.12.0
- **Raw well history to cycles:** `tools/hist-to-cycles.js` turns historian exports (time, tag, value) into cycle records for import, finding each cycle from the valve and flow. See [Raw history](docs/cycles.md#raw-history-time-tag-value).
- **Advisor replay:** `tools/advisor-replay.js` shows what the Advisor would have flagged, day by day, over a well's whole history.
- **Advisor tuned on 17 months of two real wells:** line pressure must rise 100 kPa and 25 % (daily swings on low-pressure lines were flagged before); gas down needs 25 %. New note **Cycle timing changed** shows a shut-in or flow-time change with gas before and after, and is linked to line pressure or failed arrivals when those explain it.

## 0.11.0
- **Page template per model.** On the Riots page, **Use as template** saves a controller's page as the layout for its model. Controllers of that model approved afterwards get a copy pointed at their own topics, page and name, and **Rebuild page** uses it. It can be applied right away to the other controllers of the model. See [Page template](docs/riots.md#page-template-the-same-layout-for-every-controller-of-a-model).

## 0.10.1
Fixes from the C56E mode tests (Dash Issue 1-1):
- **Pre-flow** shows correctly on the Plunger lift panel: a **PRE-FLOW** banner and the Pre-flow on timer (SPT3.6 against SPT1.15) while the valve is open, then SHUT IN with the Pre-flow off timer (SPT3.7 against SPT1.16). Before, the panel showed the idle Time On or Time Off timer.
- Bypass cycles (time on bypass, time off bypass, backup time off) show their own timer too.
- The Cycles page names mode status codes as OPT 7.02 does (for example 2012 Post plunger sales, 2016 Extended shut-in). The Advisor no longer counts Extended shut-in as a line pressure high cycle.

## 0.10.0
- **Advisor** on the Cycles page: checks each well's last 48 h of cycles against the 14 days before and reports what it finds, with numbers, the likely cause, what to consider, and the cycles behind it. It finds slow casing build-up (tubing leak), higher line pressure, a velocity creep (worn plunger), fast or slow arrivals against target, rising late and failed arrivals (liquid loading), lower gas, and wells that stopped cycling. It never changes anything. See [Advisor](docs/cycles.md#advisor).
- **Demo wells** for trying it: six simulated wells, each with one known problem. Load and remove them on the Cycles page.
- The wells list shows each well's worst finding.

## 0.9.0
- **Plunger cycle history.** Controllers can publish one record per cycle on `riot/<id>/opt/cycle`. riotdash stores them per well and shows them on the new **Cycles** page: cycles and gas per day, arrival results, velocity, shut-in and flow times, and the most recent cycles. See [Plunger cycles](docs/cycles.md).
- **Import other wells' history** from CSV, on the Cycles page or with `node server/index.js import-cycles <file.csv>`. Re-importing skips rows already there.

## 0.8.1
- A user whose `publish` ACL names `riot/<id>/opt/set` can now publish it after logging in through Cloudflare, even with MQTT auth off on your network. Before, the ACL only counted when `auth.enabled` was on.

## 0.8.0
- **Change optimizer settings from the dashboard.** The Plunger lift panel has a **⚙ Settings** button: start or stop the optimizer, and change any R/W soft point (setpoints, mode, tuning limits). riotdash confirms the change with you, sends it to the controller (`riot/<id>/opt/set`), and shows the controller's answer: applied, or why it was refused. Writes must also be turned on at the controller. See [Changing optimizer settings](docs/riots.md#changing-optimizer-settings).
- Every change is logged (who, old → new, result) and listed under **Recent changes**.
- From the internet only logged-in users can change settings. Other MQTT clients can't publish `riot/+/opt/set` directly unless their ACL allows it. New `config.json` options: `riot.allowWrites`, `riot.protectSetTopics`, `riot.writeTimeoutMs`.
- A second optimizer run (`riot/<id>/opt/run2/…`) gets its own Plunger lift panel and trend.

## 0.7.3
The plunger lift panel now matches the controller's own Well Optimization page.
- Critical flow shows the manual setpoint, marked *(manual)*, when the manual override is on. Otherwise it shows the calculated value.
- When the M31 module is offline, the well valve shows **UNKNOWN** with a warning ("Valve feedback unknown (M31 offline)"), instead of CLOSED. The valve soft point reads 0 in that case. The FLOWING / SHUT IN banner then follows the optimizer's cycle.
- A finished timer stays at its setpoint (for example, time off 10.0 of 10.0 during a Line Pressure High cycle) instead of counting past it.
- The panel shows the program version (OPT 7.02.00).

## 0.7.2
- Fix: OPT 7.02 wells showed STOPPED on the plunger lift panel while running. OPT 7.02 reports running as program status 1 (the OPT 5 port uses 3); both now count as running.
- Fix: ESD showed as TRIPPED on wells without an ESD input. The ESD soft point reads 0 when no ESD is bound, so riotdash now judges ESD from the program error (117 well ESD, 116 invalid ESD input), the same as the optimizer. Program errors are shown by name.

## 0.7.1
- The plunger lift panel and optimizer trend also work with controllers that send the optimizer as soft points (`riot/<id>/opt/SPT0`–`SPT5`, the SCADAPack OPT register map). riotdash assembles the panel from them: the timers count down in the soft points and are shown as elapsed against their setpoint, and plunger trips come from SPT4. Program status 5 (fast plunger) and 7 (line pressure high) show as SHUT IN with the reason.

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
