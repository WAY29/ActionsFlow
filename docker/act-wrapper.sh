#!/usr/bin/env bash
set -eu

REAL_ACT="${REAL_ACT:-/usr/local/bin/act.real}"
WORKFLOWS_DIR=""
ARGS=("$@")

for index in "${!ARGS[@]}"; do
  arg="${ARGS[$index]}"
  case "$arg" in
    --workflows)
      next_index=$((index + 1))
      WORKFLOWS_DIR="${ARGS[$next_index]:-}"
      ;;
    --workflows=*)
      WORKFLOWS_DIR="${arg#--workflows=}"
      ;;
    -W)
      next_index=$((index + 1))
      WORKFLOWS_DIR="${ARGS[$next_index]:-}"
      ;;
    -W=*)
      WORKFLOWS_DIR="${arg#-W=}"
      ;;
  esac
done

if [ -n "$WORKFLOWS_DIR" ]; then
  if [ ! -d "$WORKFLOWS_DIR" ] || [ -z "$(find "$WORKFLOWS_DIR" -type f \( -name '*.yml' -o -name '*.yaml' \) -print -quit 2>/dev/null)" ]; then
    printf '[ACT] skip: no workflow files in %s\n' "$WORKFLOWS_DIR"
    exit 0
  fi
fi

exec "$REAL_ACT" "${ARGS[@]}"
