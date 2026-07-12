#!/usr/bin/env bash
set -euo pipefail

PIDS=""

log() {
  printf '[nice-ocr] %s\n' "$*"
}

stop_all() {
  log "stopping services"
  if [ -n "$PIDS" ]; then
    # shellcheck disable=SC2086
    kill -TERM $PIDS 2>/dev/null || true
    wait $PIDS 2>/dev/null || true
  fi
}

start_service() {
  local name="$1"
  shift

  log "starting $name"
  "$@" &
  local pid="$!"
  PIDS="$PIDS $pid"
  log "$name pid=$pid"
}

trap 'stop_all; exit 143' TERM
trap 'stop_all; exit 130' INT

mkdir -p "${STORAGE_DIR:-/data/storage}"
if [[ "${DATABASE_URL:-}" == file:* ]]; then
  mkdir -p "$(dirname "${DATABASE_URL#file:}")"
fi

log "syncing database schema"
pnpm db:push

if [ "${ENABLE_OCR_LAYOUT:-1}" = "1" ]; then
  start_service "ocr-layout" /opt/ocr-layout-venv/bin/python /app/tools/ocr-layout/server.py
else
  log "ocr-layout disabled by ENABLE_OCR_LAYOUT=${ENABLE_OCR_LAYOUT:-}"
  unset OCR_LAYOUT_URL
fi

start_service "worker" pnpm exec tsx scripts/worker.ts
start_service "web" pnpm start

set +e
while true; do
  for pid in $PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      status="$?"
      log "service pid=$pid exited with status $status"
      stop_all
      exit "$status"
    fi
  done
  sleep 2
done
