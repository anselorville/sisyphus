# Software Release Acceptance -- Autonomous Swarm Voice Agent

This is the final acceptance record for Task 20 (final cleanup, rename, and
release acceptance). It records, for each of the 12 checklist items below, a
verdict and the specific automated-test evidence backing it.

**Honesty framing (read this before the checklist).** This development
environment has no real microphone/speaker hardware, no configured real
LLM/Pi provider credentials, and no Raspberry Pi. Genuine end-to-end LIVE
voice conversation against a real backend, with a human talking and
listening, has never happened and cannot happen here. Every item below is
backed by real, currently-passing automated test evidence (exact file +
test name, verified by running the suites on **2026-07-26** in this
worktree -- see "Suite run evidence" at the end of this document for the
literal pass counts). Where genuine live-hardware/credential verification
is what would be needed and automated tests cannot stand in for it, this
is stated explicitly as **NOT VERIFIED -- requires live hardware/
credentials/deployment, pending**, rather than claiming a manual check
that did not happen.

---

## 1. Full-duplex listen/speak

**VERIFIED via automated tests** (architecture/unit level -- concurrent
bidirectional audio pipeline; NOT a live audible check).

- `tests/realtime/test_media_pipeline.py::test_media_pipeline_contains_no_business_llm`
  confirms `build_media_pipeline()` wires `transport.input()` and
  `transport.output()` into a single Pipecat `Pipeline` -- one bidirectional
  audio plane, not two independent half-duplex pipelines.
- `tests/test_mic_gate.py::test_audio_arriving_during_close_grace_is_forwarded_then_closed_audio_is_silent`
  confirms the input audio stream is never torn down while "closed" (only
  zeroed) -- the transport keeps receiving audio continuously regardless of
  turn-taking state, which is what makes the output side ("speak") able to
  run concurrently rather than needing the input side stopped first.
- `tests/test_speculative_pipeline.py::test_mic_close_releases_buffered_tts_frames_in_arrival_order`
  and `test_interruption_drops_buffered_tts_before_the_next_mic_close`
  confirm TTS output flows independently of STT input state (buffered/
  released on its own timeline, not blocking or blocked by the input side).

**NOT VERIFIED -- requires live hardware, pending.** Actually hearing
simultaneous microphone capture and speaker playback on real audio hardware
has not been done in this environment (no microphone/speaker available).

---

## 2. Local barge-in

**VERIFIED via automated tests** (frame-level correctness + latency
budget; NOT a live audible check).

- `tests/performance/test_barge_in_latency.py::test_local_barge_in_cancel_p95_is_under_budget`
  -- directly measures local barge-in cancel latency against the design
  budget (section 15.5: VAD start -> local TTS cancel, p95 < 150ms). Passed
  as part of the dev-machine suite run recorded in
  `.proj-init/performance-baseline.md` (that file notes this test "ran as
  part of the suite" and does not print a standalone metric line, but its
  PASS/FAIL is captured in the suite result).
- `tests/realtime/test_speech_queue.py::test_user_started_speaking_cancels_current_audio_locally`
  and `test_barge_in_clears_pending_progress_but_preserves_final` -- confirm
  the speech queue cancels in-flight/queued audio locally (no round trip to
  the sidecar needed) the moment the user starts speaking again, while
  still preserving a final answer already committed.
- `tests/test_speculative_pipeline.py::test_interruption_drops_buffered_tts_before_the_next_mic_close`
  -- confirms an `InterruptionFrame` clears buffered TTS output.

**NOT VERIFIED -- requires live hardware, pending.** Confirms the
cancellation logic is correct and fast at the frame/queue level; actually
hearing a bot's speech audibly cut off mid-sentence when a real person
talks over a real speaker requires a microphone and speaker, not available
here.

---

## 3. stop-speech / cancel / steer / follow-up / new-task interruption semantics

**VERIFIED via automated tests** -- this classification is deterministic,
rule-based, and synchronous (no LLM call), so these tests exercise the
real production code path with no live-service gap at all.

- `agent-runtime/test/routing/interruption-router.test.ts` --
  `InterruptionRouter.classify` describe block: explicit stop-phrase and
  cancel-phrase recognition even with no active task
  ("still recognizes an explicit stop phrase with no activeTask",
  "still recognizes an explicit cancel phrase with no activeTask"),
  steer/follow-up falling back to new_task when there's no active task to
  bind to, priority ordering (stop_speech > cancel > steer/follow_up), exact-
  tier matching for short ambiguous tokens (e.g. bare "停" vs. "停" inside an
  unrelated sentence about parking), and taskId propagation.
- `agent-runtime/test/routing/reflex-router.test.ts` --
  `ReflexRouter.route priority order`: tier 1 (explicit stop/cancel, which
  "win even while an elevation dialog is open"), tier 2 (elevation dialog
  responses), tier 3 (steer/follow_up against the active task), tier 4
  (capability-tag match for new tasks), tier 5 (Stress Judge escalation),
  tier 6 (general-worker fallback); plus
  `"never calls an LLM: route() is synchronous and returns a plain object, not a Promise"`
  and a dedicated performance test,
  `"keeps rule-routing p95 under 2ms across 100,000 calls"`.

---

## 4. Code/Web/Device/Mail worker castes

**VERIFIED via automated tests.**

- `agent-runtime/test/tools/baseline-workers.test.ts`, describe
  "baseline worker role manifests: least-privilege tool sets":
  - `"Code Worker gets exactly Pi's built-in coding tools"`
  - `"Web Scout gets exactly its two custom tools and nothing filesystem/terminal-shaped"`
  - `"Device Steward gets exactly device_status and service_action -- never write or edit"`
  - `"Mail Worker gets exactly its agently-cli mail operations -- never bash"`
  - (also covers Inspector and Memory Curator castes, and
    `"every new manifest has a distinct id, a matching prompt file, and declared capabilities"`)

---

## 5. Single email direct send

**VERIFIED via automated tests** (mocked `agently-cli` subprocess, not a
real mailbox).

- `agent-runtime/test/tools/mail/agently-mail.test.ts`, describe
  "two-phase confirmation protocol":
  `"automatically completes two CLI phases for a single email"` -- a single
  recipient sends autonomously through both CLI confirmation phases without
  requiring elevation.
- Complemented by `"passes the identical phase-1 arguments in phase 2, plus the confirmation token"`
  and `"a handful of CC/BCC recipients is not bulk purely because count > 1"`
  (confirms a small CC/BCC list still counts as "single-email direct send,"
  not bulk).

**NOT VERIFIED -- requires live credentials, pending.** No real
`agently-cli`/mailbox credentials exist in this environment; the CLI
subprocess is mocked in the test.

---

## 6. Bulk email requires elevation

**VERIFIED via automated tests.**

- `agent-runtime/test/tools/mail/agently-mail.test.ts::"requires elevation for bulk delivery"`.
- `agent-runtime/test/tools/diplomacy-officer.test.ts`, describe "9.3
  elevate defaults": `"mailing-list-style broadcast (audience at/above threshold) elevates"`,
  and the boundary case `"a handful of CC/BCC recipients is NOT bulk purely because count > 1"`
  (confirms the threshold is a real audience-size rule, not "more than one
  recipient").

---

## 7. High-risk system action requires elevation

**VERIFIED via automated tests.**

- `agent-runtime/test/tools/device-tools.test.ts::"shutdown on any service always elevates, regardless of ownServiceNames"`
  and `"restarting a different (non-own) service elevates and never calls the controller"`
  (contrasted with `"restarting the app's own service runs autonomously (ALLOW_LOGGED) and logs the action"`,
  confirming the elevation boundary is deliberate, not blanket).
- `agent-runtime/test/tools/diplomacy-officer.test.ts`, describe "9.3
  elevate defaults": `"payment always elevates, even a single low-audience transfer"`,
  `"publish always elevates (public release / prod deploy / push-to-remote), even if reversible and small"`,
  `"any threatensAvailability flag elevates regardless of operation type"`,
  and `"a large-scale, unrecoverable delete elevates"`.
- `agent-runtime/test/tools/capability-gateway.test.ts`, describe
  `CapabilityGateway.execute -- ELEVATE`: confirms an ELEVATE decision
  actually blocks execution (`"does not run the operation and rejects instead of resolving with a fake-success placeholder"`),
  persists a scoped pending-authorization request, and only lets it through
  "exactly once" after approval.

---

## 8. Four ecology states (prosperous/conserving/reserve/hibernating)

**VERIFIED via automated tests.**

- `agent-runtime/test/ecology/queen.test.ts`, describe "Queen.evaluate --
  fuller food-state coverage": `"prosperous allows hatching and expansion when there is population headroom"`,
  `"prosperous still freezes births once the population cap is already full"`,
  `"conserving stops non-essential exploration but does not freeze births or sleep workers"`,
  `"reserve freezes births specifically, on top of pausing exploration"`,
  `"hibernating sleeps non-voice workers specifically, on top of every reserve-level restriction"`
  -- all four bands' distinct behavioral effects, individually asserted.
- `agent-runtime/test/economy/api-budget.test.ts`, describe `"foodState"`
  -- the shared food-state vocabulary/derivation these bands are computed
  from.

---

## 9. Soft hibernation, hard hibernation, auto-recovery

**VERIFIED via automated tests.**

- `agent-runtime/test/roles/session-manager.test.ts`, describe
  "hibernation gating (Task 14: Queen-driven soft/hard hibernation)":
  `"soft hibernation refuses an ordinary (non-voice-essential) role's prompt()"`,
  `"soft hibernation still allows a role the injected isVoiceEssential predicate accepts"`,
  `"hard hibernation refuses every role's prompt(), even one the isVoiceEssential predicate accepts"`,
  and `"gates steer() and followUp() the same way it gates prompt()"`.
- `agent-runtime/test/voice/voice-herald.test.ts`, describe
  `"VoiceHerald.accept -- hard-hibernation local prompt (Task 14 addition)"`.
- Auto-recovery: `agent-runtime/test/economy/api-budget.test.ts::"resets a provider's spend once its daily window elapses"`
  demonstrates the budget ledger (and therefore the food-state band derived
  from it) automatically returns to full ordinary capacity once the daily
  window elapses, with no manual reset action -- this is the mechanism the
  design's "announce recovery" language (see
  `agent-runtime/src/economy/api-budget.ts`'s module docstring) refers to.
  `agent-runtime/test/ecology/queen.test.ts`'s cadence tests
  (`"becomes due once the configured interval elapses..."`,
  `"becomes due once the configured event-count threshold is reached..."`)
  confirm the Queen keeps re-evaluating on its own cadence, so an improved
  food state is picked up automatically rather than requiring a manual
  trigger.

---

## 10. Dynamic role birth, isolation trial, promotion, sleep

**VERIFIED via automated tests.**

- Birth: `agent-runtime/test/ecology/role-incubator.test.ts`, describe
  `RoleIncubator.propose`: `"copies the nearest genome and adds only the gap's missing tools/capabilities/prompt fragments"`,
  `"never invents a capability or tool the gap did not name"`,
  `"sets lifecycle to trial with a one-task-cycle TTL"`,
  `"records a non-empty birth reason and at least one death condition, and the result always validates"`.
- Isolation trial: `agent-runtime/test/isolation/rpc-chamber.test.ts`,
  describe `"RpcChamber isolation capacity (Step 3 mandated test)"`:
  `"allows only one isolated role in the first release"` -- the newly-born
  ("trial") role actually runs inside its own isolated subprocess chamber,
  capacity-limited; complemented by `"refuses to spawn an invalid genome (no birth reason/death conditions), without consuming capacity"`.
- Promotion/sleep: `agent-runtime/test/ecology/pheromone-map.test.ts`,
  describe `"evaluateRoleLifecycle (Step 6 promotion/retirement rules)"`:
  `"promotes to resident after 3 cross-task successes with no serious incident"`,
  `"does not promote when a serious incident accompanied the successes"`,
  `"sleeps after 2 consecutive failures, even if it would otherwise qualify for promotion"`.
- Sleep also independently covered by `agent-runtime/test/ecology/population.test.ts`,
  describe `PopulationRegistry.sleep`: `"moves an active role to sleeping without forgetting it"`,
  `"frees an active-cap slot for a new hatch"`, `"a sleeping role can hatch() again later"`.

---

## 11. Sidecar crash and task recovery

**VERIFIED via automated tests** (both sides of the process boundary).

- Node/agent-runtime side: `agent-runtime/test/integration/recovery.test.ts`,
  describe `"crash recovery"`:
  `"recovers a pending task exactly once after a simulated hard crash and restart against the same db"`
  -- tears down the DB Worker/server/session manager/RPC chamber directly
  (skipping the graceful shutdown path entirely, simulating a hard process
  kill), restarts a brand-new runtime against the same SQLite file, and
  confirms the exact task is recovered exactly once (recovery runs
  automatically via `autoRecoverPending`, default true, per
  `agent-runtime/src/index.ts`). Complemented by
  `"does not recover anything once a task has already reached a terminal state before the crash"`.
- Python/media-plane side:
  `tests/integration/test_agent_runtime_bridge.py::test_sidecar_crash_recovers_exactly_one_task`
  -- the equivalent check from the Python event-bridge's perspective (the
  sidecar subprocess is genuinely built and crashed, not just mocked; see
  the `sidecar_built` fixture).

Both were re-run in this worktree on 2026-07-26 and passed (see "Suite run
evidence" below).

---

## 12. Python/Node performance budgets

**VERIFIED via automated tests, dev-machine only. Raspberry Pi is
explicitly NOT VERIFIED -- pending real hardware, and this is not a gap in
this task's work; it is an honestly-documented, pre-existing limitation of
the development environment (no Raspberry Pi has ever been available to
build against, and none is expected to become available here).**

See `.proj-init/performance-baseline.md` in full for the authoritative,
regeneratable record. Summary:

- The budget table (design doc section 15.5) and a dev-machine baseline
  (Apple M4, Darwin 25.5.0, Python 3.12.13, Node v24.16.0) are recorded
  with real measured numbers for every metric that produces one -- e.g.
  event bridge cancel-ack p95 8.194ms (budget: <20ms), Node event-loop lag
  p95 6.353ms under WS+DB load (budget: <20ms), Node event-loop lag p95
  6.291ms under DB contention (budget: <20ms), four resident-session RSS
  after 1,000 turns all ~228MB (budget: <1.2GB combined). Local barge-in
  cancel (`tests/performance/test_barge_in_latency.py`) and Python process-
  budget (`tests/performance/test_process_budget.py`) checks passed as part
  of the same suite run (they don't print a standalone metric, so their
  PASS/FAIL is captured by the suite result line, not a table row).
- The Raspberry Pi section is explicitly marked
  **"PENDING REAL HARDWARE ACCESS -- NOT YET RUN"** and states plainly that
  no Pi hardware is available or expected to become available to the agent
  that authored it, and that the dev-machine section is never a substitute
  for it. `scripts/benchmark-runtime.sh --raspberry-pi` is implemented and
  refuses to run on anything that isn't genuine ARM Linux, so it cannot be
  used to mislabel dev-machine numbers as Pi numbers.
- This task did not re-run `scripts/benchmark-runtime.sh` (no dev-machine
  hardware/timing change was made this task; the deletions/renames in this
  task do not touch any code path the benchmark exercises), but re-ran the
  full `tests/performance/` and `agent-runtime/test/performance/` suites
  directly as part of this task's own verification pass (see below) and
  confirmed every one of them still passes after the cleanup.

---

## Suite run evidence (this task, 2026-07-26, this worktree)

- `uv run pytest -q` -- **66 passed** (includes every file under
  `tests/`, `tests/realtime/`, `tests/integration/`, and
  `tests/performance/`).
- `tests/integration/test_agent_runtime_bridge.py` re-run individually --
  all 3 tests passed, including `test_sidecar_crash_recovers_exactly_one_task`
  (confirms the sidecar subprocess is genuinely built and exercised, not
  skipped).
- `cd agent-runtime && npm test` -- **35 test files, 509 tests, all
  passed** (includes every file under `agent-runtime/test/`, across
  ecology, economy, isolation, roles, routing, tools, transport, voice,
  storage, tasks, protocol, inspection, memory, integration, and
  performance).

Both suites were run fresh after this task's deletions/migrations/renames
were applied, not merely assumed to still pass from an earlier task's run.

## What this document is not

This document does not claim, and nothing in this task's work claims, that
a live voice conversation with a real backend (real microphone, real
speaker, real LLM/cloud credentials) has ever occurred in this environment.
Every "VERIFIED" verdict above is scoped precisely to what the cited
automated test actually exercises -- unit/integration-level correctness of
the real production code paths, run against mocked I/O boundaries (fake
WebSocket servers, mocked subprocesses, fake clocks) where a live external
dependency would otherwise be required. Where the honest verdict is "we
have not and cannot check this here," that is what is recorded, per this
project's own standing requirement (see `.proj-init/performance-baseline.md`'s
Raspberry Pi section for the template this document follows).
