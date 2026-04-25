#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

IMAGE="${ACTIONSFLOW_IMAGE:-actionsflow-modern-act}"
BASE_IMAGE="${ACTIONSFLOW_BASE_IMAGE:-actionsflow/actionsflow}"
PLATFORM="${ACTIONSFLOW_PLATFORM:-linux/amd64}"
DOCKERFILE="${ACTIONSFLOW_DOCKERFILE:-$PROJECT/Dockerfile.actionsflow}"

printf '[BUILD] image=%s\n' "$IMAGE"
printf '[BUILD] base=%s\n' "$BASE_IMAGE"
printf '[BUILD] platform=%s\n' "$PLATFORM"
printf '[BUILD] dockerfile=%s\n' "$DOCKERFILE"

docker build \
  --platform "$PLATFORM" \
  --build-arg BASE_IMAGE="$BASE_IMAGE" \
  -f "$DOCKERFILE" \
  -t "$IMAGE" \
  "$PROJECT"

printf '[VERIFY] act version in image\n'
docker run --rm --platform "$PLATFORM" "$IMAGE" sh -lc 'which act && act --version'
