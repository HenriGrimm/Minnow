# Persistent conversation storage and recovery

Persistent agent conversations use additive tables in `sessions/sessions.db`. SQLite `user_version` remains **1** and the existing session JSON shape remains **6**. Creation is enabled by default on compatible SQLite servers through the shared capability in `server/chats/feature.js`. JSON-store mode cannot create persistent conversations. The explicit rollback switch preserves recovery and existing human continuation as described below.

`server/chats/archive.js` exports the complete conversation store: the existing session tables, 17 conversation domain tables, checkout allocations, and complete family `agents/<owner>/journal.jsonl` events. Canonical messages retain their original JSON payload, signatures, images, provenance, message identities, row hashes and revisions. Immutable profile versions, command receipts, task results, completion cohorts, usage receipts and read cursors travel with them. Search mirrors are rebuilt from canonical messages on import.

## Backups and rollback

The user backup flow remains **Settings → Backups** and the `.mnbak` backup/restore CLI. Its existing sessions and agents catalog roots already cover these records. SQLite snapshots use the online backup API and include every additive table. Checkout files remain outside the conversation backup; restoring an allocation does not restore its files.

A `.mnbak` restore is staged and applied before stores open. `server/backup/restore-apply.js` remains free of store imports. The conversation runtime then follows the same recovery entry as an ordinary startup, before family schedulers can start.

An old binary does not understand new ownership markers. Running one directly against a home that has persistent conversations is unsupported. For an offline binary downgrade, stop Minnow and restore a **pre-upgrade** `.mnbak` into an isolated home before launching the old binary against that home. A current JSON export cannot convert new conversations into old execution semantics. The pre-agent schema fixture and staged backup rollback test in `test/chats/migration.test.mjs` verify that restoring a pre-upgrade backup retains the original old-layout chats and messages without additive conversation tables.

`MINNOW_AGENT_CONVERSATIONS=0` disables new persistent creation on a compatible current server while retaining recovery and human continuation of existing managed conversations. That is the supported feature rollback; it does not rewrite history or remove tables.

## Explicit contributor JSON transfer

Authenticated local-host endpoints:

| Operation | Request | Response |
|---|---|---|
| Complete export | `GET /api/chats/archive/export` | `{ archive }` |
| Additive import | `POST /api/chats/archive/import`, body `{ archive }` | `{ receipt }` |

Writes require `X-Minnow-Chat-Protocol: 1`. Paired devices cannot transfer the home-wide archive. The SQLite store is required. `src/chat/managed-chat-archive.ts` provides the typed client functions. The existing `POST /api/config/sessions/export-json` includes the same archive under `data.conversationArchive` alongside its ordinary session data.

The archive carries `version: 1`, `clientProtocol: 1`, `sqliteVersion: 1`, `sessionVersion: 6` and a SHA-256 digest of canonical JSON. It contains full private prompts and conversation content. JSON transfers are limited to 256 MiB; use `.mnbak` for larger stores.

Import is additive. Overlapping identities are rejected without replacing current rows. Repeating the exact archive recovers the same durable receipt. Whole-session PUT/PATCH, browser-local-storage migration, and client session saves reject an archive envelope instead of silently dropping its protected records. The one-time legacy `sessions/state.json` importer recognizes the versioned envelope; ordinary old JSON keeps its existing migration behavior.

Explicit JSON imports are detached archival evidence. Imported pending commands remain held, cancellation epochs advance, automatic parent wake is blocked, and pending questions/approvals expire while retaining their saved bodies. A fresh human action is required to continue under current model, policy and checkout validation. Old callback grants cannot license a new effect. Imported isolated checkout allocations retain their captured paths and prior state but become `recovery_required`; they cannot manufacture a derived workspace grant. No verification/rebind action is implied. Continue in an independently registered checkout under current authority.

## Presentation concurrency

Canonical conversation revisions continue to fence transcript ownership, deletion and legacy writers. Managed user metadata has a separate compare-and-swap counter, `chat_conversation_state.meta_json.presentationRevision`; no table or wire schema version is added. Only actual changes to `name`, `groupId`, `pinnedAt` and `composerDraft` advance it. `pinnedAt` is the existing positive timestamp, not a second boolean pin field. Transcript, model/profile, request, usage and acknowledgement updates preserve the counter without advancing it. Authoritative rename/pin configuration uses the same change detector.

Full session and summary reads include `chatPresentationRevisions` when managed records are present. A new writer supplies captured `chatBasePresentationRevisions` for the managed rows it understands. Missing entries use the existing canonical chat revision check; entries naming unmanaged rows are rejected. Old clients keep canonical revision checks. Deletes always require their normal canonical base; a presentation counter cannot authorize deletion or rewrite lineage, model/profile, context or history.

Full metadata frames carry `agentPresentationRevision` with the complete name/group/pin/draft snapshot. A notice carrying only a counter cannot rebase a dirty local edit. The client keeps its captured presentation base while local metadata is dirty; it never replaces that base with a newer server value to blindly retry a conflicting edit.

A validated managed-only PATCH with no scalar/group/deletion mutation can compare presentation revisions independently of the global session revision. Mixed writes, including an active-chat scalar, retain global concurrency and may rebase only that global revision; the captured presentation base stays fixed. PUT retains global concurrency. PUT/PATCH responses echo the exact counters captured inside their commit transaction, rather than rereading a later writer's values. No-op writes leave the presentation counter unchanged, and a failed transaction rolls back both metadata and counter. A new presentation writer omitting the draft or pin clears those saved fields; legacy partial writers retain their previous omission behavior.

Coverage: `test/chats/presentation-revisions.test.mjs` includes actual HTTP ACK → draft races, two-window and authoritative-rename conflicts, mixed global rebase, pin/unpin/draft clearing, missing-counter fallback, no-op/rollback, protected-field forgery rejection and PUT receipts.

## Legacy completion after parent takeover

The renderer completion adapter handles ordinary legacy parents only. Persistent child bindings are preserved through saved snapshots and excluded from legacy ingestion, nudges and delivery. A managed parent also refuses renderer insertion, resume and acknowledgement, including after an asynchronous ownership change.

`server/chats/legacy-result-delivery.js` verifies terminal legacy runs from their actual parent journal. A per-run intent in the existing outbox freezes its result and cancellation boundary. Private service admission waits for parent quiescence, then commits the command and host-identical canonical input together before acknowledging the journal. A busy parent keeps the journal result pending; it cannot insert a row between an assistant tool call and its result. Reopening after SQL acceptance but before journal acknowledgement reuses the same receipt, even when the next batch has different membership.

Stop, a changed cancellation epoch and imported legacy evidence retain the canonical result without an automatic continuation. Existing saved renderer receipts count only when the corresponding hidden result actually exists in canonical history. Startup and shutdown defer managed acceptance until its canonical owner is ready; an old HTTP acknowledgement cannot fall through to the legacy SSE path. Ordinary legacy parent delivery remains compatible. These changes add no table, graph event or public command action.

Coverage: `test/chats/legacy-result-delivery.test.mjs` includes actual SQLite/journal reopen, ownership and Stop races, import/disposal, and a complete production-runtime loopback tool host. Renderer completion-push and completion-delivery integration suites cover late binding, saved snapshots and pre-acknowledgement rechecks.

## Recovery order

`createChatRecovery().run({ reason, chatIds? })` is the shared startup, restore and explicit-import entry:

1. Restore committed archive journal chunks through the ordinary journal's per-owner append lock. Exact stamped sequence and idempotency keys are retained. A divergent or gapped timeline is blocked; an existing torn tail is preserved for recovery.
2. Reconcile SQLite/JSONL skew. Durable outbox events repair missing journal writes even when an acknowledgment was copied; immutable task results repair missing terminal evidence. A journal task missing canonical conversation records receives a recovery barrier. Delivery acknowledgment repair also settles the matching subscription.
3. Recover safe saved question boundaries before ordinary interrupted executions. Only the trusted runtime can prove host/generation quiescence and reattach the exact request, execution and assignment attempt. This applies to the same home and `.mnbak` restore, not a detached JSON import.
4. Recover other executions using explicit host/generation quiescence proof. Unknown native/tool intents remain `recovery_required`; timeout is not proof that an effect stopped. Interrupted approvals and unrecoverable question callbacks expire without discarding their saved bodies. Reattached questions and live waiters remain bound to their original execution.
5. Reconcile interrupted checkout setup and task delivery, then load the family adapter. The runtime becomes ready before inference and normal queue kicks begin.

SQLite and JSONL copies can represent different instants. Durable command/event identities and outboxes reconcile that boundary; there is no claim of a cross-file transaction. Explicit imports scope reconciliation to their imported conversations so an unrelated live outbox keeps its owner.

Coverage: `test/chats/migration.test.mjs`, `test/chats/question-recovery.test.mjs`, production question/workflow suites, configuration snapshot/import tests, and the backup and journal suites.

## Verify an unpacked build

Run `node scripts/verify-packaged-agent-conversations.mjs --app-dir <unpacked-app-directory>` against the supplied Electron application directory. Its eight checks load the actual ASAR/server modules, native SQLite binding, shared composer and shipped manual using a temporary Minnow home, without inference. A missing supplied application directory fails verification; this command does not build or substitute an application.
