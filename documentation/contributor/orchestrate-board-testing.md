# Orchestrator V2 board testing

How to run, debug, and extend tests for live boards. Product context: [Orchestrate boards in `context.md`](../context.md#orchestrate-boards).

V1's `test/orchestrate/` suite (~17k lines) was retired in MIN-716. Behaviour that a user would notice lives under `test/orchestrator/` against the journal and pure core. Workaround tests (fixers, stalls, send-gate, quarantine hooks) were deleted with the code they described.

## Layers

| Layer | When to use | Command |
|-------|----------------|---------|
| **V2 suite** | CI, regressions, every PR | `npm run test:orchestrator` (alias: `npm run test:board`) |
| **Scenario contract** | PR gate — catalog + adapters | `npm run board:scenario-contract` |
| **Manual UI + fake model** | Click through without a live LLM | Settings → Advanced → Board testing (`MINNOW_DEBUG=1`) |

Nightly CI re-runs the orchestrator suite ([`board-nightly.yml`](../../.github/workflows/board-nightly.yml)). Release CI re-runs the catalog contract ([`board-release.yml`](../../.github/workflows/board-release.yml)). Crash recovery (P1-G) and scheduler conformance (P1-F) are in `test/orchestrator/` and already run on every PR.

```text
                    npm run test:orchestrator
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
  Pure core tables    Engine + journal    Real runner e2e
  (derive, plan,      (recovery,          (P2-G / P3-E fake
   policy, parsePlan)  report, worktrees)   host + worktrees)
                           │
                           ▼
              npm run board:scenario-contract
              (Settings catalog still used by board-testing)
```

## Quick start

```bash
npm run test:orchestrator
npx tsc --noEmit
```

One file:

```bash
node --test --test-force-exit test/orchestrator/derive.test.mjs
```

TS UI tests still need the loader:

```bash
node --import tsx --import ./test/test-loader.mjs --test test/ui/orchestrator-boards-kanban.test.mts
```

## What replaced the V1 keepers

| V1 file | V2 home |
|---------|---------|
| `board-append-tasks` | `derive.test.mjs` (`task.added`) + engine final-test append |
| `task-build-retry` / `task-recovery` | `policy.test.mjs`, `report-wiring.test.mjs`, `recovery.test.mjs` |
| `worktree-isolation` / `worktree-release` | `worktree-lifecycle.test.mjs` |
| `board-report` / `finish-report` | `report.test.mjs`, `report-tool.test.mjs` |
| `board-drag-drop` | derived columns in `test/ui/orchestrator-boards-kanban.test.mts` (no DnD writes) |
| `list-plans` | `test/chat/plans/list-plans.test.mts` + `test/chat/orchestrate/plan-path.test.mts` |
| `plan-complete` | `state.finished` in derive / engine / e2e |
| `board-timer` | retired — V2 has no header elapsed timer |
| `stats-aggregate` | `test/orchestrator/stats-aggregate.test.mjs` (`server/runner/stats-math.js`) |

## Fake model

[`scripts/fake-model-server.mjs`](../../scripts/fake-model-server.mjs) — OpenAI-v1 stub. Default V2 scenario emits `report_outcome`.

```bash
npm run fake-model -- --register
```

P2-G / P3-E e2e use the in-process host from [`server/orchestrate/board-testing/fake-model-host.js`](../../server/orchestrate/board-testing/fake-model-host.js).

## Settings → Board testing

Enabled when `MINNOW_DEBUG=1` at build time ([`src/ui/settings-board-testing.ts`](../../src/ui/settings-board-testing.ts)). HTTP API when `MINNOW_DEBUG=1` or `MINNOW_TEST=1`.

- Catalog + runner: `GET/POST /api/orchestrate/board-testing/runs/*`
- In-process fake model: `POST /api/orchestrate/board-testing/fake-model/*`
- **Seed board** (`POST /api/orchestrate/board-testing/seed`) is **410** — V1 session seed is gone. Create a board with `POST /api/boards`.
- The old **Check log** endpoint (`POST /api/orchestrate/board-testing/check-log`) is **410** — V1 JSONL invariants were deleted in MIN-713. History is the journal under `~/.minnow/boards/`. JSONL **tail** still works.

Catalog and adapters: [`src/dev/orchestrate-scenarios/`](../../src/dev/orchestrate-scenarios/). Unit tests: [`test/dev/`](../../test/dev/). Server tests: [`test/server/orchestrate-board-testing.test.mjs`](../../test/server/orchestrate-board-testing.test.mjs), [`test/server/orchestrate-scenario-runner.test.mjs`](../../test/server/orchestrate-scenario-runner.test.mjs).

`board:scenario-contract` is the PR gate that the catalog still validates.

## Creating a V2 test board

```bash
# with the tool server up
curl -H "X-Minnow-Token: $(cat ~/.minnow/session-token)" \
  -H "Content-Type: application/json" \
  -d "{\"planPath\":\"documentation/plans/demo.md\",\"markdown\":\"...\"}" \
  http://localhost:9473/api/boards
```

Or use the Boards create form at `#/app/code/boards`.
