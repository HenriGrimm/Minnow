# Orchestrator V2 — PRD

**Status:** Draft for review · **Date:** 2026-08-28 · **Supersedes:** the V1 board engine (`src/state/orchestrate-*`, 26,657 lines)

## 1. Problem

V1 works in exactly one configuration: a single agent at concurrency 1. Everything else is unreliable.

That is not a coincidence. Concurrency 1 makes the slot machinery a no-op, guarantees only one chat streams at a time (so no ordering races), and avoids merge conflicts entirely. **Sequential single-agent is the one path with no concurrency in it.** Every other path exercises the parts that are broken.

### Root cause

The orchestrator has no state machine. It has a mutable struct plus a swarm of event listeners trying to keep it consistent.

Five symptoms, one cause:

1. **Progress is inferred, not recorded.** The source of truth for "did this task succeed" is a chat's *stream-end* event plus regex-scraping the transcript. `orchestrate-failure-classify.ts` is 303 lines of marker lists (`ECONNREFUSED`, `spawn ELOOP`, `psql: error`) guessing *why* an agent stopped. `resolveBoardReport` has three fallback layers. When an agent forgets to report, the system nudges twice (`MISSING_REPORT_NUDGE_CAP = 2`), then guesses.

2. **Three independent, leak-prone concurrency mechanisms.** Launch-slot reservations (a `chatId` Map), pipeline holds (a `WeakMap` keyed on *board object identity* — "if the board object is ever swapped, holds vanish"), and `countRunningTaskChats`, which counts by inspecting `isChatStreaming()` UI flags. Each has TTL sweeps and expiry logging. Confirmed deadlock: the env-fixer pre-reserves the tester's slot, the concurrency check counts that reservation, and sequential mode freezes permanently.

3. **Ordering is unsound because it rides UI lifecycle.** `notifyChatStreamEnded` fires *before* `setStreaming(false)`. `drainTaskQueue` carries a sort hack to compensate. `runAfterChatRelease`, `flushChatContinuationIfIdle`, and microtask retries are all band-aids for that single inversion.

4. **Recovery policy is scattered across six call sites and six counters** — `buildAttempts`, `testAttempts`, `fixerAttempts`, `envFixAttempts`, `stopRetries`, `selfHealRound` — mutated in self-heal, stream-end finalize, both `apply*FailureState` helpers, and both fixers. Nothing can answer "what happens to this task next?"

5. **It runs in the renderer.** Hence `board-display-wake.ts`, `board-boot-resume.ts`, OOM pause, and `reconcileRunningBoardsAfterDisplayWake` — an entire subsystem that exists only to repair state after the UI was suspended.

### Supporting evidence

- `BoardTask` carries ~50 fields; 6 are retry counters mutated from 6 places.
- 52 test files in `test/orchestrate/`, several of which encode workarounds rather than behaviour.
- The system **already writes an event log** (`BoardLogEvent`, 35 event types, JSONL disk sink) — but capped at 100 entries and used only for debugging.

## 2. What the research says

- **Durable execution** (Temporal, Restate, Inngest) converges on one answer: append-only event history, state as a fold over it, replay on crash. Restart *is* recovery; there is no reconciliation subsystem.
- **Co-Coder (arXiv 2606.00953)** measured naive file-parallel coding agents: **+60% cost for +3.2% correctness**. Claude Code with Agent Teams had the *fastest latency and the lowest correctness*. Parallelism pays only above ~1.0 interdependency edge density. **Structure beats agent count.**
- **Anthropic's multi-agent research system**: orchestrator–worker with 3–5 subagents; each subagent gets an explicit objective, output format, and task boundary. Their fixes were mostly delegation-prompt fixes, not more machinery.

Design consequence: V2 gets *less* machinery and *tighter* task contracts, not more coordination code.

## 3. Goals / non-goals

**Goals**

- Multi-agent runs are as reliable as today's sequential single-agent path.
- Self-healing is structural, not a feature: a crashed, hung, or vanished agent is recovered by the same code path that starts work normally.
- Set-and-forget: an unattended overnight run completes everything it can and reports once.
- The engine survives renderer reload, display sleep, and app restart.

**Non-goals**

- Beating V1 on wall-clock latency. Correctness first (see Co-Coder).
- Preserving V1's board state format. V2 is a clean cut.
- Solving normal (non-board) chat on day one — but see §9, the runner is designed to absorb it.

## 4. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Migration | **Clean-room engine, V1 deleted.** No V1 imports. Board UI kept, its data source swapped. |
| 2 | Runtime | **Server-side.** Engine + journal in the Node server. Renderer is a view. |
| 3 | Parallelism | **Reliability first.** Low default concurrency, cohesion-clustered tasks, fan out only where provably safe. |
| 4 | Integration | **Worktrees kept; merge queue replaces the merge-fixer agent.** Rebase-before-merge; conflicts re-open the owning task. |
| 5 | Scope | **All chat eventually — V2 is step one.** The headless runner is designed board-agnostic so normal chat (§8 Phase 6) and sub-agents (§8 Phase 8) can adopt it later. Board agents ship first. |
| 6 | Autonomy | **Running / Stopped + a concurrency number.** Sequential is concurrency 1. AFK is Running with no interactive gates. Four boolean flags deleted. |
| 7 | Dead ends | **Skip and continue.** Abandon the task, skip only genuine dependents, run everything else, report once at the end. |
| 8 | Final test | **Real server-side browser driver.** Built as its own workstream; does not block a working orchestrator. |

## 5. Architecture

> **Principle: no LLM in the control plane.**
>
> The LLM authors plans at the front and writes the report at the back. Between those two boundaries every decision — scheduling, retry routing, merge ordering, state transitions — is a pure function over a typed graph.
>
> This is not stylistic. §5.1 makes determinism load-bearing: `state = fold(journal)` only recovers correctly if replay reproduces the same decisions. An LLM anywhere in the control loop breaks replay, and therefore breaks crash recovery, which is the entire point of the journal.
>
> Corollary: **V2 has no planner chat.** V1's is a long-lived conversation that lifecycle reports are appended into — that *is* review-finding #3 (reports interleaving a streaming turn), and it accumulates context across a 6-hour run for no benefit. V2 replaces it with two stateless calls: parse-or-convert at the start (§5.9), report at the end.

### 5.1 The journal is truth

One append-only JSONL journal per board at `~/.minnow/boards/<boardId>/journal.jsonl`. Board state is a **pure fold** over it. No mutation outside the fold.

Prior art to build on: `server/runs/store.js` (atomic temp-file + rename writes) and `server/orchestrate/board-log-sink.js` (JSONL board events).

**Invariant: every event records a completed side effect, never an intent.** You do not log "starting task"; you log `task.attempt.started` *after* the process exists. This is what makes replay safe.

Event set (~12, vs V1's 35 log types):

```
board.created        { boardId, planPath, tasks[], waves[] }
board.started        { concurrency }
board.stopped        { reason: 'user' | 'complete' | 'terminal' }
task.attempt.started { taskId, attemptId, role, worktree }
task.attempt.ended   { attemptId, outcome, summary, evidence }
merge.enqueued       { taskId }
merge.succeeded      { taskId, sha }
merge.conflicted     { taskId, files[] }
task.abandoned       { taskId, reason, evidence }
task.skipped         { taskId, blockedBy }
final.test.ended     { outcome, runInstructions }
run.finished         { summary }
```

**The six retry counters disappear.** `buildAttempts` becomes `events.filter(e => e.taskId === t && e.role === 'builder').length`. There is no counter to increment in six places, so there is nothing to desynchronise.

This one property also deletes boot-resume, display-wake reconcile, and OOM-pause repair. All three become *replay*.

### 5.2 One reconcile loop

```
tick():
  state   = derive(journal)        // pure fold
  desired = plan(state)            // pure: which {taskId, role} should be running now
  actual  = effector.inspect()     // which processes actually exist
  diff(desired, actual) -> start / stop
```

`plan()` is pure and total. Rules: a task is ready when all `dependsOn` have merged; respect the concurrency cap; never two attempts on one task; the merge queue is serialised.

**This is where self-healing comes from, and it is free.** If a process died, `actual` lacks it, so the next tick starts it again. There is no stall detector, no watchdog, no nudge, no deferred continuation. Ticks fire on journal append, on process exit, and on a timer; the loop is idempotent, so running it twice is harmless.

Deleted by this section: `reserveLaunchSlot`, `PipelineHold`, `drainTaskQueue`, `taskQueueByGroupId`, `drainInFlightByGroupId`, `autoDelegateNext`, `runAfterChatRelease`, `flushChatContinuationIfIdle`, `stallRecoveryScheduled`, and every wake reconciler.

### 5.3 Attempts have typed exits

An attempt is a process with a typed result. The **agent** produces the first three; the **runner** produces the last three.

```ts
type AttemptResult =
  | { outcome: 'pass';    summary: string; evidence: string[] }
  | { outcome: 'fail';    summary: string; blockers: string[] }
  | { outcome: 'blocked'; summary: string; needs: string[] }   // environment cannot support the work
  | { outcome: 'no_report' }                                   // agent ended without reporting
  | { outcome: 'crashed'; error: string }
  | { outcome: 'timeout' }
```

No transcript scraping. **`orchestrate-failure-classify.ts` (303 lines) is deleted.**

`blocked` is the key replacement for the infra classifier. Rather than guessing infra-vs-code from `ECONNREFUSED`, the agent is instructed: *if the environment prevents you from proceeding, report `blocked` and say what you need.* The agent has always known this; it was never asked.

### 5.4 Policy is one table

`(role, outcome, attemptCount) -> Action`, evaluated in exactly one place.

| role | outcome | attempts | action |
|---|---|---|---|
| builder (after merge) | pass | — | advance → merge queue (the tester already passed; a conflict fix goes straight back to merge) |
| builder | pass | — | advance → tester |
| builder | fail | < 2 | retry builder, failure-aware seed |
| builder | fail | ≥ 2 | abandon |
| builder | blocked | < 1 | retry builder, **repair seed** (same worktree) |
| builder | blocked | ≥ 1 | abandon |
| builder | no_report | < 1 | retry builder, continue seed |
| builder | crashed \| timeout | < 2 | retry builder, continue seed |
| tester | pass | — | advance → merge queue |
| tester | fail | < 2 | retry builder, fix seed carrying test output |
| tester | fail | ≥ 2 | abandon |
| tester | no_report \| crashed \| timeout | under budget | retry **tester**, initial seed (same worktree) — the build already passed, so it re-tests from scratch |
| merge | conflicted | < 2 | retry builder, rebase seed |
| merge | conflicted | ≥ 2 | abandon |

`Action = Retry{role, seedKind} | Abandon{reason} | Advance`. Testable as a table, with no I/O.

### 5.5 Fewer agent kinds: 6 → 2 (+1 at the finish)

V1 spawns per task: builder, tester, env-fixer, merge-fixer — plus a long-lived board planner and a final tester.

V2 has **Builder** and **Tester** in the loop, plus a **Final Tester** at the end. The full LLM roster for a run is therefore: plan author (outside the board, in the plan-writing path), Builder, Tester, Final Tester, and one stateless report writer. **The control plane makes zero LLM calls.**

- **The env-fixer is gone.** `blocked` retries the *builder* with a repair seed in its own worktree. That is whose worktree it is. This removes an agent kind and the entire env-fixer finalize/hold/leak path that caused the confirmed sequential deadlock.
- **The merge-fixer is gone.** Integration is a *mechanical* step (rebase, merge — no LLM). A conflict re-opens the owning task with a rebase seed; that task's agent has the context to resolve it.

### 5.6 Merge queue

Serialised. For each task reaching `pass`: rebase its worktree branch onto the current integration tip, then merge. Rebasing before merging makes conflicts rare and small. A conflict emits `merge.conflicted` and routes through the policy table — it never spawns a separate agent, and it blocks only other tasks' *merging*, never their building.

### 5.7 Parallelism where provably safe

Two gates before two tasks may run concurrently:

1. **`dependsOn`** — the explicit DAG the planner already emits.
2. **`touches`** — new. The planner declares each task's file globs. **The scheduler will not run two tasks with overlapping `touches` concurrently, even when `dependsOn` permits it.**

Gate 2 is a cheap mechanical approximation of Co-Coder's cohesion clustering, and it directly prevents the failure that cost them +60% for +3.2%: concurrently generated files violating each other's type contracts.

**Default concurrency: 2.**

### 5.8 Runtime topology

- **Engine** — Node, in the server process. Owns the journal, the reconcile loop, and the merge queue.
- **Renderer** — subscribes to `GET /api/boards/:id/events` (SSE; 10+ existing endpoints already use this pattern). Renders derived state, sends commands by POST, and **never mutates board state**.
- **Headless runner** — server-side turn loop for board agents. Deliberately board-agnostic (see §9).

Feasibility note: the tools Builder and Tester actually call — file read/write, `grep`, `execute_command`, `git_diff`, worktree ops — **already execute server-side** via `POST /api/tools` (36 modules in `server/tools/`, plus `server/worktree`, `server/terminal`, `server/git`). The renderer is only an HTTP client for them. The work is porting the *loop*, not the tools.

### 5.9 Plan intake is a parser, not an agent

V1 has an LLM call `board_init` after reading the plan. But the **Planner work-agent already emits a fully specified format** — its prompt carries a *"Required plan schema"* with non-negotiable quality requirements:

- `## Wave Breakdown` → `### Wave N — Name` → `#### Task W1-A: Title`
- `- **Build:** / - **Test:** / - **Accept:** / - **Depends on:**` on every task, no exceptions
- YAML front-matter with a `todos` array **enumerating every task id**

So `board_init`'s LLM is *deserializing something the producer already structured*. Plan → markdown → LLM → JSON is a lossy round-trip in which the markdown is merely the serialization format, and the LLM is doing the deserialization a parser should do.

The cost of that round-trip is visible in the prompts. The orchestrator prompt has to plead *"never emit `\"dependsOn\": []` — omit the field entirely"* — a workaround for a failure mode a parser cannot have. And `board_init`'s schema requires only `id, title, wave, category`: dependency edges, the thing the entire scheduler runs on, are optional and re-inferred from prose on every run, even though the Planner was required to state them explicitly.

V2 closes the round-trip:

1. **Formalise the existing format as a validated schema**, plus a new `- **Touches:**` glob list (§5.7). This is codifying what the Planner is already told to produce, not inventing a format.
2. **Validate at save time, not board load.** Today "non-negotiable" is a *request* in a prompt with nothing checking it. `save_file` on a plan should parse-and-validate, so a malformed plan fails while the Planner is still there to fix it. Cross-check the front-matter `todos` ids against the `#### Task` headings — each must account for the other.
3. **Board intake becomes `parsePlan(markdown) -> TaskGraph | ParseError[]`.** No model call.
4. **Externally authored plans** (hand-written, or from another tool) get a one-time LLM conversion into canonical form, written back to the file, then parsed deterministically. The user reviews the structure before the run.

What the parser buys that an LLM cannot:

- **Determinism**, which §5.1 now requires.
- **Loud failure** — a line number and a message, instead of a silently dropped task.
- **Cycle detection at parse time**, rather than deadlock discovery at runtime.
- **Validation against reality** — `touches` globs can be checked to match real files; `dependsOn` ids can be checked to exist.
- Free and instant, on every board load.

## 6. Autonomy model

Two states and a number.

- **Running / Stopped** — is the reconcile loop ticking.
- **Concurrency: N** — how many attempts may run at once.

Sequential = Running at N=1. AFK = Running with no interactive gates. Manual = Stopped, with the user starting individual tasks by hand.

Deleted: `executionMode`, `handsOff`, `pendingAfk`, `autoRunning`, `systemPaused`, `userStopped` — six fields that could contradict each other, replaced by one enum and one integer.

## 7. Dead ends

On `Abandon`: emit `task.abandoned`, emit `task.skipped` for genuine dependents only, and **keep running everything else**. One end-of-run report lists abandoned tasks with evidence and suggested next steps. An overnight run never stalls on minute three.

## 8. Phasing

| Phase | Deliverable | Proves |
|---|---|---|
| **0** | Journal schema, `derive()` fold, `plan()`, policy table, **plan-format schema + `parsePlan()`** — pure, no I/O | The whole decision surface is unit-testable as a table |
| **1** | Server engine + SSE + renderer as view, driven by a **scripted fake runner** | The scheduler is correct **without any LLM** |
| **2** | Headless runner over the existing `/api/tools`; concurrency 1 | Real builds run server-side |
| **3** | Worktrees + merge queue + `touches` exclusion + concurrency > 1 | Multi-agent works |
| **4** | Delete V1 (26,657 lines) | |
| **5** | Server-side browser driver (Playwright/CDP) + final integration test | Fully unattended verification |
| **6** | Normal chat adopts the headless runner | One engine |
| **7** | Chat-stream UI stays responsive mid-generation ([`chat-stream-ui-lag.md`](../archive/chat-stream-ui-lag.md), [MIN-727](https://linear.app/minnowai/issue/MIN-727)) | Token→DOM paint is coalesced; local tok/s win kept. Independent of 1–6; can start now. |
| **8** | Sub-agents adopt the headless runner; `src/agents/controller/` deleted | Every background agent gets the journal + reconcile properties, not just board attempts. Depends only on Phase 2. |

Phase 1 leans on existing prior art: `src/dev/orchestrate-scenarios/` (schema, adapters, catalog) and `server/orchestrate/board-testing/` (scenario-runner, fake-model-host). V2 promotes scripted board testing to a first-class capability — **the scheduler must be fully testable with zero model calls.**

## 9. Designing for "all chat eventually"

The runner must not know what a board is. Its interface:

```ts
runTurn({ chatId, seed, tools, model, onEvent }) -> AttemptResult
```

Board specifics (worktree cwd, allowed-tool subset, the report contract) are passed in, never assumed. Concretely: no board imports in the runner package, `ask_question` treated as an injected capability rather than a hardcoded absence, and outcome typing that generalises beyond pass/fail.

The two runners coexist during Phases 2–5: the client loop keeps serving normal chat while the server runner serves board agents. That is the strangle boundary, not debt.

**Sub-agents are the interface’s second consumer (Phase 8).** They are neither board attempts nor normal chat, and today they run their own renderer-side loop and supervisor — the same faults V1 had, listed as finding E in the implementation plan. Adopting `runTurn()` is what turns "board-agnostic" from a discipline into a property the tests hold: a second caller cannot be satisfied by a runner that quietly assumes a board.

**Deletion order, so nothing is removed early.** P6-D deletes the *client chat loop* (`src/tools/loop.ts`). The *client sub-agent runner* (`src/agents/sub-agent-runner.ts`) is a different file, still serving sub-agents at that point; it and `src/agents/controller/` are deleted by P8-G, not before.

## 10. What gets deleted

`orchestrate-board-actions.ts` (6,276), `orchestrate-self-heal.ts` (343), `orchestrate-failure-classify.ts` (303), `orchestrate-pipeline-holds.ts` (273), the launch-slot machinery, the queue drain, both fixers, `board-display-wake.ts`, `board-boot-resume.ts`, `oom-recovery.ts`, and the six retry counters — plus the orphaned `server/session/engine-bundle/` left over from the reverted MIN-354 v1 (deleted in P4-E / MIN-717; 18.04 MB on disk, of which ~6.20 MB was the packaged `.mjs`).

Deleted at Phase 8: `src/agents/controller/` (3,089 — the sub-agent watchdog, heartbeats, dispatch timers, last-write-wins registry mirror, and boot reconcile) and the client `src/agents/sub-agent-runner.ts` (1,375), superseded by `server/runner/`. `src/agents/sub-agent-config.ts` stays — it is configuration, and the effector reads it.

Also deleted: the **orchestrator work-agent** and its persistent planner chat, the `board_init` / `board_update_task` / `board_set_autonomy` tools, and the now-vestigial `delegate_tasks` (already excluded from the orchestrator's `allowedTools` and separately gated by auto-pilot, yet still carrying a "Do not call" section in the prompt).

## 11. Considered and rejected: an LLM advisor on escalation

Proposed during design: at the point where the policy table says `abandon`, call an LLM once with the task's full failure history and let it return a typed move (`retry with guidance` / `respecify` / `split` / `abandon`), which the engine would validate and journal.

Rejected:

- It would be the **only** nondeterministic element in the control plane. One exception forfeits the replay property that §5.1 depends on.
- Its safest move duplicates the failure-aware retry seed the Builder already receives.
- Its powerful moves (`split`, `respecify`) mutate the DAG mid-run — the most dangerous operation in the system — and would fire precisely when a run is already going badly.
- There is **no data** on how often `abandon` is the wrong call. This is recovery machinery for an unmeasured failure rate.
- Decision 7 already handles it: abandoning an unbuildable task and reporting exactly why *is* the correct outcome. Fixing the plan and re-running is a five-minute human loop.
- The cross-task pattern-spotting it was meant to provide belongs in the finish report, which is already an LLM pass over the whole journal — no new machinery, no control-plane risk.

**Kept open:** journal enough context on every abandonment (full attempt history, outcomes, diffs, test output) to retroactively measure how many abandonments a smarter policy would have saved. Revisit with evidence, or not at all.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Provider streaming must move server-side — the largest single piece | Phase 2 gate; the client loop keeps working throughout |
| Journal schema churn after Phase 2 | Version the event envelope; the fold tolerates unknown event types |
| Browser driver is a subproject | Phase 5, sequenced after a working orchestrator; Phases 0–4 deliver value without it |
| Clean cut strands in-flight V1 boards | Boards are per-plan and short-lived; document that in-flight V1 boards must finish or be discarded before upgrade |
| "All chat eventually" pulls unbuilt use cases into V2 decisions | §9 constrains the *interface* only; no normal-chat features are built in Phases 0–5 |

## 13. Open questions

1. **Journal retention** — cap per board, or keep forever? A long AFK run could produce thousands of events. Suggest: keep forever per board (they are small), with the fold memoised on a periodic snapshot.
2. **Final Tester before or after Phase 5?** A headless static ladder (typecheck/lint/unit/build) has value at Phase 3; only the browser step waits for Phase 5.
3. **What happens when a Builder's real diff exceeds its declared `touches`?** Options: fail the attempt, widen the glob and re-check for conflicts with in-flight siblings, or let it merge and rely on the merge queue. Affects how strict §5.7's exclusion gate can be.
4. **How strict should save-time validation be?** Hard-reject a malformed plan (the Planner must retry until it parses), or save it with warnings and require an explicit override to run the board? Hard-reject is cleaner but can trap a user whose plan is 95% right.

*Resolved during design:* who writes `touches` — the plan author declares them, and `parsePlan()` validates the globs against the real repo (§5.9). Whether the planner chat stays on the client loop — there is no planner chat (§5).
