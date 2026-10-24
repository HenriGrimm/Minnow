# Chat engine, tools, context and conversation lifecycle

Review date: 2026-10-23 (America/Los_Angeles). Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Read-only product review; only this report and its offline evidence scripts were added.

## Assessment against the agreed product

Minnow has a credible shared execution spine: ordinary chat, delegated agents and headless callers use the same runner rather than independently evolving tool loops. Its transcript preservation, context recovery, provider reasoning handling and review affordances show substantial engineering investment. These are valuable foundations for a product whose main experience is describing a goal and supervising its delivery through conversation.

The most consequential problems in this sample concern **trust in the conversation as an operating surface**. Concurrent chats can read another chat's delegated runs because delegation context is global. Steering can silently discard a request. Queued prompts can reappear after they were already accepted. Undo can hide the fact that file restoration failed. These are more important than adding another control to the composer: a person building through chat needs to trust the target project, instruction history and recovery result without reconstructing them from code.

The central recommendation is to make request identity, per-call context, acceptance and recovery explicit across the chat boundary. Preserve the common runner and the considerable existing test coverage while repairing these contracts.

## Scope and method

Substantial source sampled:

- `server/runner/run-turn.js`, `turn-runner.js`, tool dispatch/batching, context budget and deterministic compaction (`compaction/index.js`, `extract.js`, `format.js`, `project.js`, `recall.js`), plus their documented contracts.
- `src/chat/run-turn-chat.ts`, its transcript decorator and painter, history normalization, failed/stopped recovery, queues/steering, snapshots/Undo, mode registry/policies, outbound attachment construction and presented-file reconstruction.
- `src/state/sessions.ts`, live session synchronization and sub-agent snapshot persistence; `src/agents/orchestrator.ts` and renderer runner dependencies; delegation dispatch/context; shared sub-agent conversation rendering.
- `src/tools/client.ts`, permission resolution/gates/approval queue and plan-write guards on both client and server.
- `src/markdown/renderer.ts`, `links.ts`, transcript turn collection; Build/General/Plan prompts. Goal evaluation and loop pacing were sampled, not comprehensively audited.

Evidence comprises source inspection, offline deterministic reproductions and 290 passing assertions across 22 scoped test files. No real model, live profile, live server or interactive browser was used by this reviewer. No claim is made about every provider or real-world generation quality. Main Code layout, issue/board dispatch, server authorization, connectors, attachments ingestion and provider adapters have separate vertical reviews; this report examines their chat-facing boundaries. Other reviewers' live observations are not presented here as this reviewer's observations.

## Good: preserve these foundations

1. **One execution loop with injected capabilities.** `server/runner/run-turn.js:784` constructs the shared runner; the ordinary chat adapter calls it with report/finalization behavior selected by options (`src/chat/run-turn-chat.ts:1770`). Asking a person is an injected capability, so unattended execution need not emulate UI (`server/runner/run-turn.js:295`). This is a strong foundation for consistency across Code chat and background work.
2. **Transcript persistence preserves actual work and provider details.** Settled rows persist incrementally (`server/runner/run-turn.js:873`), with a final backstop (`:971`). The chat decorator carries thinking, signed provider blocks, timing, images and code-change metadata into saved history (`src/chat/chat-transcript-store.ts:247`, `:309`). Stop/failure paths preserve partial prose and paired tool work (`src/chat/settle-interrupted-turn.ts:180`; `src/chat/history.ts:104`). A provider failure does not have to erase the investigation that preceded it.
3. **Context handling is deterministic, inspectable and recoverable.** Compaction has explicit high/low-water thresholds and keeps recent turns (`server/runner/compaction/index.js:24`), preserves original rows separately, names folded row ranges, and advertises `recall_history` (`server/runner/compaction/format.js:27`). The runner retries measured context overflow (`server/runner/turn-runner.js:1594`) and can reopen automatic compaction when a larger window becomes available. Existing tests exercise reload, stable prefixes, screenshot follow-ups and tool pairing. This is much better than silent destructive history deletion, subject to the semantic-retention limitation below.
4. **Tool batching combines speed with ordering and liveness.** Read batches run concurrently; writes are barriers. Outcomes retain original tool order and every skipped/aborted call receives a result (`server/runner/tool-batch.js:75`, `:193`, `:260`). Hung-call ceilings and an abort grace period prevent one tool from permanently stranding a conversation (`:97`). The scoped tests cover failures, ignored aborts and partial mutating batches.
5. **Transcript rendering has thoughtful safeguards.** Markdown passes through DOMPurify (`src/markdown/renderer.ts:236`, `:312`) and anchor hardening. Streaming reuses committed blocks rather than replacing the entire response. File references become keyboard-accessible links; code/table controls remain reachable. The inspected Markdown suites verify final/streamed equivalence, block identity, heading collisions and caret cleanup.
6. **The shared product state anticipates real concurrency.** Session writes use dirty deltas, revision checks, retained unsaved work and isolated chat conflicts (`src/state/sessions.ts:142`, `:433`, `:2170`). Live refresh protects local drafts and active work (`:1680`). Sub-agent hydration merges historical and newer live frames, guards attempts, and refreshes terminal transcripts (`src/agents/orchestrator.ts:517`, `:527`). These designs and tests are worth extending, not replacing.
7. **Deliverables can be first-class conversation output.** `present_files` cards are reconstructed only from correlated tool results and carry their source workspace (`src/chat/presented-files.ts:12`, `:35`). That moves the experience toward “here is what you made” and helps users who are less interested in reading files or code.

## Bad: evidence-backed findings

### CHAT-01 — P1 verified defect: shared delegation context crosses concurrent chats

**Trigger:** Chat A starts a delegation/status tool while chat B starts any tool, or another chat finishes and clears the global context, before A passes its asynchronous gates.

**Evidence:** The main adapter writes a module-global parent context before calling `executeTool` (`src/chat/run-turn-chat.ts:1788`). The context itself is a single mutable variable (`src/tools/sub-agent-executor-context.ts:3`). `executeToolInner` awaits configuration (`src/tools/client.ts:283`) and permission (`:440`), then calls `executeSubAgentTool` without the per-call context (`:442`). That function reads the global parent (`src/tools/sub-agent-executor.ts:45`, `:88`). Every turn also clears it in teardown (`src/chat/run-turn-chat.ts:2015`).

**Reproduced:** Two actual `executeTool('list_sub_agents', ..., {chatId: A/B})` calls both return B's saved run list. The reproduction skips the modal through the existing test seam but retains the real asynchronous configuration/dispatch path. No application source was mocked. Output: `requestA: ["run-b"], requestB: ["run-b"]`.

**Impact:** Verified cross-chat run-list disclosure and incorrect parent identity. **Source-inferred, not executed:** `spawn_sub_agent` uses the same global lookup and passes its parent into `spawnSubAgent`; that resolves cwd and parent model from that chat (`src/agents/orchestrator.ts:600`, `:614`). A race can therefore associate a task with the wrong chat/project/worktree/model. Losing the context to teardown can produce an error or active-chat fallback. Concurrent chats are explicitly supported by `test/chat/concurrent-streams.test.mts`.

**Confidence:** High for reproduced list crossover; high source confidence for the spawn risk, with a separate integration reproduction recommended before a fix is closed.

**Repair:** Pass immutable parent chat/turn/tool-call/mode/cwd metadata through the existing `ExecuteToolContext` into the sub-agent executor. Remove the mutable global from execution decisions; do not solve this by serializing all chats. Add an interleaving test that pauses A at an await, runs B and/or B's teardown, and asserts A's list/status/spawn cwd/model remain A's.

### CHAT-02 — P1 verified guard defect: Plan file restriction accepts traversal

**Trigger:** A Plan call saves `documentation/plans/../../README.md`, or creates a directory through a similar path.

**Evidence:** Both path guards replace backslashes and perform a case-insensitive string-prefix test; neither removes `..` segments (`src/chat/modes/plan-write-guard.ts:67`; `server/tools/plan-write-guard.js:86`). Both guards return `null` for the traversal example. The server then resolves file paths with `path.resolve(workspaceRoot, userPath)` and accepts destinations anywhere in the workspace (`server/runtime/path-access.js:85`); `save_file` writes that resolved destination (`server/runtime/tools-middleware.js:523`, `:554`). The HTTP layer applies the raw Plan check before execution (`:1734`).

**Reproduced:** Both real guards accept the path; Node's path normalization shows its destination is `README.md`. This reproduction deliberately does not overwrite a file. The source trace establishes the later write behavior.

**Impact:** A malformed/model-generated path can overwrite Markdown outside the promised plans directory. `make_directory` can similarly escape the plans subtree within the allowed filesystem scope. The general workspace guard does not enforce the narrower Plan boundary.

**Confidence:** High. This is a scoped file-guard defect, not a claim that Plan provides an OS security sandbox. Shell/code execution is intentionally available in Plan and its read-only intent is prompt-enforced (`src/chat/prompts/modes/plan.full.md:30`). External dynamic tools are also allowed independently of the built-in mode matrix (`src/chat/modes/tool-policy.ts:4`).

**Repair:** Resolve the candidate against the effective workspace, enforce containment under the actual plans root after normalization, and account for symlink/junction escapes. Share the canonical validation rather than maintaining two subtly divergent guards. Add traversal, mixed-separator, absolute-path, case-sensitive-filesystem and symlink/junction tests. Keep the separate product question about Plan's shell capability explicit.

### CHAT-03 — P2 verified defect: two “Push now” requests silently lose the first

**Trigger:** Queue two instructions and click Push now on both before the current round reaches its boundary. The same loss occurs for repeated direct steering before consumption.

**Evidence:** `pushQueuedMessageNow` removes each queue item before promoting it (`src/chat/message-queue.ts:127`, `:135`). Steering is stored in a single last-write-wins string (`src/chat/steer-message.ts:29`, `:34`). Only that string is inserted into history at the next boundary (`:60`); the first promoted instruction no longer exists in queue or transcript. Existing `test/chat/steer-message.test.mts` explicitly tests “last write wins,” which validates the implementation but does not prevent this user-visible loss.

**Reproduced:** Push “Preserve existing data,” then “Add export support.” Both operations return `sent`; consumption contains only “Add export support”; the first instruction is absent from history and queue.

**Impact:** A builder can lose a safety constraint or scope correction after the UI reported it was steering. There is no recoverable record of the first instruction in the conversation.

**Confidence:** High.

**Repair:** Represent pending steering as ordered entries with stable IDs. Preserve each accepted instruction and consume them at the next boundary, or expose explicit replacement/edit semantics while keeping the replaced text recoverable. Test two Push now actions, direct steer plus Push now, Stop before consumption and reload before consumption.

### CHAT-04 — P2 verified defect: queued prompts are restored after accepted failed turns

**Trigger:** A queued follow-up is sent; its user message is committed, then model execution fails or the user stops the run.

**Evidence:** Queue flushing treats the boolean returned from `resumeParentChatWithMessage` as “accepted” and restores the item on false (`src/chat/message-queue.ts:169`). Idle Push now does the same (`:139`). However, the adapter commits the user row and invokes an existing acceptance callback early (`src/chat/run-turn-chat.ts:854`, `:861`), while its return value is **normal completion** (`:1985`, `:2118`). `resumeParentChatWithMessage` returns that value unchanged (`:2144`).

**Reproduced:** With the real queue and full chat adapter, an injected runner returns `crashed`. The runner was called, the prompt appears in saved in-memory history, and the same prompt is restored to the queue. Output: `userRows: ["Make the change"], queued: ["Make the change"]`.

**Impact:** The same instruction is simultaneously shown as sent and queued. A subsequent successful turn can flush it again, yielding duplicate instructions and potentially repeated non-idempotent work. A stopped queued instruction can also remain scheduled for later replay. The user's existing Continue recovery path should own recovery after acceptance.

**Confidence:** High. Reappearance after a failed accepted turn is reproduced; later repeated mutations are a potential consequence, not observed here.

**Repair:** Use `onUserMessageAccepted` to remove/acknowledge a queue item durably at acceptance, or return a result separating `accepted`, `completed`, `stopped` and `failed`. Restore only when admission failed before acceptance. Sub-agent completion delivery already makes this distinction and has durable receipt tests (`src/agents/sub-agent-completion-push.ts:178`; `test/sub-agents/completion-delivery-integration.test.mts`). Reuse that contract for human follow-ups.

### CHAT-05 — P2 verified defect: Undo hides a failed file restore

**Trigger:** A user approves restoring files for Undo and Git snapshot restoration fails.

**Evidence:** `undoLastAgentTurn` truncates history first (`src/chat/undo-turn.ts:412`), attempts restoration later (`:428`), handles only the successful result (`:432`), then returns `ok: true` (`:439`). The error and safety snapshot from a failed restoration are discarded. Both composer and message actions show the ordinary chat-only success message (`src/ui/composer-undo.ts:138`; `src/ui/message-actions.ts:150`). The existing test “soft-fails restore after chat rewind when git restore errors” verifies this exact behavior (`test/chat/undo-turn-files.test.mts:243`). In contrast, `confirmAndRestoreTurnSnapshot` already exposes restore errors and safety SHAs (`src/chat/undo-turn.ts:339`).

**Impact:** The user chose to rewind files but the conversation rewinds while the files remain changed or the restore reports failure. The UI gives no explanation, retry action or recovery reference. Conversation and filesystem state can diverge silently.

**Confidence:** High; source and passing existing failure-path test agree.

**Repair:** Return an explicit partial-success result with restore error and safety SHA. Keep the reply/branch recovery reachable and show “Conversation undone; files could not be restored” with retry/details. Evaluate whether to restore before truncation or roll back the transcript change after failure. Do not turn a recoverable Git failure into an opaque success.

### CHAT-06 — P3 verified copy/prompt drift: General claims a distinct approval policy

**Evidence:** The registry describes General as requiring approval before each run (`src/chat/modes/registry.ts:18`). Its prompt correctly says Full runs without approval (`src/chat/prompts/modes/general.full.md:21`), but later claims Build and Plan operate “without General's per-call approval gate” (`:37`). Actual permission resolution ignores mode and reads the same catalog permission across modes (`src/tools/permission-resolve.ts:18`).

**Trigger/impact:** Someone chooses General expecting a safer per-call gate, or an agent explains permissions from the conflicting prompt. With Full permissions, General does not provide the promised distinction. This is inaccurate explanatory copy, not evidence that the catalog's actual Full permission is being bypassed.

**Confidence:** High.

**Repair:** Update the registry, prompts and stale context comments together to describe the actual uniform permission policy. Keep mode effects about task behavior and tool availability separate from approval preferences.

## Improvements and product decisions

### First: repair conversation integrity

Prioritize CHAT-01 and CHAT-02; then address steering, queue acceptance and Undo together as one conversation-integrity effort. Give each submitted user instruction an identity and state transition: draft → queued → accepted → consumed; let execution have its own outcome. Record project/worktree/turn ownership on the immutable request. This eliminates the temptation to use one boolean or module-global value for different lifecycle questions.

Preserve the current test seams. Add interleaving and boundary tests instead of another large mock-heavy happy-path suite: simultaneous chats, permission waits, Stop, restart, accepted failure and late completion.

### D1 — Semantic continuity needs stronger protection than a character synopsis

This is a **design risk**, not a demonstrated bad model answer. The compactor intentionally avoids an LLM summary. It saves the first goal's first 900 characters, each later user's first 140 characters, scope changes only when an English regex matches, and standing preferences only when another regex matches (`server/runner/compaction/extract.js:16`, `:28`, `:134`). A detailed later acceptance criterion or a constraint phrased without those words can disappear from active context after folding. Equivalent non-English instructions are particularly unlikely to match. Full originals remain recoverable with `recall_history`, so the information is not deleted, but the model must know it needs to retrieve something absent from its synopsis.

For chat-driven building, maintain a separate explicit task/acceptance/constraints record with provenance to user rows. Let users inspect and correct that record from the conversation. Retain deterministic compaction for tool bulk; benchmark semantic retention on long multi-turn build sessions before adding summarization machinery. Include corrections, decisions near the end of long messages, non-English instructions and model switches. Existing golden summaries establish determinism, not end-to-end requirement retention.

### D2 — Recovery should travel with the recommended execution location

This is an **intentional workflow gap**, not an accidental crash. Worktree chats are explicitly ineligible for Undo (`src/chat/undo-turn.ts:227`) and skip snapshot capture (`src/chat/turn-snapshots.ts:34`). Those are exactly the sessions where an ambitious chat-driven build is likely to run. The product should either offer worktree-scoped checkpoints/Undo or explain the alternative recovery action directly where Undo is disabled. Keep the conversation branch and filesystem checkpoint visibly related. Coordinate with the Source Control/worktree review before choosing implementation.

### D3 — Promote result verification and demonstration in the default chat handoff

The Build prompt's final-report template centers files changed and “READY FOR VERIFICATION” (`src/chat/prompts/modes/build.full.md:54`), while verification can still be “run or suggest tests” (`:44`). Ordinary main-chat `no_report` is treated as completed (`src/chat/run-turn-chat.ts:1985`), which is a sensible transport completion signal but says nothing by itself about a working product outcome. Goal mode has stronger verification gates (`src/chat/goal/evaluate.ts:49`), but it is an extra workflow.

For the agreed product direction, make the default handoff describe what works, offer Open/Preview/Try it where available, state checks actually completed and identify unresolved behavior. Keep file/diff details as supporting disclosures. Do not pretend all tasks need the same mandatory checks; make evidence attached to the result visible. Expand `present_files`' existing successful pattern rather than forcing users into the editor to learn what happened.

### D4 — Reduce accidental lifecycle complexity in the chat adapter

`src/chat/run-turn-chat.ts` is approximately 2,150 lines and imports model loading, worktrees, attachments, titles, prompts, permissions, DOM painting, usage, synthesis, activity, notifications, goals and loops. The runner remains reasonably isolated, but the adapter has become a broad orchestration boundary. The concrete global-context and acceptance defects demonstrate why this matters.

Extract a small typed turn lifecycle with immutable request context, durable acceptance and explicit result states; keep UI subscriptions/painters outside it. Refactor incrementally against the existing tests. A wholesale replacement of the shared engine is not justified by this review.

## Checks actually run

All invocations ran from the repository root. Native/server tests used a task-specific temporary `MINNOW_HOME`; offline evidence scripts stub all network and only use in-memory state. No live Minnow home or credentials were accessed.

1. **144/144 passed:** `node --test test/runner/run-turn.test.mjs test/runner/compaction.test.mjs test/runner/compaction-turn.test.mjs test/runner/tool-batch.test.mjs test/runner/context-overflow-retry.test.mjs test/server/plan-write-guard.test.mjs`.
2. **83/83 passed:** `node --import tsx --import ./test/test-loader.mjs --test-force-exit --test-timeout=45000 --test test/chat/message-queue.test.mts test/chat/steer-message.test.mts test/chat/undo-turn-files.test.mts test/chat/chat-transcript-store.test.mts test/chat/failed-turn-recovery.test.mts test/chat/concurrent-streams.test.mts test/markdown/incremental-renderer.test.mts test/markdown/links.test.mts test/modes/plan-write-guard.test.mts`.
3. **55 assertions passed** across `test/state/session-multi-window.test.mts`, `session-reload.test.mts`, `session-save-backoff.test.mts`, `test/sub-agents/live-frame-isolation.test.mts`, `sub-agent-status-tools.test.mts`, and `test/ui/sub-agent-drawer.test.mts`, with the same tsx/loader/force-exit/time-limit flags. The initial invocation also included completion-delivery integration, which could not start because `mock.module` requires `--experimental-test-module-mocks`. **8/8 passed** when that one file was rerun with the required flag. This was an invocation error, not a product failure.
4. The initial TS/UI invocation without `--test-force-exit` printed passing transcript assertions but remained alive on application timers; it was stopped and rerun with the repository's documented force-exit convention. No result from the incomplete run is counted.
5. **Offline reproductions passed their assertions:**

   ```powershell
   node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/chat-context-and-plan-repro.mts
   node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/chat-queue-failure-repro.mts
   ```

   These intentionally assert the current defective behavior to make the evidence repeatable; they are review evidence, not production regression tests. They demonstrate cross-chat list identity, raw Plan-path acceptance, lost pending steering and accepted-prompt requeue. They do not perform destructive filesystem writes or execute a real delegated build.

No full suite, build, dependency installation, browser test or real-model benchmark was run. Passing existing tests does not refute the newly reproduced defects: some undesired behaviors are expressly encoded by existing tests.

## Cross-vertical dependencies and unresolved questions

- **Workspace/Source Control:** confirm delegation cwd binding and offer recovery for worktree chats; distinguish undoing conversation from undoing files.
- **Permissions/security:** fix canonical Plan paths; decide whether Plan's shell/external-tool capability should remain prompt-constrained and make the promise precise. Address approval-queue rechecks in conjunction with the separate live onboarding review.
- **Models/providers:** preserve measured window/usage semantics and signed reasoning. Semantic-retention checks should cover small local windows and model changes, not only provider transport conformance.
- **Brain/knowledge:** durable build acceptance criteria should have clear ownership; avoid allowing inferred memory to silently override explicit current instructions.
- **Operations/headless:** this report did not determine the full guarantees of surviving a closed renderer during main-chat tool execution. Review actual foreground generation resumption versus server-owned delegated work before promising uninterrupted background building.
- **Product/UX:** decide how default completion communicates verified behavior to a person who never opens the editor. Reef's separate workflow may contain useful patterns, but its product placement is outside this report.
