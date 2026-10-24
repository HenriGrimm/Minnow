# 03. Issues, Dashboard and planning review

Date: 2026-10-23. Baseline: ba2068d1c5353f86287f9a02b665fb7ea0bbac3f. Read-only source and scoped-test review.

## Assessment

These surfaces contain a credible chat-driven delivery experience: capture a goal, propose issues, group related work, launch real chats in isolated checkouts, review, and land changes. The strongest recent implementation uses the shared transcript/composer and preserves work after interruption. The weakest point is continuity between competing task models. Dashboard groups, ordinary issue chats, V1-style agent slots and V2 boards do not consistently share ownership or completion state. A user who delegates through conversation can therefore receive a useful result in one surface while another surface remains queued or working.

This is a bounded review, not a claim of complete visual or platform validation. Impeccable's product UI principles informed the workflow assessment; no design score or live visual critique was performed.

## Scope and coverage

Sampled in depth: `src/home/{flow-actions,flow-model,flow-dock,work-changes,plan-goal}.ts`; `src/ui/{home-page,issues-page,issues-detail,issues-work-panel,orchestrate-launch}.ts`; `src/chat/issues/{pipeline,agent-dispatch,agent-watch,workflow-seeds,git-actions,git-helpers,chat-review,board-review}.ts`; `src/issues/work-state.ts`; the agent-run portions of `src/state/issues-store.ts`; relevant git/worktree/client and board integration code.

Read the review brief, supplied AGENTS guidance, architecture context, PRODUCT.md and DESIGN.md. User-confirmed chat-first direction takes precedence over older editor-centric framing.

Boundaries not exhaustively reviewed: issue GitHub synchronization/import conflict engine; taxonomy/saved-view persistence; every issue editor interaction; mobile surfaces; real model execution; live multiwindow browser behavior. Those boundaries should not be inferred green from these findings.

## Good

- **The Dashboard executes actual shared chats.** Background chats keep a stable group key, attach an isolated checkout, prepare dependencies and send through `sendProgrammaticChatText` (`src/home/flow-actions.ts:125`, `:135`, `:152`). This gives delegation useful continuity with Code.
- **Planning has an explicit approval boundary.** `approveHomePlan` rereads the saved plan type, continues Build plans in the same chat and hands Orchestrate plans to a board; it preserves the planning batch on creation failure (`src/home/flow-actions.ts:230`). The saved artifact determines execution rather than stale UI assumptions.
- **Human review is built into ordinary issue work.** Issues Work sends source/destination SHAs and a content fingerprint, prevents delivery while another chat uses the same checkout, records merge history, and retains the chat (`src/ui/issues-work-panel.ts:60`, `:85`, `:124`, `:146`). Relevant UI and real-git tests passed.
- **Recovery generally preserves the user's progress.** Reload reconciliation pauses interrupted Dashboard chats and turns interrupted merges into an explicit attention state (`src/home/flow-actions.ts:187`). Grouping and blockers are deterministic, and failed/retried work keeps its checkout.
- **Embedded conversation is becoming consistent.** Dashboard and Issues borrow `mountSharedChatHost`; tests verified composer ownership, transcript disclosures and backfill. This is especially valuable when chat is the main workspace.

## Findings

### 03-01 [P1] Keyboard dispatch can overwrite the ownership of an already running issue

**Evidence:** `src/ui/issues-page.ts:2713` only special-cases awaiting-input, then calls `queueIssueAgent` at `:2722` before the dispatch guard. `src/state/issues-store.ts:2269` replaces the entire `agent` object with a new queued slot. `src/chat/issues/agent-dispatch.ts:100` subsequently checks for running/awaiting-input, but the previous running phase and its chat/worktree/home linkage have already been erased.

**Trigger:** focus an issue with a running Dashboard/issue agent and press Shift+A (registered at `src/ui/issues-page.ts:2839`), or invoke the same queue-agent command.

**Impact:** the original work can keep running while its issue loses the ownership information needed to supervise it. A second launch may proceed if a plan already exists; otherwise the failed launch leaves the replacement queued slot behind.

**Confidence:** high, directly reachable source path; live-running-agent UI reproduction was not performed.

**Repair:** atomically validate eligibility before any mutation. Reuse one admission function across keyboard, palette and workflow buttons; preserve existing run metadata on every rejected/failed start.

### 03-02 [P2] The same dispatch shortcut cannot create a missing plan

**Evidence:** `src/chat/issues/agent-dispatch.ts:85` invokes `executeTool('write_file', ...)`. The shipped file tool is `save_file` (`server/tools/builtin-catalog.js:521`), and `src/tools/client.ts:556` rejects unknown function names. `write_file` is absent from the shipped catalog. The plan-creation error returns before the function's later catch/failure update (`agent-dispatch.ts:106`).

**Trigger:** Shift+A on a normal issue with no planPath.

**Impact:** dispatch returns an unknown-tool error while the UI's prewritten agent slot remains queued. Existing tests cover the generated plan text and slot helpers, not this actual dispatch seam.

**Confidence:** high, explicit catalog/caller mismatch.

**Repair:** route this entry point through the supported, workspace-scoped plan-save and V2 dispatch path. On failure restore the original state or publish a failed state with a retry action.

### 03-03 [P1] Board handoff does not close the loop back to its originating issues

**Evidence:** Dashboard approval stores `home.boardId` and sets the agent queued/issue in-progress (`src/home/flow-actions.ts:255`). Both its chat activity subscriber (`:64`) and reload reconciler (`:193`) explicitly skip board-owned issues. Repository search found no other consumer that reconciles `home.boardId` to board state. The older watcher is a no-op (`src/chat/issues/agent-watch.ts:174`); the legacy completion helper is exported/tested but has no production caller. Ordinary Issues Send-to-board discards the returned board ID (`src/chat/issues/pipeline.ts:333`). The keyboard route likewise starts an unlinked agent slot even if launch returned null (`src/chat/issues/agent-dispatch.ts:118`).

**Trigger:** approve an Orchestrate plan in Dashboard, or send an issue plan to a V2 board, then let the board finish/fail.

**Impact:** the board can reach a terminal result while the originating issue remains in-progress/queued. Dashboard correctly offers Open orchestrator board, but cannot serve as a trustworthy attention queue; blockers tied to the issue may remain held until manually updated.

**Confidence:** high for missing source reconciliation; full real-model end-to-end execution was not run. Existing approval tests validate handoff and intentionally preserve in-progress after planning-chat completion, not board terminal reconciliation.

**Repair:** persist a first-class issue↔V2-board association and derive attention/review state from board journals, including refresh/restart reconciliation. Keep board verification complete, ready for human review and actually landed as separate states.

### 03-04 [P1] Issue Git actions can mutate the wrong project

**Evidence:** detail actions pass the selected issue to `createBranchFromIssue`/`createPrFromIssue` without activating or pinning its workspace (`src/ui/issues-detail.ts:1812`). Branch checkout calls omit cwd (`src/chat/issues/git-actions.ts:56`, `:59`), as do push and PR creation (`:167`, `:177`). Git transport defaults missing cwd to the current request workspace (`server/git/middleware.js:84`); Issues supports an all-workspaces scope (`src/ui/issues-page.ts:201`).

**Trigger:** while project A is active, open an issue from project B through all-workspaces Issues and choose Create branch/Create pull request. A workspace change during the async multi-step operation can produce the same problem.

**Impact:** branch creation/checkout and potentially push/PR happen in A, while branch/PR links are appended to B's issue. This breaks the shared-workspace promise and is particularly hard for a chat-first user to diagnose.

**Confidence:** high, missing explicit scope across a reachable cross-workspace UI.

**Repair:** capture `issue.workspacePath` once, pass it through every git/tool/PR operation, validate the repository identity, and preserve that scope through retries. Prefer the issue's actual linked worktree/branch when opening a PR.

### 03-05 [P2] Planning status is committed before a chat has started

**Evidence:** `runIssuePlanChat` writes planned and planPath before its launch try (`src/chat/issues/pipeline.ts:217`); error returns at `:230`/`:234` do not restore status. Non-plan foreground dispatch similarly writes in-progress before launch (`:273`). Board dispatch also sets in-progress after a null launch (`:335`).

**Trigger:** no runnable model, chat launch/worktree setup failure, rejected admission, or board creation failure.

**Impact:** failed attempts can leave issues looking planned/in-progress even though no usable plan/run exists. Later actions can be enabled by a path field whose file was never successfully saved.

**Confidence:** high for ordering and failure paths; individual runtime failure causes were not all induced.

**Repair:** use a launching state or pending intent; publish planned only when a plan artifact exists, and in-progress after durable run admission. Preserve any prior valid status on failure.

### 03-06 [D] The review experience asks users to infer correctness from conversations and code

**Evidence:** the Work panel explicitly states that turn completion does not certify tests (`src/ui/issues-work-panel.ts:216`), then presents file counts and an expanded diff. Dashboard's primary progresses from Review changes to Merge when it has a clean snapshot (`src/home/flow-dock.ts:116`), and its ready caption says ready to merge (`:206`). It has no common structured acceptance/result panel.

**Impact:** a non-code expert gets enough information to inspect implementation but little help deciding whether the requested outcome actually works. A completed model turn is easy to read as a completed task despite the warning.

**Confidence:** high as a product assessment from source; no claim that every completed chat is wrong or untested.

**Proposal:** give every delegated outcome a plain-language result card: requested behavior, demonstrated behavior, verification actually run, failures/unknowns, preview/evidence links, and reversible next action. Keep diffs as supporting detail. Offer Request changes with the same task context.

## Prioritized improvements

1. **Repair admission and scope first:** fix 03-01/02/04; add regression coverage at the actual keyboard→dispatch and all-workspaces→Git seams.
2. **Repair lifecycle continuity:** 03-03/05; use durable IDs and reconciliation rather than additional presentation flags.
3. **Unify the product task model:** retain separate execution engines where justified, but make Code chat, Dashboard group and board views refer to one user-facing assignment/result. Users should not have to select an engine to understand ownership.
4. **Improve outcome validation:** add structured acceptance evidence and preview-first review. Separate finished responding, verification passed, ready for review and landed.
5. **Simplify startup prerequisites:** Dashboard requires a local main/master branch (`src/ui/home-page.ts:276`) and sends users to Source Control on failure (`:103`). Allow selecting/configuring the base inline with a plain explanation. This is a product proposal, not a verified data-loss bug.

## Checks actually run

All processes used task-specific temporary MINNOW_HOME values; real Git tests created disposable repositories. No live profile or credentials were read, no external git operations were performed, and no application sources were edited.

- `test/issues/agent-workflow.test.mts`, `test/chat/issues-pipeline.test.mts`, `test/ui/issues-workspace.test.mts`, `test/ui/scc-changes-refresh.test.mts`, `test/ui/scc-pulls.test.mts`: 56 tests passed in the initial mixed batch.
- `test/os/home-flow-actions.test.mts`, `test/os/home-plan-approval.test.mts`, `test/os/home-review.test.mts`, `test/ui/pr-review-panel.test.mts`, `test/chat/pr-review-target.test.mts`: 20 tests passed.
- Source-path tracing and repository searches verified current callers, board ownership consumers, tool names and git scope.
- No live application/model/visual test. Passing helper tests do not disprove the missing integration paths above.

## Cross-vertical dependencies and open decisions

The orchestration/git report covers merge approval integrity and PR review identity. Chat lifecycle owns admission/completion events; model selection owns startup failure recovery; project/window routing owns immutable workspace identity. Agree on when issues reach Review versus Done and whether a board may auto-land changes before implementing a universal task/result model. Reef is outside this section; its potential separation should not multiply the main development task model further.

