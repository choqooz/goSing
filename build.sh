#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
OUTPUT="${1:-$ROOT_DIR/gosing}"
OUTPUT_DIR="$(dirname -- "$OUTPUT")"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_command corepack
require_command go
test -d "$FRONTEND_DIR" || {
  printf 'missing frontend directory: %s\n' "$FRONTEND_DIR" >&2
  exit 1
}
test -d "$OUTPUT_DIR" || {
  printf 'output parent directory does not exist: %s\n' "$OUTPUT_DIR" >&2
  exit 1
}
corepack pnpm --dir "$FRONTEND_DIR" --version >/dev/null
corepack pnpm --dir "$FRONTEND_DIR" install --frozen-lockfile
corepack pnpm --dir "$FRONTEND_DIR" run build
go build -o "$OUTPUT" ./cmd/server
