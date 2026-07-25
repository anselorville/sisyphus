# Performance Baseline

Section 15.5 of `.proj-init/04-autonomous-swarm-voice-agent-software-design.md`
defines this project's performance budget. This file records ACTUAL measured
results against that budget. Dev machine and Raspberry Pi are recorded in
**separate sections below** -- per the design doc's own explicit requirement,
dev-machine results must never substitute for Raspberry Pi acceptance data.

Regenerate/update with:

```bash
scripts/benchmark-runtime.sh --host           # dev machine, CI-safe suite -- safe to run anywhere
scripts/benchmark-runtime.sh --raspberry-pi   # real Pi hardware ONLY -- refuses to run on anything else
scripts/benchmark-runtime.sh --host --soak    # the REAL long-duration (1h + 8h) soak, run separately
```

Every number below comes from a `PERF_METRIC` line a real test in
`tests/performance/` or `agent-runtime/test/performance/` actually printed --
this file is generated from those test runs, never hand-typed, so it can
always be reproduced exactly by re-running the command above. This section
of the report is also expected to be independently re-run by a reviewer, not
just self-reported by whoever last regenerated it.

## Budget table (design doc section 15.5)

| Metric | Target |
| --- | --- |
| VAD start -> local TTS cancel | p95 < 150ms |
| User starts speaking -> perceived playback stop | p95 < 250ms |
| Local event bridge one-way queueing + processing | p95 < 20ms |
| Reflex Router rule routing | p95 < 10ms |
| Final transcript -> first feedback | p95 < 1s |
| Python event-loop lag | p95 < 20ms |
| Node event-loop lag | p95 < 20ms |
| Python + Node combined idle RSS | < 800MB (excl. external model services) |
| Four active resident sessions, combined RSS | < 1.2GB (excl. external model services) |
| Concurrent isolation chambers | <= 1 (v1) |
| Unbounded queues | 0 |

<!-- BEGIN:HOST -->

## Dev-machine baseline

_CI-safe suite run (`--host`/`--raspberry-pi` without `--soak`)._

- **Machine:** AL-Mac.local -- Darwin 25.5.0 arm64
- **CPU:** Apple M4 (10 cores)
- **RAM:** 16.0 GiB
- **Python:** Python 3.12.13
- **Node:** v24.16.0 (npm 12.0.1)
- **uv:** uv 0.11.17
- **Test date:** 2026-07-25 20:51 UTC
- **Suite result:** pytest tests/performance: PASS, agent-runtime test/performance: PASS

| Metric | Measured | Design budget (15.5) | Detail |
| --- | --- | --- | --- |
| Event bridge cancel ack, end-to-end (real subprocess) | 8.194 ms | p95 < 20ms | see raw logs |
| Event bridge cancel ack p50/p99 (real subprocess) | 6.765 / 8.612 ms | -- | p50/p99 alongside the p95 budget row above |
| Event bridge max queue depth under 1,000+20 burst | 50 events | never exceeds configured capacity | see raw logs |
| Progress-event coalescing | 10 wire sends for 1,000 raw send() calls | fewer wire messages than raw sends | tool.progress coalescing |
| Node event-loop lag under WS+DB load | 6.353 ms | p95 < 20ms | see raw logs |
| Node event-loop lag p50/p99 under load | 6.287 / 6.435 ms | -- | alongside the p95 budget row above |
| Node RSS under WS+DB load | 148160512 bytes | contributes to the combined-RSS budget row | see note below |
| Node event-loop lag under ~100ms/transaction DB contention | 6.291 ms | p95 < 20ms | see raw logs |
| Cancel-equivalent ack latency during DB contention | 0.808 ms | must not queue behind a DB transaction | see raw logs |
| DB transactions completed during contention window | 6 transactions | sustained (not a single blip) | see raw logs |
| Four resident-session RSS per soak round (bytes, 1,000 turns) | 228163584,228327424,228327424,228327424 | < 1.2GB (excl. external model services) | comma-separated, one per round |
| Resident-session RSS growth after warmup (1,000 turns) | 163840 bytes | bounded, never unbounded | see raw logs |

Local barge-in cancel (`tests/performance/test_barge_in_latency.py`) and process-budget
(`tests/performance/test_process_budget.py`) checks ran as part of the suite above
(see suite result); they do not print a standalone numeric metric line, so they are not
duplicated in the table -- their PASS/FAIL is already captured by the suite result line.

Note: no single test isolates a pure *idle* RSS reading in isolation from all load --
the RSS figures above are measured either under sustained WS+DB load (Node) or after
1,000 real turns across four resident sessions, both of which are honest, real
measurements, just not literally "process just started, doing nothing" RSS. Reported
as-is rather than rounded up to a number nothing here actually measured.

<!-- END:HOST -->

<!-- BEGIN:PI -->
## Raspberry Pi baseline

**PENDING REAL HARDWARE ACCESS -- NOT YET RUN.**

No Raspberry Pi hardware is available in the environment this baseline was
authored in, and none is expected to become available to the agent that
wrote this file. Per the design doc's own explicit requirement (section
15.5: dev-machine and Raspberry Pi performance targets are recorded
separately, and dev-machine results may never substitute for Pi acceptance
data), the dev-machine section above is **not** a stand-in for this section.
This section intentionally reports nothing else until real Pi hardware is
available -- fabricating, estimating, or simulating numbers here would
violate the one rule this section exists to enforce.

`scripts/benchmark-runtime.sh --raspberry-pi` is fully implemented today and
ready to run the moment real Pi hardware is available: it runs the exact
same benchmark logic as `--host` (same tests, same metrics, same report
format), just recorded under this section instead of the dev-machine one.
It also refuses to run at all on any machine that isn't genuinely ARM Linux
(Raspberry Pi's actual deployment target -- 64-bit Ubuntu, ARM64 Node.js),
so it cannot be used, even by mistake, to mislabel dev-machine numbers as Pi
numbers.

Until a real run happens here, every section 15.5 budget row is
**unverified on Raspberry Pi** and, per the project's own release-acceptance
plan (`.proj-init/05-autonomous-swarm-voice-agent-development-action-plan.md`:
this task's performance report must be independently re-run, not just
self-reported), must block release until it is.
<!-- END:PI -->
