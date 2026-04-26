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

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  printf '[ERROR] 找不到容器: %s\n' "$CONTAINER" >&2
  exit 1
}

print_batch() {
  docker logs --tail "$TAIL" "$CONTAINER" 2>&1 | awk \
    -v batch="$BATCH" \
    -v marker="$MARKER" \
    -v end_marker="$END_MARKER" \
    -v clean_marker="$CLEAN_MARKER" \
    -v include_clean="$INCLUDE_CLEAN" \
    -v valid_only="$VALID_ONLY" '
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

{
  lines[NR] = $0
  if ($0 ~ marker) {
    markers[++marker_count] = NR
    if (valid_only != "true" || is_valid_batch($0)) {
      selected_markers[++selected_count] = marker_count
    }
  }
}
END {
  if (marker_count == 0) {
    printf("[ERROR] 最近日志中未找到批次起始 marker: %s\n", marker) > "/dev/stderr"
    exit 2
  }

  if (selected_count == 0) {
    if (valid_only == "true") {
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

  printf("[BATCH] 显示最近 %d 个%s批次；日志窗口内共 %d 个批次，匹配 %d 个；起始匹配序号 %d\n", batch, valid_only == "true" ? "有效" : "", marker_count, selected_count, first_selected_index) > "/dev/stderr"

  for (selected_index = first_selected_index; selected_index <= selected_count; selected_index++) {
    marker_index = selected_markers[selected_index]
    start = markers[marker_index]
    if (include_clean == "true" && start > 1 && lines[start - 1] ~ clean_marker) {
      start--
    }

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

    if (selected_index > first_selected_index) {
      print ""
      printf("===== ACTIONSFLOW BATCH %d/%d", marker_index, marker_count)
    } else {
      printf("===== ACTIONSFLOW BATCH %d/%d", marker_index, marker_count)
    }
    if (valid_only == "true") {
      printf(" VALID %d/%d", selected_index, selected_count)
    }
    printf(" =====\n")

    for (line = start; line <= end; line++) {
      print lines[line]
    }
  }
}'
}

print_batch

if [ "$FOLLOW" = true ]; then
  printf '[FOLLOW] 继续跟踪容器新日志: %s\n' "$CONTAINER" >&2
  docker logs --tail 0 -f "$CONTAINER"
fi
