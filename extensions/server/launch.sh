#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MAIN_JS="$SCRIPT_DIR/main.js"

ARCH=$(uname -m)
NODE_BIN=""

case "$ARCH" in
  arm64|aarch64)
    if [ -x "$APP_ROOT/runtime/node-darwin-arm64/bin/node" ]; then
      NODE_BIN="$APP_ROOT/runtime/node-darwin-arm64/bin/node"
    fi
    ;;
  x86_64|amd64)
    if [ -x "$APP_ROOT/runtime/node-darwin-x64/bin/node" ]; then
      NODE_BIN="$APP_ROOT/runtime/node-darwin-x64/bin/node"
    fi
    ;;
esac

if [ -z "$NODE_BIN" ] && [ -x "$APP_ROOT/runtime/node-linux-x64/bin/node" ]; then
  NODE_BIN="$APP_ROOT/runtime/node-linux-x64/bin/node"
fi

if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
fi

if [ -z "$NODE_BIN" ]; then
  echo "[ext] No Node runtime found. Expected a bundled runtime under $APP_ROOT/runtime or a system node in PATH." >&2
  exit 1
fi

exec "$NODE_BIN" "$MAIN_JS"
