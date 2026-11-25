---
planType: build
---

# Factory skill — PRD

**Status:** Approved for build · **Date:** 2026-11-24 · **Replaces:** Orchestrate boards (`server/orchestrator/` board graph, the board UI, Orchestrate mode) and the `orchestrate-plan` skill

## 1. Problem

Orchestrate boards were meant to be a fully autonomous software factory: start a plan once, come back to working software. They work, but slowly and expensively. On the running Coltiva board (98 tasks, Nov 23–24 2026) 17 tasks merged in about 15 hours, from 118 agent attempts. The first build and first test of each task account for 38 attempts and 74M tokens. Everything else — 80 attempts, 110M tokens — was rework.

The rework has four causes, all structural:

1. **Every rebase re-runs a full LLM tester.** The merge queue merges only the exact SHA a tester passed, so any merge ahead of a task invalidates its verdict. 15 tester runs (24M tokens) were post-rebase re-tests; W1-Q alone re-tested 7 times at 5–8M tokens each.
2. **Fresh-context testers never converge.** Each tester starts from scratch with no memory of earlier verdicts and no fixed contract, so each round finds a new edge case. About three quarters of 32 tester fails began "the Test spec passed, but…". W2-I ran 9 fail/fix rounds.
3. **Spec contradictions loop until the budget runs out.** W2-K's Build asked for backend work its Touches forbade; builder and tester alternated "missing" / "out of scope" until the repair budget ran out.
4. **Predictable integration failures are found by LLMs.** Five post-rebase fails were "two Alembic heads" — a one-second shell check.

Parallel per-task worktrees are the root of 1 and 4, and the builder/tester split is the root of 2 and 3.

## 2. What the research says

Full report: `reports/Autonomous software factory design.md` (research notes in `research_notes/Autonomous software factory design/`).

- Systems that reach working software unattended **fix "done" before code exists**: Factory Missions writes a validation contract first and converged in 2–4 validation rounds per milestone; Anthropic's harness keeps a feature list whose only writable field is `passes`, and dropped per-sprint evaluation for a single end-of-run pass once models improved.
- **One writer.** Cognition keeps code-writing single-threaded; Anthropic's long-running harness does one feature at a time; the Ralph loop works one item per iteration. A 2026 controlled study found only 1 of 6 multi-agent workflows beat a single agent.
- **LLM review is low-precision** (usually under 10%) and unstable across reruns, so a review must judge against a frozen contract and may only block on something it can cite.
- **Repair rounds flatten after 2**; after that, change the input (re-scope, split, amend the spec) rather than retry.
- **Agents edit tests they can see** (over 79% of Claude-family cheating on ImpossibleBench was test edits), so acceptance checks must be guarded.
- **Stalls need an owner.** Magentic-One replans after more than 2 stalls; giving one role final authority raised ChatDev success by 9.4% in MAST.

## 3. Product contract

`/factory <plan or goal>` in a Code chat. The user starts it once and comes back to working software on a branch. The factory **never asks the user**: every ambiguity, contradiction or dead end is resolved by the lead and written to a decision log.

## 4. Goals / non-goals

**Goals**

- One chat, one branch, one writer at a time. No per-task worktrees, no merge queue, no board.
- "Done" is decided by frozen, executable checks plus deterministic gates — not by an agent saying so.
- Bounded repair: at most 2 attempts per feature before the lead re-scopes it.
- The run survives the chat ending a turn: it continues until every feature passes or the run's budget is spent.
- Plans written by `plan-work` (Build format) are valid input; so is a plain goal.

**Non-goals**

- Parallel writers. Read-only sub-agents (explore, review) may run in parallel; writers never do.
- A dedicated UI. The chat transcript, `factory/progress.json` and git history are the view.
- Ongoing issue/PR maintenance — that is the Maintenance factory ([maintenance-factory.md](maintenance-factory.md)).

## 5. Design

### 5.1 Run folder

The lead creates `factory/` at the repo root of the run branch. Everything the run knows lives here, so a fresh context (compaction, restart, `/followup`) resumes from files, not memory.

| File | Owner | Purpose |
|---|---|---|
| `factory/spec.md` | lead | The hardened spec: goal, scope, out of scope, locked decisions. |
| `factory/decisions.md` | lead | Append-only log of every assumption, contradiction resolved, scope change and dropped item, with the reason. Replaces asking the user. |
| `factory/progress.json` | lead (structure), builders (`passes` only) | Ordered feature list: `id`, `title`, `acceptance`, `checks`, `passes`, `attempts`, `notes`. |
| `factory/checks/` | lead | Executable acceptance checks per feature. Written before the feature is built and confirmed to fail first. Builders may not edit them. |
| `factory/factory.json` | lead | Repo gates (fast deterministic commands, e.g. typecheck, unit tests, `alembic heads` = 1), the full check command, and hot files. Inherited later by the Maintenance factory. |

### 5.2 Phases

1. **Branch.** If the chat is on the default branch, create `factory/<slug>` (the chat's own worktree when the user enabled one). The user's main checkout is never written.
2. **Harden the spec.** Read the plan or goal and the repo. Resolve contradictions now (Build vs scope, "every/any" acceptance claims, steps without a checkable outcome). Write `spec.md`, `decisions.md`, `factory.json`.
3. **Write the contract.** Turn each feature's acceptance into checks under `factory/checks/`, using the project's own test runner where possible. Run them; each must fail (or be marked `preSatisfied` with a reason when the behaviour already exists). Commit: `factory: contract`.
4. **Build loop** — one feature at a time, in `progress.json` order:
   - Delegate the feature to one writer sub-agent in the shared checkout (fresh context, `wait: true`). It implements, runs the feature's checks and the gates itself until green, and reports.
   - The lead re-runs the checks and gates (the builder's runs do not count) and confirms `git diff` shows no change under `factory/checks/`.
   - Green: set `passes: true`, commit `factory: <id> <title>`.
   - Red: one more attempt with the failure output. Still red: **re-scope** (split, amend acceptance, move to a later feature, or drop with a reason), log it in `decisions.md`, reset to the last green commit if the tree is broken.
   - Oscillation (an attempt undoes the previous one's change, or two attempts fail the same check) skips straight to re-scope.
5. **Review checkpoint** — after every 5 features and at the end: one clean-context reviewer sub-agent reads the diff since the last checkpoint against `spec.md`. A finding blocks only if it cites a failing check or a spec line; blocking findings become new features (with checks) in `progress.json`. Everything else goes to the run report's follow-ups.
6. **Finish.** Run every check and the full check command on the final tree; for UI work, an end-to-end browser pass against the acceptance list. Fix failures as new features. Write `factory/REPORT.md`: what shipped, decisions, deviations, follow-ups. Commit.

### 5.3 Continuation

Invoking `/factory` arms the chat's `/goal` with a fixed condition: every feature in `factory/progress.json` has `passes: true`, the gates in `factory/factory.json` pass on the final tree, and `factory/REPORT.md` exists. The goal evaluator continues the chat until that holds. Skills declare this with a new `goal:` front-matter field that arms the goal when the skill is invoked from the composer and the chat has no goal, loop or follow-up chain.

### 5.4 Rules the lead follows

- Never ask the user. Decide, log the decision, continue.
- Never edit a check to make it pass. A wrong check is a spec decision: amend it in a separate commit with a `decisions.md` entry.
- One writer at a time. Read-only sub-agents only for exploration and review.
- Prefer the cheapest oracle: a shell command over an agent, an agent over the user.

## 6. What gets deleted (board sunset)

- Renderer: `src/orchestrator/`, the Orchestrate page/hub/launch/plan screens and board chat UI (`src/ui/orchestrate-*`, `exit-board-view.ts`, `code-views-orchestrate-button.ts`), the mobile board views, board CSS, Orchestrate mode in the mode selector.
- Server: the board graph (`server/orchestrator/` except modules the sub-agent graph imports), `/api/boards/*`, board CLI scripts, board scenario contract, GitHub Watch's board flow.
- Skills: `orchestrate-plan` (replaced by `factory`); `plan-work` drops the Orchestrate format and offers Build or Factory.
- Data: existing `~/.minnow/boards/` is left on disk and in the backup catalog; nothing reads it.

Sub-agents keep the shared engine (`createEngine`, journal store, runner effector, failure normalization) they already use.

## 7. Phasing

| Phase | Scope | Done when |
|---|---|---|
| 1 | `src/skills/factory/` (SKILL.md + templates), `goal:` front matter, `plan-work` update | `/factory` arms a goal and the skill text passes the skill suites |
| 2 | Board sunset | No board UI, routes or graph; `npx tsc --noEmit` and `npm test` show no new failures |
| 3 | Server-side goal continuation | Implemented for managed Code chats. Startup recovery resumes the persisted command cursor and verifies the committed feature checkpoint. |

## 8. Risks

- **Serial is slower.** One writer trades wall-clock for zero integration rework. Measure on a Coltiva-sized plan before adding parallelism back.
- **Check quality is the ceiling.** Weak checks pass weak code; the review checkpoint and end-to-end pass are the backstop.
- **Model drift.** Termination is enforced by the goal condition and the 2-attempt rule, not by the model deciding it is done.
- **Interrupted effects.** The server resumes after restart once the existing tool recovery journal confirms what happened. An ambiguous effect remains visible for human review.
