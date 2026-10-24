# 04. Orchestration, git and delivery review

Date: 2026-10-23. Baseline: ba2068d1c5353f86287f9a02b665fb7ea0bbac3f. Read-only source and scoped-test review.

## Assessment

The orchestration foundation is stronger than its cross-surface integration. Deterministic journal folds, isolated task worktrees, recoverable checkpoints, merge verification and acknowledged sub-agent delivery address real failure modes. Source Control also has thoughtful async-state guards. These should be preserved.

The key trust gap is inconsistent review identity. Issues Work checks the exact reviewed contents, boards bind verification to commits, but Dashboard approval and PR merging do not carry equivalent identity checks. Chat-driven building makes this more important: the user needs the app to bind approval to the evidence shown, not rely on remembering branch state.

## Scope and boundaries

Read/sampled: `server/orchestrator/{engine,board-graph,merge-queue,worktree-lifecycle,final-test,verification-contract,checkpoint}.js`; `server/orchestrator/core/{README,policy,plan,derive}.js` and core documentation; `server/sub-agents/{README,delivery,runtime}.js`; `src/agents/sub-agent-completion-push.ts`; `server/worktree/{middleware,worktree-ops,merge-chat}.js`; `server/git/{issue-work-ops,forge-ops,action-run-lock,middleware}.js`; `src/orchestrator/{boards-view,board-report}.ts`; `src/ui/{scc-pulls,scc-changes,pr-review-panel}.ts`; `src/chat/review/{run-pr-review,pr-review-context,pr-review-target,review-actions}.ts`; related API/store code.

Not exhaustive: every recovery policy/plan edit path, every worktree operation, browser verification driver, Actions/Release engine, stash/history/branch-tree UX, authenticated GitHub Enterprise execution, real CI/provider results, cancellation under every OS/process condition. No live UI visual claims.

## Good

- **Replayable control plane:** the board core forbids I/O, clocks, randomness and imports outside the core; policy is explicit data (`server/orchestrator/core/README.md:1`; `policy.js:40`). Scoped purity, totality and retry-policy tests passed.
- **Commit-aware integration:** the merge queue verifies tester identity, sends rebased content back to testing when the SHA changes, detects already-applied merges after journal interruption and distinguishes operational failures from content conflicts (`server/orchestrator/merge-queue.js:231`). Real-git regression tests passed.
- **Useful recovery rather than silent reset:** checkpoint coverage restored tracked, untracked, binary and staged content without changing the source index. Merge recovery tests covered interrupted MERGE_HEAD and rollback after verification failure.
- **Durable sub-agent handoff:** production delivery requires an acceptance acknowledgement (`server/sub-agents/runtime.js:76`). Parent messages and per-run receipts persist before acknowledgement (`src/agents/sub-agent-completion-push.ts:184`). Tests exercised pending delivery across restart, duplicate suppression and absent listeners.
- **Issues Work has a sound approval contract:** `server/git/issue-work-ops.js:100` compares source/destination SHA, branch and a content fingerprint; it rejects edits since review, unrelated repositories, dirty destinations and unsafe cleanup. Nine real-git cases passed.
- **Source Control preserves interaction state:** request guards prevent stale lists/diffs/PR details overwriting newer choices; refresh preserves typed PR forms and tabs. Targeted UI tests passed.
- **Dashboard merge has real protections:** its temporary merge checkout catches conflicts before touching the target and preserves non-overlapping dirty user files; repeated approvals serialize per repository. These are valuable even though the approval identity gap below remains.

## Findings

### 04-01 [P1] Dashboard merges are not bound to the snapshot the user reviewed

**Evidence:** Dashboard's clean snapshot unlocks approval (`src/home/flow-dock.ts:120`). `approveHomeIssue` queues only the issue state, and `drainHomeMerges` sends chatId, branch and targetBranch (`src/home/flow-actions.ts:282`). Server `merge(root, { chatId, branch, targetBranch })` reads fresh source/target heads at execution time (`server/worktree/merge-chat.js:25`, `:36`). Its changed-target check at `:54` covers only the merge computation window, not the earlier review.

**Trigger:** review source A against target X; either branch advances before approval/while queued; then approve. A clean commit on the source still passes the dirty check.

**Impact:** the app can merge content or an integration combination that the approval screen never showed. It also automatically removes the source worktree after success (`:67`).

**Confidence:** high, explicitly absent request/handler fields. Existing tests validate conflict safety, dirty-file preservation and serialization, not reviewed-snapshot binding.

**Repair:** share the Issues Work approval contract: capture immutable source/target heads, branch identity and fingerprint at inspection; require them server-side and return a review-required state on change. Use compatible mutation locks so other app operations cannot invalidate the check during landing.

### 04-02 [P2] PR review staleness is derived from the first listed commit rather than the actual PR head

**Evidence:** forge detail requests commits but no explicit head OID (`server/git/forge-ops.js:316`); it preserves array order and truncates every SHA to seven characters (`:356`). Review creation stores `pr.commits[0]?.sha` as headSha (`src/chat/review/run-pr-review.ts:51`), and the PR inspector passes that same first-commit value as the current head (`src/ui/scc-pulls.ts:358`).

**Trigger:** a multi-commit PR's commit listing retains its original first entry while later commits are added.

**Impact:** both sides of the comparison remain equal, so a review can continue to appear current despite newer code. Even if a provider changed listing order, the implementation is coupled to list order and lacks the actual head identity.

**Confidence:** high for incorrect identity construction; no authenticated live GitHub request was made. Existing UI fixtures use one commit, so they do not exercise this case.

**Repair:** request and retain full `headRefOid`, bind the fetched diff and review to that SHA, and use it consistently for freshness checks. Add a two-commit review followed by a third-commit regression case.

### 04-03 [P1] Reviewed-PR merge proceeds without enforcing the reviewed head

**Evidence:** `mergeReviewedPr` fetches fresh details but never compares the current head with the review's headSha; it falls back to stored refs even when the fetch fails (`src/chat/review/review-actions.ts:78`). The merge request carries no expected SHA (`:61`). Server builds `gh pr merge <number>` with method/delete/auto only (`server/git/forge-ops.js:416`). The review panel keeps Merge available even when its staleness note reports newer commits (`src/ui/pr-review-panel.ts:143`, `:166`; `src/ui/scc-pulls.ts:484`).

**Trigger:** new commits land after an agent review, or while the confirmation dialogs are open; alternatively the freshness fetch fails but the merge command succeeds.

**Impact:** clicking Merge from a reviewed result may merge a different revision from the one reviewed. A note is insufficient to implement the implied reviewed-merge guarantee.

**Confidence:** high, source contract; no remote mutation was performed.

**Repair:** make freshness lookup failure actionable, carry an expected full head SHA through the client/server merge contract and enforce it with the CLI's head-match guard. A deliberate override can be a separately labelled action with the new revision explicit.

### 04-04 [P2] Review records collide across GitHub hosts with the same owner/repository/PR number

**Evidence:** forge status retains hostname separately and assigns `repo: slug` (`server/git/forge-ops.js:158`). `prReviewKey` uses only trimmed repo and number (`src/chat/review/pr-review-target.ts:5`). Source Control looks up that key using only forgeStatus.repo (`src/ui/scc-pulls.ts:473`); `src/state/pr-review-store.ts:78` persists it in a global map.

**Trigger:** review acme/tool#12 on github.com and the same slug/number on an Enterprise host in the same Minnow profile.

**Impact:** one review overwrites or is displayed as the other's, including findings and issue associations. This is limited to users with matching repositories across hosts, but is a concrete identity defect.

**Confidence:** high, deterministic key construction.

**Repair:** normalize a host-qualified identity such as hostname/owner/repo#number and migrate old records conservatively. Use the same identity across reviews, issue PR references and remote actions.

### 04-05 [D] Delivery engines need a shared human-facing result vocabulary

**Evidence:** board task verification requires check IDs with pass/evidence strings (`server/orchestrator/verification-contract.js:59`); board final testing resolves type/lint/unit/build rungs (`server/orchestrator/final-test.js:185`). Ordinary chats return to review after successful turn completion (`src/chat/issues/chat-review.ts:8`); Dashboard presents ready-to-merge after a clean worktree inspection. Sub-agent prose can be a degraded completion while board reports remain structured, as documented in `server/sub-agents/README.md`.

**Impact:** finished means different things by launch path. The board has more verification machinery, but users should not have to understand that implementation difference to judge an outcome.

**Proposal:** expose requested outcome, checks performed, commit checked, unverified requirements and current landing state in one reusable result view. Preserve the stronger board engine; improve ordinary chat evidence rather than implying equal verification.

## Prioritized improvements

1. Enforce approval identity in Dashboard and PR delivery (04-01/03).
2. Repair actual-head and repository identities (04-02/04).
3. Connect board completion/failure/landing back to issues and Dashboard (report 03).
4. Consolidate duplication at the contracts: one scope identity, one inspection/approval receipt, one task/result association. Separate engines can remain where they serve different work.
5. Add seam-focused scenarios: review→background branch change→approve; failed review refresh→merge; restart after board handoff→terminal issue reconciliation; mixed-host review records. Existing pure-core tests are valuable but do not cover these product contracts.
6. Make non-code review outcome-first, with acceptance demonstrations/preview links and a clear Request changes path before technical diffs.

## Checks actually run

Commands used temporary MINNOW_HOME values; Git suites used disposable repos and local-only operations.

- Node suites: `test/orchestrator/{core-purity,policy,merge-queue,checkpoint}.test.mjs`, `test/sub-agents/delivery.test.mjs`, `test/server/worktree-chat-ops.test.mjs`: **86 passed**.
- Node suites: `test/server/{home-flow-merge,issue-work-ops,forge-ops}.test.mjs`: **28 passed**.
- TS/UI suites shared with report 03: **56 passed** across issue workflow/pipeline/workspace and SCC refresh/pulls.
- Home approval/review + PR panel/identity suites shared with report 03: **20 passed**.
- `test/ui/orchestrator-boards-resume.test.mts`: initially failed at startup because the command omitted `--experimental-test-module-mocks` (`mock.module is not a function`). Reran with the required flag: **5 passed**. This was a test invocation error, not a product failure.
- **195 final passing tests across these selected batches.** No full suite, build, real-provider run, external git operation or live visual session.

## Cross-vertical dependencies and questions

Chat/store persistence and shared run identity must participate in any delivery receipt design. Actions/CI should supply authoritative check results without conflating an agent's report with host execution. Model failures should not corrupt delivery state. Decide which launch paths may land work automatically and which require approval; surface that distinction in ordinary language while retaining the verified commit behind each result.

