#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
BACKEND_DIR="$APP_ROOT/backend"
BACKEND_BIN=""

ARCH=$(uname -m)

case "$ARCH" in
  arm64|aarch64)
    if [ -x "$BACKEND_DIR/floppy-backend" ]; then
      BACKEND_BIN="$BACKEND_DIR/floppy-backend"
    elif [ -x "$BACKEND_DIR/floppy-backend-arm64" ]; then
      BACKEND_BIN="$BACKEND_DIR/floppy-backend-arm64"
    fi
    ;;
  x86_64|amd64)
    if [ -x "$BACKEND_DIR/floppy-backend" ]; then
      BACKEND_BIN="$BACKEND_DIR/floppy-backend"
    elif [ -x "$BACKEND_DIR/floppy-backend-x64" ]; then
      BACKEND_BIN="$BACKEND_DIR/floppy-backend-x64"
    fi
    ;;
esac

if [ -z "$BACKEND_BIN" ] && [ -x "$BACKEND_DIR/floppy-backend-linux-x64" ]; then
  BACKEND_BIN="$BACKEND_DIR/floppy-backend-linux-x64"
fi

if [ -n "$BACKEND_BIN" ]; then
  exec "$BACKEND_BIN"
fi

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$APP_ROOT/server.js"
fi

echo "[ext] No backend binary found under $BACKEND_DIR and no system node is available for development fallback." >&2
exit 1
