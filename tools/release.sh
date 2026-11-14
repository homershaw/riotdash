#!/usr/bin/env bash
# Builds an update package from the current commit: dist/mqtt-dash-<version>.tar.gz
# Upload that file in Settings → Updates (or: node server/index.js update dist/mqtt-dash-<version>.tar.gz).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
mkdir -p dist
OUT="dist/mqtt-dash-$VERSION.tar.gz"
git archive --format=tar.gz --prefix=mqtt-dash/ -o "$OUT" HEAD
echo "Built $OUT"
