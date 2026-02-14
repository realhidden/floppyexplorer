#!/usr/bin/env bash
# Build Floppy Explorer .app, clear quarantine, and launch it.
# Usage: ./run.sh [--no-build]

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Floppy Explorer"
DIST_DIR="dist"
APP_PATH="$DIST_DIR/$APP_NAME.app"
MACOS_DIR="$APP_PATH/Contents/MacOS"

# ── Kill any running instance ──
pkill -f "floppy-explorer" 2>/dev/null && echo "Killed running instance" || true
lsof -ti:3141 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.3

# ── Build (unless --no-build) ──
if [[ "${1:-}" != "--no-build" ]]; then
  echo "Building with Neutralino..."
  neu build --release
  echo "Build complete."
fi

# ── Check that .app exists ──
if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: $APP_PATH not found. Run without --no-build first."
  exit 1
fi

# ── Bundle Node server + deps into .app ──
echo "Bundling server into app..."
cp server.js "$MACOS_DIR/"
cp package.json "$MACOS_DIR/"
cp -R lib "$MACOS_DIR/"
cp -R node_modules "$MACOS_DIR/"
cp -R ui "$MACOS_DIR/"

# ── Remove macOS quarantine flag ──
echo "Clearing quarantine flag..."
xattr -cr "$APP_PATH"

# ── Start the Node server (the app's loading.html polls for it) ──
echo "Starting server..."
node "$MACOS_DIR/server.js" &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 20); do
  curl -s http://localhost:3141/api/config >/dev/null 2>&1 && break
  sleep 0.25
done

# ── Launch the app ──
echo "Launching $APP_NAME..."
open "$APP_PATH"

# ── Wait for the app to close, then stop the server ──
echo "Server running (PID $SERVER_PID). Press Ctrl+C to stop."
trap "kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID 2>/dev/null
