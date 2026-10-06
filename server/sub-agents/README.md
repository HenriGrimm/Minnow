# `server/sub-agents` — the runless graph (P8-C / MIN-756) + effector (P8-D / MIN-757) + delivery (P8-E / MIN-758) + HTTP view (P8-F / MIN-759)

Sub-agent runs are independent. No `dependsOn`, no waves, no `touches`, no merge
queue, no worktrees, no integration, no final tester. If a dependency notion
starts growing here, it was copied from the board core rather than derived.

State is a pure fold over a journal at `~/.minnow/agents/<parentChatId>/` (the
namespace P8-B added). The **graph modules** (`events`, `derive`, `plan`,
`policy`, `graph`, `evidence`, `index`) do not read that path — purity, like
`server/orchestrator/core/`.

## The three rules

These apply to the graph modules. Enforced by `test/sub-agents/core-purity.test.mjs`.

1. **No I/O.** No filesystem, no network, no `fetch`. Caps arrive as arguments.
2. **No clock, no randomness.** `requestedAt` is stamped by the caller. `ts` is
   display-only; the fold never reads it.
3. **No imports outside this directory.** No `node:fs`, no `node:path`, nothing
   under `server/runner/`.

P8-D I/O siblings (`config.js`, `journal.js`, `prompts.js`, `effector-runner.js`)
and P8-E (`delivery.js`) are excluded from that guard. They must not be imported
by the graph core.

**No LLM call.** `plan()`, `derive()`, and the policy table are the control
plane. A model call here would break replay, which is the recovery mechanism.

## Role

Every attempt the engine starts has role `'sub-agent'`. The type name
(`explore`, `researcher`, …) lives on the run record from `run.requested` and
is what the per-type cap keys on. `isAgentRole` is `role === 'sub-agent'`.

## Caps

Two, from `sub-agents.json` **values**, never from reading the file:

- `globalMaxConcurrent` default **3**
- per-type `maxConcurrent` default **2**

They gate **starting**, not continuing. Lowering a cap mid-run does not kill
in-flight work. The invariant is: *no tick starts work that would push
in-flight attempts above the global cap OR the per-type cap.*

## What is not here

The V1 watchdog is not replaced by anything in the fold. Heartbeats, stall
timers, and tier-1 recovery go away with P8-G. Liveness is `inspect()` versus
the journal; a vanished attempt is `crashed` on the next tick, the same way
boards reap.

`result.delivered` is declared and folded so pending vs delivered is derivable.
P8-E (`delivery.js`) appends it **after** the parent resume is known delivered.
`run.nudged` is the once-per-run check-in, recorded the same way. Both survive
a renderer reload and a server restart because they live on the journal, not in
a process-lifetime Set (MIN-639 / MIN-758).

## Effector (P8-D)

[`effector-runner.js`](./effector-runner.js) is the board runner's sibling:
`inspect` / `start` / `stop` / `onEnd`. `start()` resolves once the attempt is
in the live map (that licenses `attempt.started`). Caps stay `plan()` arguments;
the effector does not re-implement them.

`sub-agents.json` is read here (`config.js` — shipped JSON + `~/.minnow/sub-agents.json`),
never from renderer TS. Mapping onto `runTurn()`:

| config | `runTurn()` |
| -- | -- |
| per-type allow/deny | `tools` (resolved once per type) |
| `summarySchema` | `parseReport` |
| type prompt | `systemPrompt` |
| `maxInputTokens` / context policy | context-budget deps |
| `sampler` / `thinkingMode` | `TurnModel` |

`cwd` is the spawning chat's workspace, journaled on `run.requested`, required
(no silent workspace-root default, no worktree). There is no configured
wall-clock cap; a `timeout` exit (a `maxTurns` hit, or an explicit
`options.limits.wallClockMs`) is routed through P8-C policy (retry with continue
seed + transcript), not a cancel.

Lossy attempt transcripts land next to the journal (`attempts/*.jsonl`, same
P9-D recorder as boards). High-frequency `delta` / `stream_meta` stay off disk.
`runTurn` `no_report` with real assistant prose is a degraded pass here
(`degradeNoReportIfProse`) — boards stay on `report_outcome`; the runner has
no `isSubAgent` branch.

**`ask_question` (MIN-724).** Unattended/headless: `ask: null`, same as boards,
so the tool is stripped. Do not add an `isBoard` / `isSubAgent` branch inside
`server/runner/`. A parent-injected `AskCapability` later is an options argument
on this effector, default `null`.

Tokens ride `live-events.js` (opaque key = parent chat id) and are never journaled.
Orphan cancel (`cancelOrphanedSubAgentGenerations`) only touches `sa-` chat ids so
it cannot steal a live board attempt.

## Delivery (P8-E)

[`delivery.js`](./delivery.js) owns the parent-completion queue. Pending = a
terminal run with no `result.delivered`; delivered = a run that has one;
nudged = a run with `run.nudged`. All three are a fold — MIN-639's "drop only
once known delivered" survives renderer reload and server restart.

`result.delivered` / `run.nudged` are appended **after** `deliverToParent`
resolves. A crash between inject and append re-delivers (safe extra); a crash
after append does not. The reverse ordering silently drops results.

An undeliverable parent (chat deleted, or orchestrate) still reaches a terminal
journal state (`result.delivered` with `skipReason`) so the fold stops offering.
`buildSubAgentParentResumeMessage` copy is unchanged; inject `buildMessage` to
use it. This module is I/O and is not imported by derive / plan / policy.

## HTTP + runtime (P8-F / MIN-759)

[`middleware.js`](./middleware.js) is `/api/agents/*`, the same shape as
`/api/boards/*`: a `ROUTES` table and `MUTATING_ROUTES` (`spawn` | `cancel`).
Spawn and cancel are POSTs; everything else is a read. The renderer is a view
of derived state — it never writes a run except by POSTing a command.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/agents` | spawn (preflight *before* 201 — unresolvable model is 400) |
| GET | `/api/agents?parentChatId=` | derived state for one chat |
| GET | `/api/agents/:runId` | one run |
| GET | `/api/agents/:runId/events` | SSE: journal frames with `seq`, plus `event: live` / `error` / `deliver` (no `seq`) |
| GET | `/api/agents/:runId/journal` | raw parent journal (debug) |
| GET | `/api/agents/:runId/transcript` | lossy attempt transcript (P9-D JSONL; latest attempt, or `?attemptId=`) |
| POST | `/api/agents/:runId/cancel` | cancel |

Live tokens ride `live-events.js` (opaque key = parent chat id) and are never
journaled. Failures after 200 go out as `event: error` — a consecutive
counter, not one toast per tick.

[`runtime.js`](./runtime.js) is the production delivery host: disk journal,
`deliverToParent` = `emitDeliver` (throws `'no delivery listener'` when the
count is 0 so the fold stays pending), `bootAgentsRuntime()` → `tickAll()`.
That miss is idle, not a failure: no warn, no 5s retry. Connecting
`GET /api/agents/:runId/events` subscribes then ticks so a pending completion
can land.
