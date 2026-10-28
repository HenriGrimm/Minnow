# Codex CLI chat continuity

Status: implemented; validation results are recorded below. The checklist retains the original design for reference.
Date: 2026-10-28.

## Problem and evidence

Recent Codex CLI chats inside Minnow have two interruption paths:

1. Silent interruption: the timeline chat settled as stopped at 08:33:03 America/Los_Angeles, while its native Codex process continued emitting an answer afterward. Other chats stopped within 0.4 seconds of each other at 08:31:47. The ownership client aborts on any renewal failure, including a single network error or five-second request timeout. A diagnostic reproduction confirmed that one failed renewal aborts its signal and is subsequently classified as a user stop. Historical logs do not record renewal failures, so this mechanism is a strong explanation, not proof of the trigger for every historical interruption.
2. Explicit failure: the canvas-resolution chat failed at 00:07 on round 37 with `Codex changed an already streamed item.` The translator throws whenever a completed item is not an extension of the text already streamed. Existing translator coverage explicitly expects revised reasoning to throw. The original divergent native event was not retained in the reviewed capture, so its exact item type and textual difference remain unknown.

The fix must retain one owner of the entire chat/tool loop, accurate saved history, and exactly-once delivery of existing tool results. It must also cover shared consumers such as boards, remote observers and headless runs where the changed contracts apply.

## Intended behavior

- A transient heartbeat failure does not end a chat while its last confirmed lease remains valid.
- An expired or explicitly rejected lease prevents new model requests and tool dispatch. Confirmed ownership loss remains immediate.
- Infrastructure interruption has an actionable persisted reason; only an actual user Stop is described as user Stop.
- Revised or stale reasoning snapshots do not kill an otherwise healthy Codex turn.
- Final prose is reconciled explicitly; conflicting text is never concatenated into a fabricated answer.
- No automatic replay of file edits, shell commands, or completed tool calls occurs during recovery.

## 1. Reproduce the failure contracts

- [ ] Add deterministic tests for a single failed heartbeat followed by success, persistent failure, and an explicit 409 conflict.
- [ ] Add a reproduction of the complete lease-abort-to-settlement path: infrastructure loss must not persist `stopReason: 'user'`.
- [ ] Extend the fake Codex fixture with shorter, revised and duplicate completed snapshots, independently for reasoning and prose.
- [ ] Preserve existing usage/accounting changes in the working tree. Several target files already have unrelated uncommitted changes; inspect and layer edits without resetting them.

Use fake clocks and injected requests rather than wall-clock sleeps or a live account. Do not intentionally interrupt the user's active chats to validate these cases.

## 2. Make ownership renewal resilient within its grant

Primary files: `server/chat-turns/middleware.js`, `src/chat/turn-ownership.ts`.

- [ ] Return an additive lease-duration/remaining-duration grant from successful claim and renew responses. The server remains authoritative; avoid duplicating the 30-second lease constant in the client.
- [ ] Compute a conservative local deadline using a monotonic clock and the request start time. Response latency consumes the grant; it must not extend ownership. A late success must not revive an already terminated client turn.
- [ ] Distinguish successful renewal, explicit conflict (409), temporary transport/5xx failure, and permanent authentication/protocol failure. Never collapse all failures into ownership lost.
- [ ] Keep normal renewal at five seconds. Retry temporary failures with bounded backoff (initially 1, 2, then up to 5 seconds, with jitter), one request in flight, and each request bounded by both the request timeout and remaining confirmed grant.
- [ ] Allow execution during a temporary failure only within the confirmed grant. At its deadline, stop new dispatch even if a retry is pending. After an event-loop stall, check the deadline before dispatching the next model request or tool.
- [ ] Abort immediately on confirmed conflict or permanent authorization failure. Do not automatically claim again after ownership is lost or unconfirmed beyond the grant; normal explicit recovery must reacquire ownership.
- [ ] Make release terminal and idempotent: cancel retry/deadline timers and in-flight renewal, ignore late responses, and avoid renewing or resurrecting a released owner.
- [ ] Preserve the server fence around pending/streaming native generations and the gaps between generations. Do not loosen claim rules or allow a paired device to execute a chat.

Acceptance: one missed heartbeat recovers without a stopped row; repeated failures terminate by the conservative deadline; a second owner is never admitted while the first has a valid grant. Timer throttling, response loss and clock changes cannot extend the client grant.

## 3. Preserve interruption causes and settle native work

Primary files: `src/chat/run-turn-chat.ts`, `src/chat/settle-interrupted-turn.ts`, `src/app-state.ts`, `src/types.ts`, `src/api/generations.ts`, and existing run/recovery presentation helpers.

- [ ] Carry a typed cause through lease termination and the combined turn signal: explicit user Stop, confirmed ownership loss, ownership unavailable, and existing system/timeout reasons.
- [ ] Inspect the originating signal/cause before generic AbortError handling. The shared runner can normalize an abort, so settlement must still consult the lease failure reason.
- [ ] Persist ownership failures as failed runs with a clear recovery message, using the existing failed-run record and recovery UI. Keep the existing user/system Stop semantics for their actual callers. Do not reinterpret old stored stop reasons without evidence.
- [ ] On ownership infrastructure failure, stop further dispatch and cancel this turn's known backend generation when necessary. Keep the server fence until cancellation settles; do not cancel an unrelated generation now owned elsewhere.
- [ ] Retain completed tool results and partial output. If a tool was already dispatched when ownership expired, preserve its eventual result and prevent the next tool/model action; cancellation is not rollback.
- [ ] Offer the existing explicit Continue/Retry recovery once ownership can be acquired. Resume from recorded history and completed results; never silently restart the original user request.
- [ ] Add bounded diagnostic entries for renewal failures/recovery, terminal ownership cause and native cancellation outcome. Include chat/run/generation correlation and elapsed timing, with no token, owner credential, transcript or raw response body. Deduplicate repeated retries; successful routine heartbeats remain silent.

Acceptance: ownership failures are visible and persisted accurately across reload. Explicit Stop still works immediately. A stopped frontend cannot leave an unobserved native turn running indefinitely, and an ownership conflict cannot cancel another owner's work.

## 4. Reconcile Codex snapshots without terminating healthy turns

Primary files: `server/generations/codex-app-server/translate.js`, `pump.js`, `manager.js`, and relevant shared stream consumers.

- [ ] Track items by native turn, item id, channel and section index. Track which Minnow generation owns their emitted text so late completion events across tool handoffs cannot replay text into the next round.
- [ ] Keep the current fast path: exact duplicate completion emits nothing; an extending snapshot emits only the missing suffix; completion-only text is emitted once.
- [ ] Treat empty or shorter prefix snapshots as stale after nonempty deltas. Preserve streamed text and record a bounded diagnostic when appropriate; do not append a duplicate or fail the run.
- [ ] For genuinely revised reasoning, preserve the already-streamed reasoning section for that item and record the divergence once. Reasoning is a presentation channel and is not part of the normalized native conversation continuation comparison. A revised summary must not trigger a new model request or tear down the CLI.
- [ ] For genuinely revised prose in the active round, adopt the authoritative completed prose using an explicit text-replacement control. Rebuild that round's cumulative prose from ordered item state. Do not append the replacement after the old text.
- [ ] Add a narrowly scoped, versioned internal stream control for prose replacement, with an equivalent shared runner event. Update the pump accumulator, stream reader, transcript store, live painter, remote publication and board/headless consumers together. Reuse existing paint helpers where suitable, but do not use router failover/reset controls that also clear tool calls or unrelated reasoning.
- [ ] Make the wire control idempotent and apply it before subsequent deltas or round completion. Persist the corrected prose through the ordinary final assistant row. Streaming and non-streaming responses must agree, and `session.accepted` must contain that same text.
- [ ] For a correction targeting an already handed-off/settled round, keep committed transcript/tool rows stable, diagnose the divergence and invalidate native reuse. At the next safe handoff, rebuild the native session from Minnow's recorded history including pending/completed results. Do not route a late correction into the current round or automatically repeat a tool. Cover the already-pending native call case before enabling this fallback.
- [ ] Retain hard failures for invalid tool permissions, contradictory tool ids/arguments, malformed envelopes and output limits. Tolerating text snapshot revisions must not weaken native tool validation.
- [ ] Record divergence metadata (channel, item/turn correlation, lengths, mismatch category) without raw prose or reasoning. Retain enough information to identify the actual variant if the failure recurs.

Acceptance: revised reasoning followed by a tool call and final answer completes in one native turn. Revised active-round prose appears once and matches saved history. Duplicated/stale snapshots and late handoff events do not duplicate text, lose results or execute a tool twice. Usage allocations remain unchanged.

## 5. Regression coverage and verification

- [ ] Ownership client/server tests: network error, timeout, 5xx, 401/403, 409, lost renewal response, success before deadline, success after termination, released lease, pending renewal at release, background clock jump, multi-chat independence, and competing renderer claims.
- [ ] Chat settlement tests: infrastructure failure is failed rather than user-stopped; partial prose and completed tool results survive; native cancellation retains the fence; Continue safely reacquires; actual user Stop remains stopped.
- [ ] Translator tests: exact/duplicate, extension, completion-only, empty/stale prefix, revised summary/body, revised prose, multiple items/indexes, and late events across handoffs. Replace the test that currently requires changed reasoning to throw.
- [ ] Pump/runner tests: revision followed by tool handoff and continuation, stream/non-stream equivalence, persisted corrected text, unchanged usage, unchanged native validation, and no replay of side effects.
- [ ] Presentation tests: active text replacement retains reasoning/tool state, saved/reloaded output agrees, and remote/board consumers converge on the same text.
- [ ] Run the relevant ownership, settlement, Codex translator/pump, runner and presentation suites, then `npx tsc --noEmit`, `npm run test:check-coverage`, and `npm test`. Record unrelated baseline failures separately.
- [ ] Run `npm run build` and `npm run check:performance-budgets` because the shared stream/UI contracts change.
- [ ] Perform one controlled manual smoke using a fake provider and scratch Minnow home: concurrent chats, a single failed renewal, a longer outage, a real conflict, reasoning revision and prose replacement. Verify continued work, accurate errors and no orphaned native process. Avoid the live profile for injected failures.
- [ ] Update `documentation/context.md` with the final lease and snapshot contracts. Update user troubleshooting documentation only for behavior that actually ships.

## Delivery order

Implement and review ownership resilience plus accurate settlement first: that addresses the strongest explanation for the recurring silent stops. Then land snapshot reconciliation with its end-to-end stream contract and tests. Both changes must pass their own focused tests before broad validation.

No changes to provider quota settings, account credentials, native tool permissions or user concurrency preferences are needed for this plan. No new top-level Minnow-home store is proposed.

## Implementation record

- Implemented a server-granted, monotonic ownership deadline with bounded renewal retries, immediate conflict/permanent-error termination, cancellation-safe release, and diagnostic failure/recovery events.
- Ownership errors survive combined-signal/runner abort normalization and settle as failed runs, retaining partial output and completed tool results. Loss of connectivity cancels the originating generation immediately; confirmed conflicts do not cancel another owner's work. The cancellation endpoint also closes parked Codex turns only when their generation id still matches.
- Completed Codex snapshots now preserve stale prefixes and revised reasoning. Revised active prose uses `minnow_text_snapshot` version 1 and the shared runner's existing cumulative `delta` path; a new runner event or UI reset is unnecessary. Tests verify that correction preserves reasoning, tool state, recorded history and native continuation.
- Item ownership is tracked across native tool handoffs without retaining previous generation closures. Late prose changes invalidate reuse and rebuild from recorded history at the next safe boundary.
- Focused validation passed: 123 ownership/settlement/painter/runner checks, five additional HTTP failure-classification checks, and six targeted prose/cancellation/handoff checks. The initial Codex translator/pump and remote-ownership run passed all 76 checks; later additions also passed targeted reruns.
- Type checking, test discovery and the final production build passed. The asset-size gate already fails on the prior checkout (`d61f8ebb8`): 11,791.2 KB versus the 11,735 KB ceiling. The final changed build measured 11,793.9 KB (58.9 KB over). Budgets were not raised.
- The full suite completed: 13,230 reported tests, 13,151 passed, 39 failed, two cancelled and 38 skipped. Failures include legacy CLI fixtures, Windows symlink permissions/native shutdown, headless-host/model startup timeouts, and existing UI expectations. The stdio MCP handoff and both tool-start remount failures reproduce on the prior checkout; other selected CLI failures passed when rerun. The prior checkout also fails the headless production-boundary smoke, at its model startup barrier rather than host readiness, so that full end-to-end path remains unverified here. Focused ownership, prose reconciliation, generation cancellation, tool handoff, renderer and persistence regressions passed.
- Restored tracked reliability reports and runtime fixtures produced by the full suite, preserving the Codex fixture edits and unrelated working-tree/index changes.
- Failure injection used fake clocks, HTTP fixtures and scratch native CLI homes. A manual GUI/live-account smoke was not performed.
