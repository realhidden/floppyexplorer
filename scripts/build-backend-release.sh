#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="$ROOT_DIR/build/backend"

mkdir -p "$OUT_DIR"

npx pkg "$ROOT_DIR" --targets node18-macos-arm64 --output "$OUT_DIR/floppy-backend-macos-arm64"
npx pkg "$ROOT_DIR" --targets node18-macos-x64 --output "$OUT_DIR/floppy-backend-macos-x64"
npx pkg "$ROOT_DIR" --targets node18-win-x64 --output "$OUT_DIR/floppy-backend-win-x64.exe"
