#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

cd "$APP_DIR"

node "$SCRIPT_DIR/check-package-lock.mjs"
STAGE_DIR="$(node "$SCRIPT_DIR/prepare-railway-deploy.mjs")"

cleanup() {
  if [[ "${KEEP_STAGE_DIR:-0}" == "1" ]]; then
    echo "Keeping staged Railway deploy dir: $STAGE_DIR"
    return
  fi
  rm -rf "$STAGE_DIR"
}

trap cleanup EXIT

declare -a railway_cmd
railway_cmd=(railway up "$STAGE_DIR" --path-as-root --detach)

if [[ -n "${RAILWAY_PROJECT_ID:-}" ]]; then
  railway_cmd+=(-p "$RAILWAY_PROJECT_ID")
fi
if [[ -n "${RAILWAY_ENVIRONMENT_ID:-}" ]]; then
  railway_cmd+=(-e "$RAILWAY_ENVIRONMENT_ID")
fi
if [[ -n "${RAILWAY_SERVICE_ID:-}" ]]; then
  railway_cmd+=(-s "$RAILWAY_SERVICE_ID")
fi
if [[ -n "${RAILWAY_DEPLOY_MESSAGE:-}" ]]; then
  railway_cmd+=(-m "$RAILWAY_DEPLOY_MESSAGE")
fi

echo "Deploying staged Railway bundle from $STAGE_DIR"
"${railway_cmd[@]}"
