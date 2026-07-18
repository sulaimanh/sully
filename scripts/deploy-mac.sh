#!/usr/bin/env bash
# Build the app and install it into /Applications, replacing the running copy.
set -euo pipefail
cd "$(dirname "$0")/.."

npx electron-vite build
npx electron-builder --dir

osascript -e 'quit app "Sully"' >/dev/null 2>&1 || true
sleep 1
rm -rf /Applications/Sully.app
ditto dist/mac-arm64/Sully.app /Applications/Sully.app
open /Applications/Sully.app
echo "Deployed Sully to /Applications and relaunched."
