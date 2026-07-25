#!/usr/bin/env bash
# Task 19: runs this repo's performance test suites (Python + TypeScript)
# and writes/updates .proj-init/performance-baseline.md with machine
# identity, runtime versions, and the measured p50/p95/p99, RSS, and
# event-loop-lag numbers those suites print (as `PERF_METRIC <name> <value>
# <unit>` lines -- this script never re-measures anything itself; it only
# runs the real tests and reads back what they already measured, so the
# report and the test that produced it can never drift apart).
#
# Usage:
#   scripts/benchmark-runtime.sh --host              # run now, for real, on this machine
#   scripts/benchmark-runtime.sh --raspberry-pi       # SAME benchmark logic, different
#                                                      #   report-label branch -- refuses to
#                                                      #   run unless actually on ARM Linux (see
#                                                      #   the guard below). Dev-machine numbers
#                                                      #   must never substitute for real Pi data
#                                                      #   (design doc section 15.5).
#   scripts/benchmark-runtime.sh --host --soak        # the REAL long-duration (1h mixed +
#                                                      #   8h idle) soak -- NOT the CI-safe
#                                                      #   accelerated version `pytest` already
#                                                      #   runs normally. Takes ~9 hours.
#
# Design doc reference: .proj-init/04-autonomous-swarm-voice-agent-software-design.md
# section 15.5 (the performance budget table) and 15.6 (verification
# requirements).
#
# Re-run contract: this script is meant to be re-run exactly by anyone --
# including an independent reviewer, per this task's own plan text, which
# says this performance report should be independently re-run, not just
# self-reported. It depends on nothing from any prior interactive session
# beyond a normal checkout (it builds the sidecar itself if needed, exactly
# like the test suites it runs already do).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BASELINE_FILE="$REPO_ROOT/.proj-init/performance-baseline.md"

# --- argument parsing --------------------------------------------------------

TARGET=""
SOAK=0
for arg in "$@"; do
  case "$arg" in
    --host) TARGET="host" ;;
    --raspberry-pi) TARGET="raspberry-pi" ;;
    --soak) SOAK=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 (--host|--raspberry-pi) [--soak]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 (--host|--raspberry-pi) [--soak]" >&2
  exit 1
fi

# --- Raspberry Pi safety guard -----------------------------------------------
# The design doc is explicit (section 15.5): dev-machine results must never
# substitute for real Pi acceptance data. Refuse to run --raspberry-pi
# anywhere that isn't actually ARM Linux, so this script can't be used --
# even by accident -- to mislabel a dev machine's numbers as Pi numbers.
if [[ "$TARGET" == "raspberry-pi" ]]; then
  OS_NAME="$(uname -s)"
  ARCH_NAME="$(uname -m)"
  if [[ "$OS_NAME" != "Linux" || ! "$ARCH_NAME" =~ ^(aarch64|armv7l|arm64)$ ]]; then
    echo "ERROR: --raspberry-pi refused on this machine (${OS_NAME}/${ARCH_NAME})." >&2
    echo "" >&2
    echo "This is not a bug -- it is intentional. Per the design doc (section 15.5)," >&2
    echo "dev-machine results must never substitute for real Raspberry Pi acceptance" >&2
    echo "data. This flag only runs on genuine ARM Linux hardware (Raspberry Pi's" >&2
    echo "actual deployment target: 64-bit Ubuntu + ARM64 Node.js)." >&2
    exit 1
  fi
fi

REPORT_LABEL="dev-machine"
REPORT_LABEL_TITLE="Dev-machine"
REPORT_MARKER="HOST"
if [[ "$TARGET" == "raspberry-pi" ]]; then
  REPORT_LABEL="raspberry-pi"
  REPORT_LABEL_TITLE="Raspberry Pi"
  REPORT_MARKER="PI"
fi

echo "==> Target: ${REPORT_LABEL}$( [[ "$SOAK" -eq 1 ]] && echo " (REAL long-duration --soak)" )"

# --- machine identity + runtime versions ------------------------------------

MACHINE_HOSTNAME="$(hostname 2>/dev/null || echo unknown)"
OS_DESC="$(uname -srm 2>/dev/null || echo unknown)"
if [[ "$(uname -s)" == "Darwin" ]]; then
  CPU_DESC="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
  MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  CPU_CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo unknown)"
else
  CPU_DESC="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || echo unknown)"
  MEM_KB="$(grep -m1 MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')"
  MEM_BYTES=$(( ${MEM_KB:-0} * 1024 ))
  CPU_CORES="$(nproc 2>/dev/null || echo unknown)"
fi
MEM_GIB="$(awk -v b="${MEM_BYTES:-0}" 'BEGIN { printf "%.1f", b / 1073741824 }')"

PYTHON_VERSION="$(uv run python --version 2>/dev/null | tail -n1 || echo unknown)"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
NPM_VERSION="$(npm --version 2>/dev/null || echo unknown)"
UV_VERSION="$(uv --version 2>/dev/null | awk '{print $1, $2}' || echo unknown)"
TEST_DATE_UTC="$(date -u +"%Y-%m-%d %H:%M UTC")"

echo "==> Machine: ${MACHINE_HOSTNAME} (${OS_DESC}), ${CPU_DESC}, ${CPU_CORES} cores, ${MEM_GIB} GiB RAM"
echo "==> Runtimes: Python ${PYTHON_VERSION}, Node ${NODE_VERSION}, npm ${NPM_VERSION}, ${UV_VERSION}"

# --- run the performance suites, capturing PERF_METRIC lines ----------------

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
PY_LOG="$WORK_DIR/python-performance.log"
NODE_LOG="$WORK_DIR/node-performance.log"
: > "$PY_LOG"
: > "$NODE_LOG"

PY_STATUS=0
NODE_STATUS=0

if [[ "$SOAK" -eq 1 ]]; then
  echo "==> Running the REAL long-duration soak: 1 hour mixed voice/task + 8 hour idle-listening."
  echo "    (this takes roughly 9 hours; it is intentionally NOT part of a normal test run)"
  export REALTIME_SOAK_MIXED_DURATION_SECONDS=3600
  export REALTIME_SOAK_IDLE_DURATION_SECONDS=28800
  # Effectively unbounded for the real run -- the CI-safe default caps
  # cycles low specifically because unthrottled in-process cycles are fast
  # enough to run away; the real multi-hour run has no such problem (real
  # wall-clock time dominates regardless).
  export REALTIME_SOAK_MIXED_MAX_CYCLES=100000000
  export REALTIME_SOAK_IDLE_MAX_CYCLES=100000000
  echo "==> uv run pytest tests/performance/test_realtime_soak.py -q -s"
  set +e
  uv run pytest tests/performance/test_realtime_soak.py -q -s 2>&1 | tee "$PY_LOG"
  PY_STATUS=${PIPESTATUS[0]}
  set -e
  echo "    (TypeScript side has no hour-scale soak requirement of its own -- see"
  echo "     agent-runtime/test/performance/event-loop.test.ts's own docstring;"
  echo "     --soak does not re-run the Node suite.)"
else
  echo "==> uv run pytest tests/performance -q -s"
  set +e
  uv run pytest tests/performance -q -s 2>&1 | tee "$PY_LOG"
  PY_STATUS=${PIPESTATUS[0]}
  set -e

  echo "==> npx --prefix agent-runtime vitest run test/performance"
  set +e
  (cd "$REPO_ROOT/agent-runtime" && npx vitest run test/performance 2>&1) | tee "$NODE_LOG"
  NODE_STATUS=${PIPESTATUS[0]}
  set -e
fi

# --- parse PERF_METRIC lines -------------------------------------------------
# Every metric line looks like: `PERF_METRIC <name> <value> <unit>`. Printed
# unconditionally by the tests that measure them (harmless under a normal
# `pytest -q`/`npm test`, which capture stdout on PASS; this script always
# passes -s/lets vitest's default stdout-through-put show them).


# NOT anchored to the start of the line (no `^`): pytest prints its
# per-test "." progress indicator with no trailing newline, so a test's
# very first print() can land on the same physical line right after a
# "."  (e.g. ".PERF_METRIC foo 1.0 ms") -- an anchored match would silently
# miss exactly that one line. Field *positions* (see the awk calls below)
# are unaffected either way: the "." only ever glues onto the token before
# "PERF_METRIC", never inserts a space, so $3/$4 are still the value/unit.
metric_value() {
  local name="$1"
  grep -h "PERF_METRIC ${name} " "$PY_LOG" "$NODE_LOG" 2>/dev/null | tail -n1 | awk '{print $3}'
}
metric_unit() {
  local name="$1"
  grep -h "PERF_METRIC ${name} " "$PY_LOG" "$NODE_LOG" 2>/dev/null | tail -n1 | awk '{print $4}'
}
row() {
  local label="$1" name="$2" budget="$3"
  local value unit
  value="$(metric_value "$name")"
  unit="$(metric_unit "$name")"
  if [[ -z "$value" ]]; then
    echo "| ${label} | not measured in this run | ${budget} | -- |"
  else
    echo "| ${label} | ${value} ${unit} | ${budget} | see raw logs |"
  fi
}

SECTION_FILE="$WORK_DIR/section.md"
{
  echo "## ${REPORT_LABEL_TITLE} baseline"
  echo ""
  if [[ "$SOAK" -eq 1 ]]; then
    echo "_Real long-duration soak run (\`--soak\`): 1 hour mixed voice/task + 8 hour idle-listening._"
  else
    echo "_CI-safe suite run (\`--host\`/\`--raspberry-pi\` without \`--soak\`)._"
  fi
  echo ""
  echo "- **Machine:** ${MACHINE_HOSTNAME} -- ${OS_DESC}"
  echo "- **CPU:** ${CPU_DESC} (${CPU_CORES} cores)"
  echo "- **RAM:** ${MEM_GIB} GiB"
  echo "- **Python:** ${PYTHON_VERSION}"
  echo "- **Node:** ${NODE_VERSION} (npm ${NPM_VERSION})"
  echo "- **uv:** ${UV_VERSION}"
  echo "- **Test date:** ${TEST_DATE_UTC}"
  echo "- **Suite result:** pytest tests/performance: $( [[ "$PY_STATUS" -eq 0 ]] && echo PASS || echo "FAIL (exit ${PY_STATUS})" )$( [[ "$SOAK" -eq 0 ]] && echo ", agent-runtime test/performance: $( [[ "$NODE_STATUS" -eq 0 ]] && echo PASS || echo "FAIL (exit ${NODE_STATUS})" )" )"
  echo ""

  if [[ "$SOAK" -eq 1 ]]; then
    echo "| Metric | Measured | Notes |"
    echo "| --- | --- | --- |"
    echo "| Mixed voice/task soak cycles completed | $(metric_value soak_mixed_cycles) | over $(awk -v s="$REALTIME_SOAK_MIXED_DURATION_SECONDS" 'BEGIN{printf "%.1f", s/3600}') real hour(s) |"
    echo "| Mixed soak RSS growth | $(metric_value soak_mixed_rss_growth_bytes) bytes | budget: bounded, never unbounded |"
    echo "| Mixed soak max pending-ack backlog | $(metric_value soak_mixed_max_pending_acks) events | must stay <= configured bridge capacity |"
    echo "| Idle-listening soak cycles completed | $(metric_value soak_idle_cycles) | over $(awk -v s="$REALTIME_SOAK_IDLE_DURATION_SECONDS" 'BEGIN{printf "%.1f", s/3600}') real hour(s) |"
    echo "| Idle soak RSS growth | $(metric_value soak_idle_rss_growth_bytes) bytes | budget: bounded, never unbounded |"
  else
    echo "| Metric | Measured | Design budget (15.5) | Detail |"
    echo "| --- | --- | --- | --- |"
    row "Event bridge cancel ack, end-to-end (real subprocess)" bridge_burst_cancel_p95_ms "p95 < 20ms"
    echo "| Event bridge cancel ack p50/p99 (real subprocess) | $(metric_value bridge_burst_cancel_p50_ms) / $(metric_value bridge_burst_cancel_p99_ms) ms | -- | p50/p99 alongside the p95 budget row above |"
    row "Event bridge max queue depth under 1,000+20 burst" bridge_burst_max_queue_depth "never exceeds configured capacity"
    echo "| Progress-event coalescing | $(metric_value bridge_burst_progress_wire_transmissions) wire sends for 1,000 raw send() calls | fewer wire messages than raw sends | tool.progress coalescing |"
    row "Node event-loop lag under WS+DB load" node_event_loop_lag_p95_ms "p95 < 20ms"
    echo "| Node event-loop lag p50/p99 under load | $(metric_value node_event_loop_lag_p50_ms) / $(metric_value node_event_loop_lag_p99_ms) ms | -- | alongside the p95 budget row above |"
    echo "| Node RSS under WS+DB load | $(metric_value node_rss_bytes) bytes | contributes to the combined-RSS budget row | see note below |"
    row "Node event-loop lag under ~100ms/transaction DB contention" db_contention_event_loop_lag_p95_ms "p95 < 20ms"
    row "Cancel-equivalent ack latency during DB contention" db_contention_cancel_ack_ms "must not queue behind a DB transaction"
    echo "| DB transactions completed during contention window | $(metric_value db_contention_transactions_completed) transactions | sustained (not a single blip) | see raw logs |"
    echo "| Four resident-session RSS per soak round (bytes, 1,000 turns) | $(metric_value session_memory_rss_after_round_bytes) | < 1.2GB (excl. external model services) | comma-separated, one per round |"
    row "Resident-session RSS growth after warmup (1,000 turns)" session_memory_growth_after_warmup_bytes "bounded, never unbounded"
    echo ""
    echo "Local barge-in cancel (\`tests/performance/test_barge_in_latency.py\`) and process-budget"
    echo "(\`tests/performance/test_process_budget.py\`) checks ran as part of the suite above"
    echo "(see suite result); they do not print a standalone numeric metric line, so they are not"
    echo "duplicated in the table -- their PASS/FAIL is already captured by the suite result line."
    echo ""
    echo "Note: no single test isolates a pure *idle* RSS reading in isolation from all load --"
    echo "the RSS figures above are measured either under sustained WS+DB load (Node) or after"
    echo "1,000 real turns across four resident sessions, both of which are honest, real"
    echo "measurements, just not literally \"process just started, doing nothing\" RSS. Reported"
    echo "as-is rather than rounded up to a number nothing here actually measured."
  fi
} > "$SECTION_FILE"

# --- splice the section into the baseline file ------------------------------

BEGIN_MARK="<!-- BEGIN:${REPORT_MARKER} -->"
END_MARK="<!-- END:${REPORT_MARKER} -->"

if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "==> ${BASELINE_FILE} does not exist yet -- this should not happen outside a fresh checkout" >&2
  echo "    missing its committed skeleton; refusing to fabricate one from scratch here." >&2
  exit 1
fi

if ! grep -qF "$BEGIN_MARK" "$BASELINE_FILE" || ! grep -qF "$END_MARK" "$BASELINE_FILE"; then
  echo "ERROR: ${BASELINE_FILE} is missing the ${BEGIN_MARK}/${END_MARK} markers this script splices into." >&2
  exit 1
fi

NEW_FILE="$WORK_DIR/baseline.md"
{
  sed -n "1,/${BEGIN_MARK//\//\\/}/p" "$BASELINE_FILE"
  echo ""
  cat "$SECTION_FILE"
  echo ""
  sed -n "/${END_MARK//\//\\/}/,\$p" "$BASELINE_FILE"
} > "$NEW_FILE"
mv "$NEW_FILE" "$BASELINE_FILE"

echo "==> Wrote ${REPORT_LABEL} section into ${BASELINE_FILE}"

OVERALL_STATUS=0
[[ "$PY_STATUS" -eq 0 ]] || OVERALL_STATUS=1
[[ "$NODE_STATUS" -eq 0 ]] || OVERALL_STATUS=1
exit "$OVERALL_STATUS"
