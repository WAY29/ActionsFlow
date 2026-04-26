#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="${ACTIONSFLOW_CONTAINER:-actionsflow}"
TAIL="${ACTIONSFLOW_LOG_TAIL:-5000}"
BATCH=1
FOLLOW=false
INCLUDE_CLEAN=false
VALID_ONLY="${ACTIONSFLOW_LOG_VALID_ONLY:-true}"
MARKER="${ACTIONSFLOW_LOG_MARKER:-There are [0-9]+ immediate tasks, [0-9]+ delay tasks}"
CLEAN_MARKER="Clean the dest folder"
END_MARKER="${ACTIONSFLOW_LOG_END_MARKER:-^$}"
TASK="${ACTIONSFLOW_LOG_TASK:-}"
TASK_REGEX="${ACTIONSFLOW_LOG_TASK_REGEX:-false}"
WORKFLOWS_DIR="${ACTIONSFLOW_WORKFLOWS_DIR:-workflows}"

usage() {
  cat <<EOF
用法:
  $0 [选项]

选项:
  -b, --batch N          查看从倒数第 N 个批次到最新批次。默认 1，即只看最新批次
      --batch=N          同上
  -c, --container NAME   容器名。默认: $CONTAINER
  -t, --tail N           从最近 N 行 docker logs 中查找。默认: $TAIL
  -f, --follow           先打印目标批次，再继续跟踪新日志
      --task PATTERN     只显示匹配任务的 trigger/build 行和 act job 日志
      --task=PATTERN     同上；默认固定字符串匹配，并兼容大小写/分隔符差异
      --workflow NAME     --task 的别名
      --task-regex       将 --task 作为 awk 正则匹配，不做 workflow/job name 别名扩展
      --valid-only BOOL  只显示有效批次。默认: $VALID_ONLY
      --all              显示所有批次，包括 0 任务批次
      --include-clean    从 "Clean the dest folder" 行开始打印
      --marker REGEX     自定义批次起始正则
      --end-marker REGEX 自定义批次结束正则；匹配行会包含在输出里
  -h, --help             显示帮助

示例:
  $0
  $0 --batch 2           查看最近 2 个批次
  $0 --all --batch 2     查看最近 2 个批次，包括空批次
  $0 --batch=2
  $0 2
  $0 --task akrss-codex-cubox --follow
  $0 --task "bestblogs daily brief"
  $0 --include-clean --follow
  ACTIONSFLOW_CONTAINER=actionsflow $0 --tail 20000
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -b|--batch)
      BATCH="${2:-}"
      shift 2
      ;;
    --batch=*)
      BATCH="${1#--batch=}"
      shift
      ;;
    -b[0-9]*)
      BATCH="${1#-b}"
      shift
      ;;
    -c|--container)
      CONTAINER="${2:-}"
      shift 2
      ;;
    -t|--tail)
      TAIL="${2:-}"
      shift 2
      ;;
    -f|--follow)
      FOLLOW=true
      shift
      ;;
    --task)
      if [ -z "${2:-}" ]; then
        printf '[ERROR] --task 需要指定匹配值\n' >&2
        exit 2
      fi
      TASK="${2:-}"
      shift 2
      ;;
    --task=*)
      TASK="${1#--task=}"
      shift
      ;;
    --workflow)
      if [ -z "${2:-}" ]; then
        printf '[ERROR] --workflow 需要指定匹配值\n' >&2
        exit 2
      fi
      TASK="${2:-}"
      shift 2
      ;;
    --workflow=*)
      TASK="${1#--workflow=}"
      shift
      ;;
    --task-regex)
      TASK_REGEX=true
      shift
      ;;
    --include-clean)
      INCLUDE_CLEAN=true
      shift
      ;;
    --valid-only)
      if [ "${2:-}" = "true" ] || [ "${2:-}" = "false" ]; then
        VALID_ONLY="$2"
        shift 2
      else
        VALID_ONLY=true
        shift
      fi
      ;;
    --valid-only=*)
      VALID_ONLY="${1#--valid-only=}"
      shift
      ;;
    --no-valid-only|--include-empty|--all)
      VALID_ONLY=false
      shift
      ;;
    --marker)
      MARKER="${2:-}"
      shift 2
      ;;
    --marker=*)
      MARKER="${1#--marker=}"
      shift
      ;;
    --end-marker)
      END_MARKER="${2:-}"
      shift 2
      ;;
    --end-marker=*)
      END_MARKER="${1#--end-marker=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    [0-9]*)
      BATCH="$1"
      shift
      ;;
    *)
      printf '[ERROR] 未知参数: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$BATCH" in
  ''|*[!0-9]*)
    printf '[ERROR] --batch 必须是正整数: %s\n' "$BATCH" >&2
    exit 2
    ;;
  0)
    printf '[ERROR] --batch 必须大于 0\n' >&2
    exit 2
    ;;
esac

case "$VALID_ONLY" in
  true|1|yes|on)
    VALID_ONLY=true
    ;;
  false|0|no|off)
    VALID_ONLY=false
    ;;
  *)
    printf '[ERROR] --valid-only 必须是 true 或 false: %s\n' "$VALID_ONLY" >&2
    exit 2
    ;;
esac

case "$TASK_REGEX" in
  true|1|yes|on)
    TASK_REGEX=true
    ;;
  false|0|no|off)
    TASK_REGEX=false
    ;;
  *)
    printf '[ERROR] ACTIONSFLOW_LOG_TASK_REGEX 必须是 true 或 false: %s\n' "$TASK_REGEX" >&2
    exit 2
    ;;
esac

if [ "$TASK_REGEX" = true ] && [ -z "$TASK" ]; then
  printf '[ERROR] --task-regex 需要同时指定 --task\n' >&2
  exit 2
fi

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  printf '[ERROR] 找不到容器: %s\n' "$CONTAINER" >&2
  exit 1
}

build_task_aliases() {
  if [ -z "$TASK" ] || [ "$TASK_REGEX" = true ]; then
    return
  fi

  {
    printf '%s\n' "$TASK"

    {
      if [ -d "$WORKFLOWS_DIR" ]; then
        find "$WORKFLOWS_DIR" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print
      fi
      if [ -d dist ]; then
        find dist -path '*/workflows/*.yml' -type f -print
      fi
    } | sort -u | while IFS= read -r workflow_file; do
      awk -v task="$TASK" '
function compact(text, value) {
  value = tolower(text)
  gsub(/[^[:alnum:]]/, "", value)
  return value
}
function strip(value) {
  sub(/^[[:space:]]+/, "", value)
  sub(/[[:space:]]+$/, "", value)
  sub(/^["'\'']/, "", value)
  sub(/["'\'']$/, "", value)
  return value
}
function add(value) {
  value = strip(value)
  if (value != "") {
    aliases[++alias_count] = value
  }
}
BEGIN {
  task_compact = compact(task)
}
FNR == 1 {
  file = FILENAME
  base = file
  sub(/^.*\//, "", base)
  stem = base
  sub(/\.(ya?ml)$/, "", stem)
  add(file)
  add(base)
  add(stem)
}
/^[[:space:]]{4}name:[[:space:]]*/ {
  value = $0
  sub(/^[[:space:]]{4}name:[[:space:]]*/, "", value)
  add(value)
}
END {
  for (i = 1; i <= alias_count; i++) {
    alias_compact = compact(aliases[i])
    if (alias_compact != "" && task_compact != "" && (index(alias_compact, task_compact) > 0 || index(task_compact, alias_compact) > 0)) {
      matched = 1
      break
    }
  }

  if (matched) {
    for (i = 1; i <= alias_count; i++) {
      print aliases[i]
    }
  }
}' "$workflow_file"
    done
  } | awk 'NF && !seen[$0]++'
}

TASK_ALIASES="$(build_task_aliases | awk 'BEGIN { sep = sprintf("%c", 28) } NF { printf "%s%s", printed ? sep : "", $0; printed = 1 }')"

print_batch() {
  docker logs --tail "$TAIL" "$CONTAINER" 2>&1 | awk \
    -v batch="$BATCH" \
    -v marker="$MARKER" \
    -v end_marker="$END_MARKER" \
    -v clean_marker="$CLEAN_MARKER" \
    -v include_clean="$INCLUDE_CLEAN" \
    -v valid_only="$VALID_ONLY" \
    -v task="$TASK" \
    -v task_regex="$TASK_REGEX" \
    -v task_aliases="$TASK_ALIASES" '
function is_valid_batch(text, tmp, parts, immediate, delay) {
  tmp = text
  sub(/^.*There are /, "", tmp)
  sub(/ immediate tasks, /, ",", tmp)
  sub(/ delay tasks.*$/, "", tmp)
  split(tmp, parts, ",")
  immediate = parts[1] + 0
  delay = parts[2] + 0
  return immediate + delay > 0
}

function compact(text, value) {
  value = tolower(text)
  gsub(/[^[:alnum:]]/, "", value)
  return value
}

function load_task_aliases(raw, rows, i, alias) {
  task_compact = compact(task)
  split(raw, rows, sprintf("%c", 28))
  for (i in rows) {
    alias = rows[i]
    if (alias != "") {
      aliases[++alias_count] = alias
      alias_compacts[alias_count] = compact(alias)
    }
  }
}

function fixed_task_match(text, text_compact, i) {
  if (index(text, task) > 0) {
    return 1
  }

  text_compact = compact(text)
  if (task_compact != "" && index(text_compact, task_compact) > 0) {
    return 1
  }

  for (i = 1; i <= alias_count; i++) {
    if (index(text, aliases[i]) > 0) {
      return 1
    }
    if (alias_compacts[i] != "" && index(text_compact, alias_compacts[i]) > 0) {
      return 1
    }
  }

  return 0
}

function task_match(text) {
  if (task == "") {
    return 1
  }
  if (task_regex == "true") {
    return text ~ task
  }
  return fixed_task_match(text)
}

function act_job(text, value) {
  if (text !~ /^\[actionsflow\/[^]]+\]/) {
    return ""
  }
  value = text
  sub(/^\[actionsflow\//, "", value)
  sub(/\].*$/, "", value)
  return value
}

function is_task_skip_line(text) {
  return text ~ /No new updates found at trigger .* workflow .* skip it\./
}

function is_executed_task_line(text, job) {
  if (task == "") {
    return 1
  }
  if (is_task_skip_line(text)) {
    return 0
  }
  if (text ~ /updates found at trigger .* workflow file .* build success/ && task_match(text)) {
    return 1
  }
  job = act_job(text)
  return job != "" && task_match(job)
}

function is_context_line(text) {
  if (text ~ marker) return 1
  if (text ~ clean_marker) return 1
  if (text ~ /actionsflow: Run [0-9]+ immediate tasks finished/) return 1
  if (text ~ /actionsflow: All tasks finished/) return 1
  if (text ~ /actionsflow: Done\./) return 1
  if (text ~ /^time=.*Using docker host/) return 1
  if (text ~ /^\[ACT\]/) return 1
  return 0
}

function is_task_line(text, job) {
  if (task == "") {
    return 1
  }
  if (is_task_skip_line(text)) {
    return 0
  }
  if (task_match(text)) {
    return 1
  }
  job = act_job(text)
  return job != "" && task_match(job)
}

function should_print_line(text) {
  return task == "" || is_context_line(text) || is_task_line(text)
}

function batch_end(marker_index, start, line, end) {
  end = NR
  for (line = start + 1; line <= NR; line++) {
    if (marker_index < marker_count && line == markers[marker_index + 1]) {
      end = line - 1
      if (end >= start && lines[end] ~ clean_marker) {
        end--
      }
      break
    }
    if (end_marker != "^$" && lines[line] ~ end_marker) {
      end = line
      break
    }
  }
  return end
}

function batch_has_executed_task(start, end, line) {
  if (task == "") {
    return 1
  }
  for (line = start; line <= end; line++) {
    if (is_executed_task_line(lines[line])) {
      return 1
    }
  }
  return 0
}

BEGIN {
  load_task_aliases(task_aliases)
}

{
  lines[NR] = $0
  if ($0 ~ marker) {
    markers[++marker_count] = NR
    batch_valid[marker_count] = valid_only != "true" || is_valid_batch($0)
  }
}
END {
  if (marker_count == 0) {
    printf("[ERROR] 最近日志中未找到批次起始 marker: %s\n", marker) > "/dev/stderr"
    exit 2
  }

  for (marker_index = 1; marker_index <= marker_count; marker_index++) {
    if (!batch_valid[marker_index]) {
      continue
    }

    start = markers[marker_index]
    if (include_clean == "true" && start > 1 && lines[start - 1] ~ clean_marker) {
      start--
    }

    end = batch_end(marker_index, start)
    batch_starts[marker_index] = start
    batch_ends[marker_index] = end

    if (batch_has_executed_task(start, end)) {
      selected_markers[++selected_count] = marker_index
    }
  }

  if (selected_count == 0) {
    if (task != "") {
      printf("[ERROR] 最近日志中没有匹配任务 [%s] 的%s批次\n", task, valid_only == "true" ? "有效" : "") > "/dev/stderr"
    } else if (valid_only == "true") {
      printf("[ERROR] 最近日志中找到 %d 个批次，但没有有效批次；如需查看空批次请加 --all\n", marker_count) > "/dev/stderr"
    } else {
      printf("[ERROR] 最近日志中没有可显示批次\n") > "/dev/stderr"
    }
    exit 2
  }

  first_selected_index = selected_count - batch + 1
  if (first_selected_index < 1) {
    printf("[WARN] 只找到 %d 个%s批次；--batch=%d 超出范围，改为输出全部匹配批次\n", selected_count, valid_only == "true" ? "有效" : "", batch) > "/dev/stderr"
    first_selected_index = 1
  }

  printf("[BATCH] 显示最近 %d 个%s批次；日志窗口内共 %d 个批次，匹配 %d 个；起始匹配序号 %d", batch, valid_only == "true" ? "有效" : "", marker_count, selected_count, first_selected_index) > "/dev/stderr"
  if (task != "") {
    printf("；任务过滤: %s", task) > "/dev/stderr"
  }
  printf("\n") > "/dev/stderr"

  for (selected_index = first_selected_index; selected_index <= selected_count; selected_index++) {
    marker_index = selected_markers[selected_index]
    start = batch_starts[marker_index]
    end = batch_ends[marker_index]

    if (selected_index > first_selected_index) {
      print ""
      printf("===== ACTIONSFLOW BATCH %d/%d", marker_index, marker_count)
    } else {
      printf("===== ACTIONSFLOW BATCH %d/%d", marker_index, marker_count)
    }
    if (valid_only == "true") {
      printf(" VALID %d/%d", selected_index, selected_count)
    }
    if (task != "") {
      printf(" TASK %s", task)
    }
    printf(" =====\n")

    for (line = start; line <= end; line++) {
      if (should_print_line(lines[line])) {
        print lines[line]
      }
    }
  }
}'
}

follow_logs() {
  if [ -z "$TASK" ]; then
    docker logs --tail 0 -f "$CONTAINER"
    return
  fi

  docker logs --tail 0 -f "$CONTAINER" 2>&1 | awk \
    -v marker="$MARKER" \
    -v clean_marker="$CLEAN_MARKER" \
    -v task="$TASK" \
    -v task_regex="$TASK_REGEX" \
    -v task_aliases="$TASK_ALIASES" '
function compact(text, value) {
  value = tolower(text)
  gsub(/[^[:alnum:]]/, "", value)
  return value
}
function load_task_aliases(raw, rows, i, alias) {
  task_compact = compact(task)
  split(raw, rows, sprintf("%c", 28))
  for (i in rows) {
    alias = rows[i]
    if (alias != "") {
      aliases[++alias_count] = alias
      alias_compacts[alias_count] = compact(alias)
    }
  }
}
function fixed_task_match(text, text_compact, i) {
  if (index(text, task) > 0) {
    return 1
  }
  text_compact = compact(text)
  if (task_compact != "" && index(text_compact, task_compact) > 0) {
    return 1
  }
  for (i = 1; i <= alias_count; i++) {
    if (index(text, aliases[i]) > 0) {
      return 1
    }
    if (alias_compacts[i] != "" && index(text_compact, alias_compacts[i]) > 0) {
      return 1
    }
  }
  return 0
}
function task_match(text) {
  if (task_regex == "true") {
    return text ~ task
  }
  return fixed_task_match(text)
}
function act_job(text, value) {
  if (text !~ /^\[actionsflow\/[^]]+\]/) {
    return ""
  }
  value = text
  sub(/^\[actionsflow\//, "", value)
  sub(/\].*$/, "", value)
  return value
}
function is_task_skip_line(text) {
  return text ~ /No new updates found at trigger .* workflow .* skip it\./
}
function is_executed_task_line(text, job) {
  if (is_task_skip_line(text)) {
    return 0
  }
  if (text ~ /updates found at trigger .* workflow file .* build success/ && task_match(text)) {
    return 1
  }
  job = act_job(text)
  return job != "" && task_match(job)
}
function is_context_line(text) {
  if (text ~ marker) return 1
  if (text ~ clean_marker) return 1
  if (text ~ /actionsflow: Run [0-9]+ immediate tasks finished/) return 1
  if (text ~ /actionsflow: All tasks finished/) return 1
  if (text ~ /actionsflow: Done\./) return 1
  if (text ~ /^time=.*Using docker host/) return 1
  if (text ~ /^\[ACT\]/) return 1
  return 0
}
function is_task_line(text, job) {
  if (is_task_skip_line(text)) {
    return 0
  }
  if (task_match(text)) {
    return 1
  }
  job = act_job(text)
  return job != "" && task_match(job)
}
BEGIN {
  load_task_aliases(task_aliases)
}
{
  if ($0 ~ marker) {
    printing = 0
    buffer_count = 0
  }

  if (is_executed_task_line($0)) {
    if (!printing) {
      for (i = 1; i <= buffer_count; i++) {
        print buffer[i]
      }
      buffer_count = 0
      printing = 1
    }
    print
    fflush()
    next
  }

  if (is_context_line($0)) {
    if (printing) {
      print
      fflush()
    } else {
      buffer[++buffer_count] = $0
    }
    next
  }

  if (printing && is_task_line($0)) {
    print
    fflush()
  }
}'
}

print_batch

if [ "$FOLLOW" = true ]; then
  printf '[FOLLOW] 继续跟踪容器新日志: %s\n' "$CONTAINER" >&2
  follow_logs
fi
