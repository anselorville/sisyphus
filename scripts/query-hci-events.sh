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
#   scripts/query-hci-events.sh --decisions      # Jev 决策层：规则 vs Jev 的一致率、回落原因、延迟
#   scripts/query-hci-events.sh --search         # 网页搜索：各搜索源的调用/失败/延迟、模式分布、最近的搜索
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
MODE="events"         # events | latency | summary | decisions | search

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
    --decisions)      MODE="decisions"; shift ;;
    --search)         MODE="search"; shift ;;
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

# 注意: events 表里入站（Pipecat）与出站（sidecar）事件的 sequence 各自独立计数，
# 只有插入顺序（rowid）是全局有序的，所以所有"最近 N 条"都按 rowid 排序。

# --- 过滤条件 ---
FILTERS=""
if [[ -n "$INTERACTION_ID" ]]; then
  FILTERS="WHERE interaction_id = '$(printf '%s' "$INTERACTION_ID" | sed "s/'/''/g")'"
elif [[ -n "$TASK_ID" ]]; then
  FILTERS="WHERE task_id = '$(printf '%s' "$TASK_ID" | sed "s/'/''/g")'"
fi

# --- 模式: latency（延迟指标汇总） ---
# 每个 voice.user.stopped 配对"下一个 user.stopped 之前的第一条 voice.speech.enqueue"，
# 差值即 sidecar 视角的"说完 → Marcus 开口前的最后一站"（含转写、路由、LLM 首句，
# 不含 TTS 合成与播放）。received_at 均为 sidecar 时钟，故可直接相减。
# 配对按全局插入顺序（rowid），不依赖 interaction_id（媒体面事件没有它）。
if [[ "$MODE" == "latency" ]]; then
  PAIRS_SQL="
    WITH stops AS (
      SELECT rowid AS rid, received_at AS stop_at,
             COALESCE((SELECT MIN(n.rowid) FROM events n
                       WHERE n.rowid > s.rowid AND n.type = 'voice.user.stopped'), 9223372036854775807) AS next_stop
      FROM events s WHERE s.type = 'voice.user.stopped'
    ),
    paired AS (
      SELECT stops.rid, stops.stop_at,
             (SELECT e.received_at FROM events e
              WHERE e.rowid > stops.rid AND e.rowid < stops.next_stop AND e.type = 'voice.speech.enqueue'
              ORDER BY e.rowid LIMIT 1) AS speech_at
      FROM stops
    ),
    turns AS (
      SELECT rid, stop_at, speech_at,
             CAST(ROUND((julianday(speech_at) - julianday(stop_at)) * 86400000) AS INTEGER) AS latency_ms
      FROM paired WHERE speech_at IS NOT NULL
    )"
  echo "=== 说完 → 首句语音入队 延迟（最近 ${N} 轮）==="
  sqlite3 -header -column "$DB_PATH" "
    ${PAIRS_SQL}
    SELECT strftime('%m-%d %H:%M:%S', stop_at) AS user_stopped, latency_ms
    FROM turns ORDER BY rid DESC LIMIT ${N};
  "
  echo
  echo "=== 汇总 ==="
  sqlite3 -header -column "$DB_PATH" "
    ${PAIRS_SQL}
    , recent AS (SELECT latency_ms FROM turns ORDER BY rid DESC LIMIT ${N}),
    ordered AS (SELECT latency_ms FROM recent ORDER BY latency_ms)
    SELECT COUNT(*) AS turns,
           MIN(latency_ms) AS min_ms,
           CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avg_ms,
           (SELECT latency_ms FROM ordered LIMIT 1 OFFSET (SELECT COUNT(*) FROM ordered) / 2) AS median_ms,
           MAX(latency_ms) AS max_ms
    FROM recent;
  "
  echo
  echo "未得到回应的用户发言（user.stopped 之后没有语音入队）:"
  sqlite3 "$DB_PATH" "
    ${PAIRS_SQL}
    SELECT COUNT(*) FROM paired WHERE speech_at IS NULL;
  "
  echo
  echo "-- 补充 --"
  echo "端到端听感延迟还要加上 TTS 首包与播放，来自日志: grep voice_latency /tmp/sisyphus-backend.log"
  echo "关注: user_to_bot_seconds（说话结束→首次 bot 语音）、first_bot_speech_seconds。"
  exit 0
fi

# --- 模式: search（网页搜索审计） ---
# 每次 web_search 写一条 search.made 事件：计划(模式/宽度/时效/主题)、每个搜索源的尝试
# (成功与否、耗时、条数、失败原因)、最终贡献结果的搜索源、总耗时。
if [[ "$MODE" == "search" ]]; then
  echo "=== 搜索模式分布 ==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT json_extract(payload,'$.plan') AS plan, COUNT(*) AS n,
           CAST(AVG(json_extract(payload,'$.totalMs')) AS INTEGER) AS avg_ms
    FROM events WHERE type='search.made' GROUP BY 1 ORDER BY n DESC;
  "
  echo
  echo "=== 各搜索源（来自每次尝试）==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT json_extract(a.value,'$.provider') AS provider,
           COUNT(*) AS attempts,
           SUM(json_extract(a.value,'$.ok')) AS ok,
           COUNT(*) - SUM(json_extract(a.value,'$.ok')) AS failed,
           CAST(AVG(CASE WHEN json_extract(a.value,'$.ok') THEN json_extract(a.value,'$.ms') END) AS INTEGER) AS avg_ok_ms
    FROM events e, json_each(e.payload,'$.attempts') a
    WHERE e.type='search.made' GROUP BY 1 ORDER BY attempts DESC;
  "
  echo
  echo "=== 失败原因 ==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT json_extract(a.value,'$.provider') AS provider, substr(json_extract(a.value,'$.error'),1,70) AS error, COUNT(*) AS n
    FROM events e, json_each(e.payload,'$.attempts') a
    WHERE e.type='search.made' AND json_extract(a.value,'$.ok')=0 GROUP BY 1,2 ORDER BY n DESC LIMIT ${N};
  "
  echo
  echo "=== 最近的搜索 ==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT strftime('%m-%d %H:%M:%S', received_at) AS time,
           json_extract(payload,'$.totalMs') AS ms,
           json_extract(payload,'$.plan') AS plan,
           replace(replace(json_extract(payload,'$.contributors'),'[',''),']','') AS from_,
           substr(json_extract(payload,'$.query'),1,40) AS query
    FROM events WHERE type='search.made' ORDER BY rowid DESC LIMIT ${N};
  "
  exit 0
fi

# --- 模式: decisions（Jev 决策层审计） ---
# 每个固定模式决策（谁来处理这句话、"好"是不是在回答待确认问题……）都会写一条
# decision.made 事件：规则的答案(baseline)、Jev 的答案(jev)、实际采用的(chosen)与来源
# (source: jev / rule / rule_fallback)、Jev 的把握、延迟、回落原因。shadow 模式下用它
# 校准阈值：一致率高且分歧处 Jev 更合理，才值得切到 live。
if [[ "$MODE" == "decisions" ]]; then
  echo "=== 决策层概览（全部 decision.made 事件）==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT json_extract(payload,'$.decision') AS decision,
           json_extract(payload,'$.version') AS ver,
           json_extract(payload,'$.mode') AS mode,
           COUNT(*) AS n,
           SUM(json_extract(payload,'$.source')='jev') AS by_jev,
           SUM(json_extract(payload,'$.source')='rule') AS by_rule,
           SUM(json_extract(payload,'$.source')='rule_fallback') AS fallback,
           printf('%.0f%%', 100.0*SUM(json_extract(payload,'$.agreed')=1)/NULLIF(SUM(json_extract(payload,'$.agreed') IS NOT NULL),0)) AS agree
    FROM events WHERE type='decision.made'
    GROUP BY 1,2,3 ORDER BY n DESC;
  "
  echo
  echo "=== 回落到规则的原因 ==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT json_extract(payload,'$.fallbackReason') AS reason, COUNT(*) AS n
    FROM events WHERE type='decision.made' AND json_extract(payload,'$.fallbackReason') IS NOT NULL
    GROUP BY 1 ORDER BY n DESC;
  "
  echo
  echo "=== Jev 延迟（ms，仅实际调用成功的）==="
  sqlite3 -header -column "$DB_PATH" "
    WITH l AS (SELECT CAST(json_extract(payload,'$.latencyMs') AS INTEGER) AS ms
               FROM events WHERE type='decision.made' AND json_extract(payload,'$.jev') IS NOT NULL ORDER BY ms)
    SELECT COUNT(*) AS n,
           (SELECT ms FROM l LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM l)) AS p50,
           (SELECT ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*)*0.95 AS INTEGER) FROM l)) AS p95,
           MAX(ms) AS max FROM l;
  "
  echo
  echo "=== 最近的分歧（规则 vs Jev）==="
  sqlite3 -header -column "$DB_PATH" "
    SELECT strftime('%m-%d %H:%M:%S', received_at) AS time,
           json_extract(payload,'$.decision') AS decision,
           json_extract(payload,'$.baseline') AS rule,
           json_extract(payload,'$.jev') AS jev,
           printf('%.2f', json_extract(payload,'$.confidence')) AS conf,
           json_extract(payload,'$.source') AS used
    FROM events WHERE type='decision.made' AND json_extract(payload,'$.agreed')=0
    ORDER BY rowid DESC LIMIT ${N};
  "
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
      ORDER BY rowid DESC
      LIMIT ${N}
    )
    GROUP BY type
    ORDER BY count DESC;
  "
  echo
  echo "=== 打断（voice.speech.cancel，reason=barge_in）占比 ==="
  sqlite3 "$DB_PATH" "
    SELECT
      printf('打断 %d 次 / 用户发言 %d 次',
        (SELECT COUNT(*) FROM events WHERE type='voice.speech.cancel'),
        (SELECT COUNT(*) FROM events WHERE type='voice.user.started'));
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
    ${FILTERS:+AND ${FILTERS#WHERE }}
    ORDER BY rowid DESC
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
    ORDER BY rowid DESC
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
    ORDER BY rowid DESC
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
