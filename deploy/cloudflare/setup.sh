#!/usr/bin/env bash
# Publish riotdash through a Cloudflare Tunnel. Runs tools/cloudflare-setup.js with sudo
# using the same Node.js you normally use (works with nvm installs too).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node.js not found"; exit 1; }
if [[ $EUID -eq 0 ]]; then exec "$NODE" "$DIR/tools/cloudflare-setup.js" "$@"; fi
exec sudo --preserve-env=CLOUDFLARE_API_TOKEN,HTTP_PORT,MQTTDASH_CONFIG "$NODE" "$DIR/tools/cloudflare-setup.js" "$@"
