---
planType: build
---

# Maintenance factory — PRD

**Status:** Deferred until the [Factory skill](factory-skill.md) ships · **Date:** 2026-11-24 · **Replaces:** Scheduler GitHub Watch (`server/scheduler/github-watch*.js`)

## 1. Problem

Once an app is built and running, new work arrives as issues. Today GitHub Watch takes one `minnow`-labelled GitHub issue per repository through planning, a full Orchestrate board and a PR. It inherits every board cost (see [factory-skill.md §1](factory-skill.md)), handles one issue at a time, and stops at "needs attention" whenever the board does. With boards sunset, it has no engine at all.

The Maintenance factory is the always-on counterpart to the Factory skill: turn it on for a repository, and every issue moved to **Todo** is built, tested, reviewed and merged without the user.

## 2. Product contract

- The user turns the factory on per repository (Settings or the Issues app). It runs inside the Minnow server on the Scheduler host, including the packaged app.
- **Todo is the queue.** Moving an issue to Todo is the only trigger. The Issues kanban is the factory's view: the issue's status, activity, linked chat, branch and PR show where it is.
- The factory never asks the user. Ambiguity is resolved and recorded as an issue comment; work it cannot do is split, re-scoped or closed with an explanation.
- Output is a merged PR per issue (or a local branch merge for repositories without a GitHub remote).

## 3. Goals / non-goals

**Goals**

- One branch and one PR per issue; one builder session per issue that keeps its context through review fixes.
- "Done" decided by a reproduction test or contract checks written before the fix, plus the repository's gates (`factory/factory.json`, inherited from the Factory skill or written on first run).
- At most 2 review-fix rounds per issue, then re-scope.
- Keep main green: gates on the merged result, and automatic revert plus reopen if main breaks after a merge.

**Non-goals**

- A board, waves, or a plan DAG. Issue hierarchy (parent/child) and blocking links are the only dependencies.
- Per-task worktrees. Worktrees are execution slots (§5.4), not part of the model.
- Replacing human review where a repository requires it; branch protection is respected.

## 4. Lifecycle

| Issue status | Factory stage | What happens |
|---|---|---|
| **Todo** | queued | Claimed in rank order when a slot is free and its blockers are done. |
| **Planned** | spec | One agent turns the issue into acceptance: a failing reproduction test for a bug, contract checks for a feature. Posts its assumptions as a comment. Too big: creates child issues in Todo and parks the parent. |
| **In progress** | build | Builder session on branch `factory/<issue-key>` loops until the issue's checks and the gates pass, commits, pushes, opens a PR linked to the issue. |
| **Review** | verify | Deterministic first: gates and the issue's checks locally, then GitHub CI. Then one clean-context reviewer reads the PR diff; a finding blocks only if it cites a failing check or an acceptance line, otherwise it is a non-blocking PR comment. Blocking findings, CI failures and human review comments return to the **same builder session** (max 2 rounds). |
| — | merge | Rebase onto the default branch, gates on the result, merge. A verdict is reused across rebases unless files the PR touched changed upstream. |
| **Done** | merged | Issue closed with the PR link; slot freed. |
| — | watch | If the default branch fails its gates after a factory merge, find the culprit, revert it, reopen the issue in Todo with the evidence. |

Re-scope, after 2 failed rounds or an oscillation: split into child issues, narrow acceptance (logged on the issue), or move to **Canceled** with an explanation. Never "needs attention".

## 5. Architecture

### 5.1 Reused from the orchestrator

The board is gone, but its engine is sound and the sub-agent graph already proves it is generic:

- `createEngine` + journal store + reconcile loop — the factory is a third graph (after boards and sub-agents): one journal per issue run, folded state, restart is recovery.
- The headless runner effector (`runTurn` in a checkout) for the spec, builder and reviewer turns.
- Worktree lifecycle and checkpoints (exact-byte work preservation).
- Recovery holds and failure normalization (`failure.js`): rate limits, quota, provider outages and missing prerequisites wait and resume without spending the repair budget.
- Merge operations (rebase, merge, receipts) and `server/git/forge-ops.js` (`gh` CLI, never stored tokens).
- GitHub Watch's ledger and idempotent-comment pattern.

### 5.2 Events

`issue.claimed`, `stage.started`, `stage.ended` (`spec` / `build` / `review` / `merge`, with outcome and evidence), `pr.opened`, `review.finding`, `issue.rescoped`, `issue.merged`, `merge.reverted`. Attempt counts are folds over the journal, never stored counters.

### 5.3 Sources

Local Issues are the queue. GitHub issues reach it through the existing GitHub sync (and the `minnow` label importer that replaces GitHub Watch). Status changes flow back through the same sync.

### 5.4 Slots

Concurrency is a per-repository number (default 1). Each slot is one reused worktree that checks out a fresh branch per issue. With one slot, merging is "rebase, gates, merge". With more, the merge step serializes and reuses verdicts as in §4.

### 5.5 Settings

Per repository: on/off, slots, model, merge mode (auto-merge, or open the PR and stop when branch protection requires human review). Budget per issue (tokens) and per day.

## 6. Phasing

| Phase | Scope | Done when |
|---|---|---|
| 1 | Issue graph + spec/build/review stages, one slot, local merge | A Todo issue in a scratch repo reaches Done with a test that failed before the fix |
| 2 | PRs via `gh`, CI and review-comment handling, GitHub label import; delete GitHub Watch | An issue lands as a merged PR on a test repository |
| 3 | Post-merge watch, revert and reopen | A deliberately breaking merge is reverted and the issue reopened |
| 4 | Multiple slots with verdict reuse | Two issues on disjoint files merge without re-review |

## 7. Risks

- **Unattended merges to main.** Mitigated by gates on the merged result, the post-merge watch and auto-revert; repositories can choose PR-and-stop.
- **Low-quality issues.** The spec stage must write a failing check before any fix; an issue it cannot turn into a check is re-scoped, not guessed at.
- **Cost runaway.** Per-issue and per-day budgets; operational failures wait rather than retry.
