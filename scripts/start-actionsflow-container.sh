#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

CONTAINER="${ACTIONSFLOW_CONTAINER:-actionsflow}"
IMAGE="${ACTIONSFLOW_IMAGE:-actionsflow-modern-act}"
PLATFORM="${ACTIONSFLOW_PLATFORM:-linux/amd64}"
HOST_PORT="${ACTIONSFLOW_HOST_PORT:-30001}"
CONTAINER_PORT="${ACTIONSFLOW_CONTAINER_PORT:-3000}"
ACT_IMAGE="${ACTIONSFLOW_ACT_IMAGE:-ghcr.io/catthehacker/ubuntu:act-latest}"
INTERVAL="${ACTIONSFLOW_INTERVAL:-5}"

printf '[START] container=%s\n' "$CONTAINER"
printf '[START] image=%s\n' "$IMAGE"
printf '[START] platform=%s\n' "$PLATFORM"
printf '[START] project=%s\n' "$PROJECT"
printf '[START] port=%s:%s\n' "$HOST_PORT" "$CONTAINER_PORT"
printf '[START] act image=%s\n' "$ACT_IMAGE"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  printf '[START] removing existing container: %s\n' "$CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null
fi

docker run -d --name "$CONTAINER" \
  --platform "$PLATFORM" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PROJECT:$PROJECT" \
  -w "$PROJECT" \
  -p "$HOST_PORT:$CONTAINER_PORT" \
  "$IMAGE" \
  actionsflow start \
    --cwd "$PROJECT" \
    --interval "$INTERVAL" \
    --port "$CONTAINER_PORT" \
    -- \
    --bind \
    --container-architecture "$PLATFORM" \
    -P "ubuntu-latest=$ACT_IMAGE" \
    -P "ubuntu-18.04=$ACT_IMAGE"

printf '[VERIFY] container started\n'
docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

printf '[VERIFY] act version in container\n'
docker exec "$CONTAINER" sh -lc 'which act && act --version'
