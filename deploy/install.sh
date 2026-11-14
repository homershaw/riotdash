#!/usr/bin/env bash
# Installs MQTT Dash as a systemd service on Linux.
# Usage: sudo ./deploy/install.sh [--with-simulator]
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/mqtt-dash CONF=/etc/mqtt-dash DATA=/var/lib/mqtt-dash

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }
command -v node >/dev/null || { echo "Node.js 18+ is required (e.g. sudo apt install nodejs, or https://nodejs.org)"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 18 )) || { echo "Node.js 18+ required, found $(node -v)"; exit 1; }

id mqttdash &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin mqttdash
mkdir -p "$APP" "$CONF" "$DATA"
for f in server public tools deploy package.json README.md CHANGELOG.md config.example.json; do
  [[ -e "$SRC/$f" ]] && { rm -rf "$APP/$f"; cp -r "$SRC/$f" "$APP/"; }
done
# Never overwrite an existing config
[[ -f "$CONF/config.json" ]] || cp "$SRC/config.example.json" "$CONF/config.json"
# The service user owns the app folder so in-app updates can replace it
chown -R mqttdash:mqttdash "$DATA" "$APP"
chmod 640 "$CONF/config.json"; chgrp mqttdash "$CONF/config.json"

cp "$SRC/deploy/mqtt-dash.service" /etc/systemd/system/
if [[ "${1:-}" == "--with-simulator" ]]; then cp "$SRC/deploy/mqtt-dash-simulator.service" /etc/systemd/system/; fi
systemctl daemon-reload
systemctl enable --now mqtt-dash
[[ "${1:-}" == "--with-simulator" ]] && systemctl enable --now mqtt-dash-simulator

[[ -d /usr/share/applications ]] && cp "$SRC/deploy/mqtt-dash.desktop" /usr/share/applications/ || true

echo
echo "MQTT Dash installed."
echo "  Dashboard : http://localhost:8080/"
echo "  MQTT TCP  : mqtt://<this-host>:1883"
echo "  MQTT WS   : ws://<this-host>:8080/mqtt"
echo "  Config    : $CONF/config.json   (then: sudo systemctl restart mqtt-dash)"
echo "  Logs      : journalctl -u mqtt-dash -f"
echo "  Updates   : Dashboard > Settings > Updates (set an admin password the first time)"
