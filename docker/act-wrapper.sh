#!/usr/bin/env bash
set -eu

REAL_ACT="${REAL_ACT:-/usr/local/bin/act.real}"
WORKFLOWS_DIR=""
HAS_BIND=false
ARGS=("$@")

for index in "${!ARGS[@]}"; do
  arg="${ARGS[$index]}"
  case "$arg" in
    --bind|-b)
      HAS_BIND=true
      ;;
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

if [ "${ACTIONSFLOW_ACT_ISOLATE:-false}" = "true" ] && [ "$HAS_BIND" = "true" ]; then
  PROJECT_ROOT="${ACTIONSFLOW_ACT_PROJECT:-${ACTIONSFLOW_PROJECT:-$PWD}}"
  DEBUG_WORKSPACE="${ACTIONSFLOW_ACT_WORKSPACE:-$PROJECT_ROOT/.tmp/actionsflow-act-workspace}"

  case "$DEBUG_WORKSPACE" in
    "$PROJECT_ROOT"/.tmp/*) ;;
    *)
      printf '[ACT] error: ACTIONSFLOW_ACT_WORKSPACE must be under %s/.tmp: %s\n' "$PROJECT_ROOT" "$DEBUG_WORKSPACE" >&2
      exit 1
      ;;
  esac

  rm -rf "$DEBUG_WORKSPACE"
  mkdir -p "$DEBUG_WORKSPACE"
  (
    cd "$PROJECT_ROOT"
    tar \
      --exclude="./node_modules" \
      --exclude="./.actionsflow" \
      --exclude="./.tmp" \
      --exclude="./.DS_Store" \
      --exclude="./.env" \
      --exclude="./.secrets" \
      -cf - .
  ) | (cd "$DEBUG_WORKSPACE" && tar -xf -)

  printf '[ACT] isolated bind workspace: %s\n' "$DEBUG_WORKSPACE"
  cd "$DEBUG_WORKSPACE"
fi

exec "$REAL_ACT" "${ARGS[@]}"
