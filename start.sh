#!/usr/bin/env bash
# GoSing Unified Launcher

set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
WORKER_DIR="$ROOT_DIR/worker"
WORKER_PYTHON="$WORKER_DIR/venv/bin/python"
WORKER_DEMUCS="$WORKER_DIR/venv/bin/demucs"
READY_TIMEOUT=30
CURL_TIMEOUT=3
PIDS=()
PGIDS=()
CLEANED_UP=false

log() {
  printf '[gosing] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

build_frontend_if_missing() {
  if [[ -f "$FRONTEND_DIR/dist/index.html" ]]; then
    return
  fi

  log "building frontend for Go embed"
  corepack pnpm --dir "$FRONTEND_DIR" run build || fail "frontend build failed"
}

is_service_session() {
  local pid=$1
  local session_id

  session_id="$(ps -o sid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ "$session_id" == "$pid" ]]
}

is_service_group_running() {
  local pgid=$1
  local process_group
  local state

  while read -r process_group state; do
    if [[ "$process_group" == "${pgid#-}" && "$state" != Z* ]]; then
      return 0
    fi
  done < <(ps -eo pgid=,stat= 2>/dev/null)
  return 1
}

stop_service() {
  local pgid=$1
  local attempt

  # This PGID was captured immediately after setsid. It remains the group's
  # identity while any service descendant survives, even if a wrapper exits.
  if ! is_service_group_running "$pgid"; then
    return
  fi

  kill -TERM -- "-$pgid" 2>/dev/null || true
  for ((attempt = 1; attempt <= 5; attempt++)); do
    if ! is_service_group_running "$pgid"; then
      return
    fi
    sleep 1
  done
  if is_service_group_running "$pgid"; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  local index

  if "$CLEANED_UP"; then
    return "$status"
  fi
  CLEANED_UP=true
  trap - EXIT INT TERM

  log "stopping services"
  for index in "${!PIDS[@]}"; do
    stop_service "${PGIDS[index]}"
  done
  # Do not wait indefinitely for a wrapper that is reaping descendants. Each
  # process group has already received TERM and a bounded KILL escalation.
  return "$status"
}

on_signal() {
  cleanup
  exit 130
}

start_service() {
  local name=$1
  shift
  local pid
  local pgid

  log "starting $name"
  # Keep a Bash supervisor as the session and process-group leader. Commands such
  # as pnpm may exec or fork, but this PID remains valid for the service lifetime.
  setsid bash -c '
    trap "exit 0" INT TERM
    "$@" &
    child=$!
    wait "$child"
  ' gosing-service "$@" &
  pid=$!
  if ! is_service_session "$pid"; then
    wait "$pid" 2>/dev/null || true
    fail "could not create an isolated process session for $name"
  fi
  pgid="$pid"
  PIDS+=("$pid")
  PGIDS+=("$pgid")
}

wait_for_ready() {
  local name=$1
  local url=$2
  local pid=$3
  local attempt

  for ((attempt = 1; attempt <= READY_TIMEOUT; attempt++)); do
    if curl --fail --silent --max-time "$CURL_TIMEOUT" "$url" >/dev/null; then
      log "$name is ready: $url"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      fail "$name exited before becoming ready; inspect its log above"
    fi
    sleep 1
  done

  fail "$name was not ready after ${READY_TIMEOUT}s: $url"
}

require_command go
require_command corepack
require_command curl
require_command setsid
test -d "$FRONTEND_DIR" || fail "missing frontend directory: $FRONTEND_DIR"
test -f "$FRONTEND_DIR/package.json" || fail "missing frontend/package.json"
corepack pnpm --dir "$FRONTEND_DIR" --version >/dev/null 2>&1 || fail "Corepack could not run the pinned frontend pnpm"
test -f "$WORKER_DIR/main.py" || fail "missing worker entrypoint: $WORKER_DIR/main.py"
test -x "$WORKER_PYTHON" || fail "missing worker virtualenv Python: $WORKER_PYTHON"
test -x "$WORKER_DEMUCS" || fail "missing worker Demucs executable: $WORKER_DEMUCS"
"$WORKER_PYTHON" -m uvicorn --version >/dev/null 2>&1 || fail "missing worker virtualenv Uvicorn"
"$WORKER_PYTHON" -c 'import demucs' >/dev/null 2>&1 || fail "missing worker virtualenv Demucs"
mkdir -p "$WORKER_DIR/separated" || fail "cannot create worker output directory"
test -w "$WORKER_DIR/separated" || fail "worker output directory is not writable"
build_frontend_if_missing

trap cleanup EXIT
trap on_signal INT TERM

log "starting GoSing services"
# The worker form is equivalent to `uvicorn main:app --port 8000` from worker/.
start_service "frontend (Vite :5173)" bash -c 'cd -- "$1" && exec corepack pnpm run dev' _ "$FRONTEND_DIR"
start_service "worker (FastAPI :8000)" bash -c 'cd -- "$1" && PATH="$2:$PATH" exec "$3" -m uvicorn main:app --port 8000' _ "$WORKER_DIR" "$WORKER_DIR/venv/bin" "$WORKER_PYTHON"
start_service "backend (Go :8080)" bash -c 'cd -- "$1" && exec go run cmd/server/main.go' _ "$ROOT_DIR"

wait_for_ready "frontend" "http://127.0.0.1:5173/" "${PIDS[0]}"
wait_for_ready "worker" "http://127.0.0.1:8000/ready" "${PIDS[1]}"
wait_for_ready "backend" "http://127.0.0.1:8080/api/health" "${PIDS[2]}"
log "all checked services are ready; press Ctrl+C to stop"

wait -n "${PIDS[@]}"
fail "a service exited; inspect its log above"
