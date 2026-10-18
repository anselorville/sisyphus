#!/usr/bin/env bash
#
# query-hci-events.sh — 从 sidecar SQLite `events` 表提取 HCI 相关数据。
#
# 用途：HCI 问题收集（见 docs/hci-observations.md）。查询最近 N 条语音交互
# 事件，输出格式化的 HCI 指标（延迟体感 / 打断 / 路由 / 幻觉工具调用 / 转写）。
#
# 用法:
#   scripts/query-hci-events.sh                  # 最近 20 条语音交互事件
#   scripts/query-hci-events.sh -n 50            # 最近 50 条
#   scripts/query-hci-events.sh -i <interaction> # 指定 interaction_id
#   scripts/query-hci-events.sh -t <task_id>     # 指定 task_id
#   scripts/query-hci-events.sh -c               # 输出原始 CSV（无排版）
#   scripts/query-hci-events.sh --latency        # 只统计延迟指标
#   scripts/query-hci-events.sh --summary        # 只输出 HCI 指标汇总
#
# 数据库路径: 默认 <repo>/agent-runtime/data/agent-runtime.sqlite3
#            可用环境变量 AGENT_RUNTIME_DB_PATH 覆盖。
#
# 事件类型参考（agent-runtime/src/protocol/events.ts）:
#   voice.user.started / voice.user.stopped / voice.transcript.partial /
#   voice.transcript.final / voice.speech.enqueue / voice.speech.cancel /
#   task.created / task.assigned / task.progress / task.completed /
#   task.failed / task.cancelled / task.steer / task.follow_up /
#   diplomacy.elevation.requested / diplomacy.elevation.resolved

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 数据库定位 ---
DB_PATH="${AGENT_RUNTIME_DB_PATH:-$REPO_ROOT/agent-runtime/data/agent-runtime.sqlite3}"

N=20
INTERACTION_ID=""
TASK_ID=""
OUTPUT_MODE="table"   # table | csv
MODE="events"         # events | latency | summary

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--count)       N="$2"; shift 2 ;;
    -i|--interaction) INTERACTION_ID="$2"; shift 2 ;;
    -t|--task)        TASK_ID="$2"; shift 2 ;;
    -c|--csv)         OUTPUT_MODE="csv"; shift ;;
    --latency)        MODE="latency"; shift ;;
    --summary)        MODE="summary"; shift ;;
    -h|--help)        usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

if [[ ! -f "$DB_PATH" ]]; then
  echo "错误: 数据库不存在: $DB_PATH" >&2
  echo "提示: 先运行 scripts/start.sh 启动 sidecar，或用 AGENT_RUNTIME_DB_PATH 指定路径。" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "错误: 需要 sqlite3 命令行工具（macOS 自带）。" >&2
  exit 1
fi

# 校验 N 为数字
if ! [[ "$N" =~ ^[0-9]+$ ]] || [[ "$N" -lt 1 ]]; then
  echo "错误: -n 必须是正整数" >&2
  exit 1
fi

# --- 过滤条件 ---
FILTERS=""
if [[ -n "$INTERACTION_ID" ]]; then
  FILTERS="WHERE interaction_id = '$(printf '%s' "$INTERACTION_ID" | sed "s/'/''/g")'"
elif [[ -n "$TASK_ID" ]]; then
  FILTERS="WHERE task_id = '$(printf '%s' "$TASK_ID" | sed "s/'/''/g")'"
fi

# --- 模式: latency（延迟指标汇总） ---
if [[ "$MODE" == "latency" ]]; then
  sqlite3 -header -column "$DB_PATH" "
    SELECT
      strftime('%Y-%m-%d %H:%M:%S', received_at) AS received_at,
      sequence,
      type,
      interaction_id,
      task_id
    FROM events
    ${FILTERS}
    ORDER BY sequence DESC
    LIMIT ${N};
  "
  echo
  echo "-- 延迟体感线索 --"
  echo "在应用日志中搜索 voice_latency（Pipecat 观测）:"
  echo "  grep voice_latency /tmp/sisyphus-backend.log"
  echo "关注: user_to_bot_seconds（说话结束→首次 bot 语音）、first_bot_speech_seconds。"
  echo "事件侧对照: voice.user.started/stopped 与 voice.speech.enqueue 之间的时间差即为端到端延迟。"
  exit 0
fi

# --- 模式: summary（HCI 指标汇总） ---
if [[ "$MODE" == "summary" ]]; then
  echo "=== HCI 指标汇总（最近 ${N} 条事件${INTERACTION_ID:+，interaction=${INTERACTION_ID}}）==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT
      type,
      COUNT(*) AS count
    FROM (
      SELECT * FROM events
      ${FILTERS}
      ORDER BY sequence DESC
      LIMIT ${N}
    )
    GROUP BY type
    ORDER BY count DESC;
  "
  echo
  echo "=== 打断（voice.speech.cancel）占比 ==="
  sqlite3 "$DB_PATH" "
    SELECT
      printf('cancel 事件: %d / 总语音事件 %d',
        (SELECT COUNT(*) FROM events WHERE type='voice.speech.cancel' ${FILTERS:+AND ${FILTERS#WHERE }}),
        (SELECT COUNT(*) FROM events WHERE type LIKE 'voice.%' ${FILTERS:+AND ${FILTERS#WHERE }}));
  "
  echo
  echo "=== 任务终态分布 ==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT status, COUNT(*) AS count
    FROM tasks
    ${FILTERS}
    GROUP BY status;
  "
  echo
  echo "=== 转写样例（最近 5 条 voice.transcript.final）==="
  sqlite3 "$DB_PATH" "
    SELECT
      strftime('%H:%M:%S', received_at) AS time,
      json_extract(payload, '$.text') AS transcript
    FROM events
    WHERE type = 'voice.transcript.final'
    ${FILTERS}
    ORDER BY sequence DESC
    LIMIT 5;
  "
  echo
  echo "=== 幻觉工具调用线索 ==="
  echo "对照各角色工具面（agent-runtime/src/roles/manifests.ts），检查 task.assigned 后"
  echo "角色是否调用了其工具面之外的工具。事件侧无直接工具调用记录时，查 diplomacy_log:"
  echo "  sqlite3 $DB_PATH 'SELECT * FROM diplomacy_log ORDER BY id DESC LIMIT 10;'"
  exit 0
fi

# --- 模式: events（默认，最近 N 条语音交互事件） ---
echo "=== 最近 ${N} 条事件${INTERACTION_ID:+（interaction_id=${INTERACTION_ID}）}${TASK_ID:+（task_id=${TASK_ID}）} ==="
echo "数据库: $DB_PATH"
echo

if [[ "$OUTPUT_MODE" == "csv" ]]; then
  sqlite3 -csv "$DB_PATH" "
    SELECT
      sequence,
      strftime('%Y-%m-%d %H:%M:%S', received_at) AS received_at,
      type,
      interaction_id,
      task_id,
      source,
      json_extract(payload, '$.text') AS transcript_text
    FROM events
    ${FILTERS}
    ORDER BY sequence DESC
    LIMIT ${N};
  "
else
  sqlite3 -header -column "$DB_PATH" "
    SELECT
      sequence,
      strftime('%m-%d %H:%M:%S', received_at) AS time,
      type,
      interaction_id,
      task_id,
      substr(
        COALESCE(json_extract(payload, '$.text'),
                 json_extract(payload, '$.action'),
                 json_extract(payload, '$.role_id'),
                 payload),
        1, 48) AS detail
    FROM events
    ${FILTERS}
    ORDER BY sequence DESC
    LIMIT ${N};
  "
fi

echo
echo "提示:"
echo "  - 单次交互全程:   $0 -i <interaction_id>"
echo "  - 单任务全程:     $0 -t <task_id>"
echo "  - 延迟指标:       $0 --latency"
echo "  - 指标汇总:       $0 --summary"
echo "  - 对照模板填写:   docs/hci-observations.md"
