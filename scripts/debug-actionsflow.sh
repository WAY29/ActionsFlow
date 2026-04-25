#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="${ACTIONSFLOW_CONTAINER:-actionsflow}"
PROJECT="${ACTIONSFLOW_PROJECT:-/Users/lang/ActionsFlow}"
DEST="${ACTIONSFLOW_DEST:-dist/manual-actionsflow}"
BUILD_TIMEOUT="${ACTIONSFLOW_BUILD_TIMEOUT:-900}"
ACT_IMAGE="${ACTIONSFLOW_ACT_IMAGE:-ghcr.io/catthehacker/ubuntu:act-latest}"
ARCH="${ACTIONSFLOW_ARCH:-linux/amd64}"

ACTION="${1:-run}"
if [ "$#" -gt 0 ]; then
  shift
fi

WORKFLOWS=()
ACT_ARGS=()
PARSE_ACT_ARGS=false
for arg in "$@"; do
  if [ "$arg" = "--" ]; then
    PARSE_ACT_ARGS=true
    continue
  fi
  if [ "$PARSE_ACT_ARGS" = true ]; then
    ACT_ARGS+=("$arg")
  else
    WORKFLOWS+=("$arg")
  fi
done

if [ "$ACTION" = "act" ] && [ "${#ACT_ARGS[@]}" -eq 0 ] && [ "${#WORKFLOWS[@]}" -gt 0 ]; then
  ACT_ARGS=("${WORKFLOWS[@]}")
  WORKFLOWS=()
fi

if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
  ENV_WORKFLOWS="${ACTIONSFLOW_WORKFLOWS:-${ACTIONSFLOW_WORKFLOW:-}}"
  if [ -n "$ENV_WORKFLOWS" ]; then
    for workflow in $ENV_WORKFLOWS; do
      WORKFLOWS+=("$workflow")
    done
  fi
fi

for workflow in "${WORKFLOWS[@]}"; do
  if [ "$workflow" = "all" ] || [ "$workflow" = "*" ]; then
    WORKFLOWS=()
    break
  fi
done

log() {
  printf '[%s] %s\n' "$1" "$2"
}

die() {
  log "ERROR" "$1"
  exit 1
}

usage() {
  cat <<EOF
用法:
  $0 run [workflow ...] [-- act 参数...]       构建并执行。无 workflow 表示全部
  $0 build [workflow ...]                     只执行 actionsflow build
  $0 act [-- act 参数...]                     执行上一次 build 生成的 workflow
  $0 trigger <workflow>                       只跑 workflow 的 script trigger 脚本
  $0 inspect                                  查看容器、挂载、Node、Actionsflow 状态
  $0 list                                     列出 workflows/*.yml
  $0 clean-cache [workflow ...]               删除指定 workflow 缓存。无 workflow 表示全部
  $0 kill-act                                 强制删除 act job 容器
  $0 logs                                     跟踪 actionsflow 主容器日志
  $0 shell                                    进入 actionsflow 主容器项目目录

示例:
  $0 run rss-codex-cubox.yml
  $0 build readwise-weekly
  $0 run                                      构建并执行所有 workflow
  $0 run rss-codex-cubox.yml -- -j digest
  ACTIONSFLOW_BUILD_TIMEOUT=300 $0 build rss-codex-cubox.yml

环境变量:
  ACTIONSFLOW_CONTAINER=$CONTAINER
  ACTIONSFLOW_PROJECT=$PROJECT
  ACTIONSFLOW_DEST=$DEST
  ACTIONSFLOW_BUILD_TIMEOUT=$BUILD_TIMEOUT
  ACTIONSFLOW_ACT_IMAGE=$ACT_IMAGE
  ACTIONSFLOW_ARCH=$ARCH
EOF
}

ensure_container() {
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "找不到容器: $CONTAINER"
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]; then
    die "容器未运行: $CONTAINER"
  fi
}

normalize_workflow() {
  local name="$1"

  name="${name#workflows/}"
  if [[ "$name" != *.yml && "$name" != *.yaml ]]; then
    if [ -f "$PROJECT/workflows/$name.yml" ]; then
      name="$name.yml"
    elif [ -f "$PROJECT/workflows/$name.yaml" ]; then
      name="$name.yaml"
    fi
  fi

  [ -f "$PROJECT/workflows/$name" ] || die "找不到 workflow: workflows/$name"
  printf '%s\n' "$name"
}

normalized_workflows() {
  local workflow
  for workflow in "${WORKFLOWS[@]}"; do
    normalize_workflow "$workflow"
  done
}

workflow_label() {
  if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
    printf 'all'
  else
    local joined=""
    local workflow
    for workflow in $(normalized_workflows); do
      if [ -z "$joined" ]; then
        joined="$workflow"
      else
        joined="$joined,$workflow"
      fi
    done
    printf '%s' "$joined"
  fi
}

include_env_value() {
  if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
    printf ''
  else
    normalized_workflows | paste -sd ',' -
  fi
}

act_args_env_value() {
  if [ "${#ACT_ARGS[@]}" -eq 0 ]; then
    printf ''
  else
    printf '%s\n' "${ACT_ARGS[@]}" | paste -sd $'\037' -
  fi
}

container_bash() {
  docker exec -i \
    -e PROJECT="$PROJECT" \
    -e DEST="$DEST" \
    -e BUILD_TIMEOUT="$BUILD_TIMEOUT" \
    -e ACT_IMAGE="$ACT_IMAGE" \
    -e ARCH="$ARCH" \
    -e ACTIONSFLOW_INCLUDE="$(include_env_value)" \
    -e ACTIONSFLOW_ACT_ARGS="$(act_args_env_value)" \
    "$CONTAINER" bash -lc "$1"
}

cmd_list() {
  find "$PROJECT/workflows" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print | sed "s#^$PROJECT/workflows/##" | sort
}

cmd_inspect() {
  ensure_container
  log "HOST" "容器启动命令"
  docker inspect "$CONTAINER" --format 'Path={{.Path}} Args={{json .Args}} Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}} WorkingDir={{.Config.WorkingDir}}'
  log "HOST" "挂载"
  docker inspect "$CONTAINER" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
  log "CONTAINER" "项目状态"
  container_bash '
set -Eeuo pipefail
cd "$PROJECT"
printf "[PWD] %s\n" "$PWD"
printf "[NODE] "; node -v
printf "[NPM] "; npm -v
printf "[ACTIONSFLOW] "; actionsflow --version
printf "[WORKFLOWS]\n"
find workflows -maxdepth 1 -type f \( -name "*.yml" -o -name "*.yaml" \) -print | sort
printf "[CACHES]\n"
find .actionsflow/caches -maxdepth 2 -type d -print 2>/dev/null | sort || true
'
}

cmd_clean_cache() {
  ensure_container
  log "WARN" "删除缓存；如果主容器 cron 正在跑，建议随后 docker restart $CONTAINER"
  if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
    rm -rf "$PROJECT/.actionsflow/caches"
    log "DONE" "已删除全部 Actionsflow 缓存"
    return
  fi

  container_bash '
set -Eeuo pipefail
cd "$PROJECT"
node - <<'"'"'NODE'"'"'
const { cleanCache } = require("actionsflow-core")
const workflows = process.env.ACTIONSFLOW_INCLUDE
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)

;(async () => {
  for (const workflowRelativePath of workflows) {
    await cleanCache({ cwd: process.env.PROJECT, workflowRelativePath })
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
NODE
'
}

cmd_trigger() {
  ensure_container
  if [ "${#WORKFLOWS[@]}" -ne 1 ]; then
    die "trigger 命令必须且只能指定一个 workflow"
  fi
  log "TRIGGER" "只运行 $(workflow_label) 的 script trigger；若这里卡住，build 卡住点就在 trigger"
  container_bash '
set -Eeuo pipefail
cd "$PROJECT"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout --foreground "$BUILD_TIMEOUT")
else
  TIMEOUT_CMD=()
fi
"${TIMEOUT_CMD[@]}" node - <<'"'"'NODE'"'"'
const path = require("path")
const yaml = require("js-yaml")
const fs = require("fs")
const { getTriggerHelpers } = require("actionsflow-core")
const ScriptTrigger = require("actionsflow/dist/src/triggers/script").default

const workflowRelativePath = process.env.ACTIONSFLOW_INCLUDE
const workflowPath = path.join(process.env.PROJECT, "workflows", workflowRelativePath)
const doc = yaml.safeLoad(fs.readFileSync(workflowPath, "utf8"))
const scriptOptions = doc && doc.on && doc.on.script

if (!scriptOptions) {
  console.error(`workflow ${workflowRelativePath} 没有 on.script trigger`)
  process.exit(1)
}

const helpers = getTriggerHelpers({
  name: "script",
  workflowRelativePath,
  logLevel: "debug",
})
const trigger = new ScriptTrigger({ helpers, options: scriptOptions })

Promise.resolve(trigger.run()).then((items) => {
  const list = Array.isArray(items) ? items : (items && items.items) || []
  console.log(JSON.stringify({ count: list.length, first: list[0] || null }, null, 2))
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
NODE
'
}

cmd_build() {
  ensure_container
  log "BUILD" "开始构建 $(workflow_label)，超时 ${BUILD_TIMEOUT}s"
  container_bash '
set -Eeuo pipefail
cd "$PROJECT"
rm -rf "$DEST"
printf "[BUILD] cwd=%s\n" "$PWD"
printf "[BUILD] dest=%s\n" "$DEST"
cmd=(actionsflow build --cwd "$PROJECT" --force --dest "$DEST" --verbose)
if [ -n "$ACTIONSFLOW_INCLUDE" ]; then
  IFS="," read -r -a includes <<< "$ACTIONSFLOW_INCLUDE"
  for include in "${includes[@]}"; do
    cmd+=(--include "$include")
  done
fi
printf "[BUILD] command:"
printf " %q" "${cmd[@]}"
printf "\n"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout --foreground "$BUILD_TIMEOUT")
else
  TIMEOUT_CMD=()
fi
"${TIMEOUT_CMD[@]}" node - <<'"'"'NODE'"'"'
const build = require("actionsflow/dist/src/build").default

const include = process.env.ACTIONSFLOW_INCLUDE
  ? process.env.ACTIONSFLOW_INCLUDE.split(",").map((item) => item.trim()).filter(Boolean)
  : []

build({
  cwd: process.env.PROJECT,
  dest: process.env.DEST,
  include,
  force: true,
  verbose: true,
}).then(() => {
  process.exit(0)
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
NODE
printf "[BUILD] 生成文件:\n"
find "$DEST" -maxdepth 3 -type f -print | sort
'
}

cmd_act() {
  ensure_container
  log "ACT" "执行 $DEST/workflows"
  container_bash '
set -Eeuo pipefail
cd "$PROJECT"
test -d "$DEST/workflows" || {
  printf "[ERROR] 缺少 %s/workflows；先运行 build\n" "$DEST"
  exit 1
}
cmd=(
  act
  --env LOCAL_ACTIONSFLOW_DEBUG=true
  --workflows "$DEST/workflows"
  --secret-file "$DEST/.secrets"
  --eventpath "$DEST/event.json"
  --env-file "$DEST/.env"
  -P "ubuntu-latest=$ACT_IMAGE"
  -P "ubuntu-18.04=$ACT_IMAGE"
  --bind
  --container-architecture "$ARCH"
)
if [ -n "$ACTIONSFLOW_ACT_ARGS" ]; then
  IFS=$'\''\037'\'' read -r -a extra_args <<< "$ACTIONSFLOW_ACT_ARGS"
  cmd+=("${extra_args[@]}")
fi
printf "[ACT] command:"
printf " %q" "${cmd[@]}"
printf "\n"
"${cmd[@]}"
'
}

cmd_run() {
  cmd_build
  cmd_act
}

cmd_kill_act() {
  log "WARN" "强制删除 $ACT_IMAGE 启动的 job 容器"
  ids="$(docker ps -q --filter "ancestor=$ACT_IMAGE")"
  if [ -z "$ids" ]; then
    log "DONE" "没有正在运行的 act job 容器"
    return
  fi
  # shellcheck disable=SC2086
  docker rm -f $ids
}

cmd_logs() {
  docker logs -f --tail 200 "$CONTAINER"
}

cmd_shell() {
  ensure_container
  docker exec -it -e PROJECT="$PROJECT" "$CONTAINER" bash -lc 'cd "$PROJECT"; exec bash'
}

case "$ACTION" in
  run)
    cmd_run
    ;;
  build)
    cmd_build
    ;;
  act)
    cmd_act
    ;;
  trigger)
    cmd_trigger
    ;;
  inspect)
    cmd_inspect
    ;;
  list)
    cmd_list
    ;;
  clean-cache)
    cmd_clean_cache
    ;;
  kill-act)
    cmd_kill_act
    ;;
  logs)
    cmd_logs
    ;;
  shell)
    cmd_shell
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage
    die "未知命令: $ACTION"
    ;;
esac
