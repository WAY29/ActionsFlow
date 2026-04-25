#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export ACTIONSFLOW_WORKFLOW="${ACTIONSFLOW_WORKFLOW:-rss-codex-cubox.yml}"

exec "$SCRIPT_DIR/debug-actionsflow.sh" "$@"
