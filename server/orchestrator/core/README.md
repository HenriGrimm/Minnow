# `server/orchestrator/core` — the pure decision core

Everything Orchestrator V2 decides — what runs next, what a failure means, what a
plan says — lives here as a pure function.

`state = fold(journal)` is the crash-recovery mechanism. It only works if replay
reproduces the same decisions. That is the entire reason this directory has rules.

## The three rules

1. **No I/O.** No filesystem, no network, no processes, no `fetch`.
2. **No clock, no randomness.** No `Date.now()`, no `Math.random()`, no
   `process.hrtime`. Anything that needs the current time takes it as an argument.
3. **No imports outside this directory.** Only relative imports within `core/`.
   `node:` imports are not allowed either — not even `node:assert`.

And, above all: **no LLM call, ever.** If a change would put a model call inside
`derive()`, `plan()`, the policy table, or `parsePlan()`, it is wrong.

These rules are enforced mechanically by `test/orchestrator/core-purity.test.mjs`,
which parses every `.js` in this directory. Adding a violation fails `npm test`.

## Module format: plain `.js` + `.d.ts`, not TypeScript

The server ships and runs as raw JavaScript (`npm start` → `node server.js`);
nothing transpiles `server/**`. The existing TS bridge at
`server/orchestrate/board-testing/ts-import.js` lazily registers `tsx` and is
explicitly dev-only — it cannot work in a packaged Electron app, where `tsx` is
not shipped and asar makes source unreadable to a real node process.

So each module here is authored as `foo.js` with JSDoc types and a hand-written
`foo.d.ts` companion. The renderer imports the `.js` by path and `tsc` picks up
the `.d.ts`, exactly the way `src/ui/terminal-panel.ts` imports
`server/tools/output-cap.js`.

**Do not introduce a build step for `server/**`.**

## Layout

| File | Role |
| ---- | ---- |
| `index.js` | Barrel. The only entry point callers should import. |
| `types.d.ts` | Shared type shapes: `JournalEvent`, `BoardState`, `TaskState`, `Desired`, `Action`, `TaskGraph`, `AttemptResult`. |
| `events.js` | Journal event vocabulary + `validateEvent()`. |
| `derive.js` | `derive(events) -> BoardState`. The only way board state is produced. |
| `plan.js` | `plan(state) -> Desired[]`. The scheduler. |
| `policy.js` | `decide(role, outcome, attemptCount) -> Action`. One table. |
| `evidence.js` | Abandonment bundle + `queryAbandonments(events)`. Pure; diffs are attached by the engine. |
| `parse-plan.js` | `parsePlan(markdown) -> TaskGraph \| ParseError[]`. |
| `plan-dependencies.js` | Check explicit file, export, and npm script references for missing `Depends on` edges before board creation. |
| `rewind.js` | `resetTargets` / `rewindCascade`. Which cards Reset or Rewind wipe. |
| `snapshot.js` | Snapshot format + memoised fold. A snapshot is a cache, never a source. |

## Invariants worth restating

- **Every journal event records a completed side effect, never an intent.** An
  event type ending in `.requested` or `.pending` is a bug.
- **There are no retry counters.** Attempt counts are `events.filter(...)`.
  A counter is a second source of truth and will desynchronise.
- **A snapshot is a cache.** Deleting every snapshot must change nothing but speed.
- **Default start concurrency is 2** (`DEFAULT_BOARD_CONCURRENCY`). The fold
  stays at 1 until the first `board.started` so a created board is not already
  running at N=2.
- **The concurrency cap gates starting, not continuing.** Lowering `N` mid-run
  stops nothing already in flight. So "at no tick do more than `N` attempts
  exist" is false in the product; the invariant is "no tick starts work that
  would push attempts above `N`".
- **A manual start overrides the cap and nothing else.** `manualStart()` still
  enforces dependencies, one-attempt-per-task, and `touches` exclusion, because
  those are correctness constraints rather than throughput preferences. PRD §6's
  Manual mode is a *stopped* board with hand-started attempts — see
  `Attempt.manual`, which `plan()` reads and which a `board.stopped` clears.
