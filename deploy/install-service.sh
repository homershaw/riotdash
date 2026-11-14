#!/usr/bin/env bash
# Run riotdash as a system service, straight from the folder it's in.
# Starts at boot, restarts if it crashes, and in-app updates keep working.
# Your config.json, logins, dashboards and history stay where they are.
#
#   bash deploy/install-service.sh              install / reinstall
#   bash deploy/install-service.sh --uninstall  remove the service (files are kept)
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
NAME=riotdash
UNIT=/etc/systemd/system/$NAME.service
RUN_AS="${SUDO_USER:-$(id -un)}"
[[ "$RUN_AS" == "root" ]] && RUN_AS="$(stat -c %U "$APP")"   # use the folder's owner rather than root

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null || die "This system doesn't use systemd, so it can't install a service."
SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"

if [[ "${1:-}" == "--uninstall" ]]; then
  say "Removing the $NAME service"
  $SUDO systemctl disable --now "$NAME" 2>/dev/null || true
  $SUDO rm -f "$UNIT"; $SUDO systemctl daemon-reload
  ok "removed (your files in $APP are untouched)"
  exit 0
fi

# Find Node.js the way this user normally runs it (works with nvm installs too)
NODE="$(sudo -u "$RUN_AS" -i sh -c 'command -v node' 2>/dev/null || true)"
[[ -z "$NODE" ]] && NODE="$(command -v node || true)"
[[ -x "$NODE" ]] || die "Node.js not found. Install Node.js 18 or newer first."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node.js 18+ is required (found $("$NODE" -v))."
[[ -f "$APP/server/index.js" ]] || die "$APP doesn't look like a riotdash folder."

say "Installing riotdash as a service"
ok "folder:  $APP"
ok "runs as: $RUN_AS"
ok "node:    $NODE ($("$NODE" -v))"

# Stop copies started by hand from a terminal, so the service can take the ports
if pgrep -u "$RUN_AS" -f "$APP/server/index.js|node server/index.js" >/dev/null 2>&1 && ! systemctl is-active --quiet "$NAME"; then
  say "Stopping the copy that's running in a terminal"
  pkill -u "$RUN_AS" -f "$APP/server/index.js|node server/index.js" || true
  sleep 2
fi

$SUDO tee "$UNIT" >/dev/null <<EOF
# Installed by riotdash deploy/install-service.sh
[Unit]
Description=riotdash (MQTT broker + dashboard)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP
ExecStart=$NODE $APP/server/index.js
Restart=on-failure
RestartSec=3
# the supervisor gets SIGTERM and stops the server itself
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$NAME" >/dev/null 2>&1
$SUDO systemctl restart "$NAME"
ok "service installed and enabled at boot"

# Wait for it to answer
PORT="$("$NODE" -e "try{const c=require('$APP/config.json');console.log(process.env.HTTP_PORT||c.http&&c.http.port||8080)}catch{console.log(8080)}")"
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    ok "riotdash is answering on port $PORT"
    printf '\n\033[1mDone.\033[0m riotdash now starts at boot.\n'
    printf '  Live log:  journalctl -u %s -f\n  Restart:   sudo systemctl restart %s\n  Stop:      sudo systemctl stop %s\n  Remove:    bash deploy/install-service.sh --uninstall\n\n' "$NAME" "$NAME" "$NAME"
    exit 0
  fi
  sleep 1
done
die "riotdash didn't answer on port $PORT. See: journalctl -u $NAME -n 40 --no-pager"
