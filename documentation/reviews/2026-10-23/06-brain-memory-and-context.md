# Brain, memory, indexing, attachments and retrieval review

Date: 2026-10-23. Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Read-only source review with synthetic scratch data and targeted tests.

## Scope and assessment

Read Brain page CRUD/catalog/frontmatter and revisions, workspace/archive/expert retrieval filters, shared keyword/vector ranking, synthesis extraction/linking/retirement/proposal acceptance, source ingest and capture, cleanup executor boundaries, code-index worker host, editor and saved-memory UI, attachment readers/queue/workspace references, first-turn injection and replay. Sampled client/server counterparts and their existing tests. Sources include `server/brain/{store,retrieve,synthesis,synthesis-routes,ingest,capture,proposals}.js`, `server/engine/{retrieve,proposals,vector-sync}.js`, `server/brain/{cleanup/execute,code/index-host}.js`, `src/attachments/*`, `src/synthesis/client.ts`, `src/chat/prompts/{compose-context,first-turn-injection}.ts`, and Brain edit/review UI.

Brain should make the next conversation more capable with relevant, inspectable knowledge. It should not require routine knowledge-base maintenance to get value from a chat-driven build. The implementation has good provenance, bounded injection, readable storage and failure fallbacks, but automatic synthesis does not preserve the same workspace boundaries as retrieval. Those boundaries need fixing before expanding automatic learning.

No live embedding download/inference, actual LSP indexing, vector-scale performance benchmark, model-driven synthesis, cleanup model execution, document extraction binary, or exhaustive Brain UI journey was performed. Broader prompt/tool policy and live UX are covered elsewhere. This report distinguishes global personal knowledge (intentionally shared) from `scope:'workspace'` facts (intentionally stored under one project).

## Good

1. **Inspectable, guarded storage.** Page mutation/catalog/log queues (`server/brain/store.js:43`) and same-directory atomic replacement preserve complete page files. Reads/writes expose revision IDs; stale expected revisions reject (`:755`). Existing CRUD tests verified conflict rejection, prior-page backup and replacement failure behavior. Human edits and agent writes can share this store safely when callers use the revisions.
2. **Retrieval scopes before reading bodies.** `server/brain/retrieve.js:158` scopes metadata before `loadAllPagesWithBodies`; reads are bounded to eight concurrent operations (`:130`). The admission test verifies workspace/expert/archive scope and corrupt-page skipping. Global pages are deliberately shared, while other `workspaces/<key>/` trees are excluded (`:23`).
3. **Automatic injection is more selective than explicit search.** `server/engine/retrieve.js:38` requires a specific title/tag topic match for `autoInject`, rather than letting broad “build an app” requests inject arbitrary recent project notes. Keyword retrieval remains available if embeddings are disabled/unhealthy (`:195` onward). Relevant excerpts and untrusted-content wrapping preserve useful context without treating it as instructions.
4. **Context is visible and stable within a conversation.** First-turn gating, persisted injection notices/snapshots and replay (`src/chat/prompts/first-turn-injection.ts:10`; `src/chat/context/injection-replay.ts:70`) give the user an inspectable record of what was injected. Replay preserves an untruncated snapshot when display rows were cut. This avoids silent prompt changes caused by a transient retrieval failure on turn two.
5. **Attachments have real lifecycle protection.** Pending file reservations count toward a ten-file/25 MiB queue budget, individual files cap at 10 MiB, removed reads abort, and an epoch prevents late extraction from filling the next composer's queue (`src/attachments/store.ts:17`, `:118`; `reader.ts:14`). Fourteen scoped attachment/focus tests passed, including navigation and removal races.
6. **Code indexing is background work with progress and bounded failure.** `server/brain/code/index-host.js:21` defines hard/silence timeouts and newline framing; the host reports progress rather than blocking chat on a full index. Framing and summary tests passed. Main indexer accuracy and real-platform process cleanup remain outside these checks.
7. **Brain editing protects newer drafts.** `src/ui/brain/edit-section.ts:15` tracks navigation/draft/save versions and keeps per-page drafts. Async load responses only apply to the matching unchanged form (`:211`). The design is more robust than a single shared editor buffer.
8. **Capture has an honest fallback.** `server/brain/capture.js:91` can produce an explicitly extractive summary when a utility model is unavailable. This preserves a usable artifact instead of pretending a model summary succeeded.

## Verified defects

### B1 — P1: Automatic synthesis can retire another project's knowledge

- **Evidence:** `runMemorySynthesis` loads every Brain page via `loadAllPagesWithBodies()` with no workspace scope (`server/brain/synthesis.js:577`). This same `existing` list is used for deduplication, related links and retirement (`:612` onward). `retireSupersededPages` selects by title similarity/cosine and updates any matching path to `status:'stale'` plus a new `similarTo` (`:446` onward); it does not require that old/new pages share a workspace or personal scope.
- **Trigger:** Two projects have a similarly titled convention such as “Vite preview port.” A new high-confidence fact auto-writes for project A.
- **Observed:** Calling the real retirement helper with the same all-page input shape changed `workspaces/project-b/port-policy.md` to stale and linked it to `workspaces/project-a/port-policy.md`. No LLM or embeddings were involved. The same current source path also allows dedupe against another project, suppressing a fact that should exist independently.
- **Impact:** Automatic learning mutates unrelated project metadata and relationships. Stale status does not delete the page; this report does not claim the current retriever universally excludes stale pages. The defect is the cross-project mutation and incorrect supersession relationship.
- **Confidence:** High: dynamic helper reproduction plus exact automatic caller data-flow. The model's chance of generating matching titles was not measured.
- **Repair:** Capture fact ownership before dedupe/linking/retirement. Workspace facts should only supersede eligible pages within their originating workspace. Personal/global facts need an explicit, separate retirement policy. Same-topic similarity alone should not prove contradiction/supersession; preserve nonconflicting related facts.

### B2 — P2: Accepting a workspace memory proposal uses the accepting window's project

- **Evidence:** The proposal schema/normalizer saves `scope` and `sourceChatId` but no origin workspace (`server/engine/proposals.js:128`). Proposal acceptance passes `row.scope` into `writeSynthesisFactPage` with no source directory (`server/brain/synthesis-routes.js:243`–261). `synthesisFactDir` resolves the *current request's* effective workspace (`server/brain/synthesis.js:329`).
- **Trigger:** A workspace-scoped proposal originates in project A, then is accepted from project B's window or after switching projects. Proposals are listed globally, so this is an ordinary review path.
- **Observed:** The actual acceptance handler returned 200 and wrote “Project A convention” beneath `workspaces/project-b/`. The proposal lacked a workspace key. See the preserved `brain-workspace-scope.mjs` reproduction.
- **Impact:** Project A loses the intended scoped memory; project B receives a misleading convention. Explicit personal/global proposals should remain global and are not the problem described here.
- **Confidence:** High: synthetic proposal creation and real accept-handler execution in two request scopes.
- **Repair:** Persist canonical origin workspace/key with every workspace proposal and use it at acceptance. Migrate old proposals by source chat when possible; show an explicit destination when it cannot be recovered. Make acceptance idempotent/atomic with the write to prevent duplicate artifacts under concurrent review.

## Design risks and workflow improvements

### R1 — Proposal persistence needs concurrency tests

`server/engine/proposals.js:80` uses a shared `.tmp` name and independent load→modify→save operations for add/edit/accept/reject. Unlike page CRUD, there is no serialization in the sampled store. Multiple chat completions or windows can overlap. This is a source-observed race risk; concurrent loss was not reproduced here. Use serialized mutations and unique temp paths, then test concurrent creation and accept/reject interleavings. The separate skill proposal queue needs the same audit.

### R2 — Retrieval reads every eligible body on every request

`server/brain/retrieve.js:198` loads the complete scoped corpus before keyword/vector ranking. Eight-reader concurrency bounds open IO, but not total work or memory. Larger libraries need an incremental text/vector candidate index and observable query latency. No scale benchmark was run, so this is an architecture risk, not an asserted performance regression.

### R3 — Ingest's “extend existing topic” instruction does not match its write strategy

The ingest prompt requests updates to existing topics, but implementation always creates and falls back to a random `facts/` path on conflict (`server/brain/ingest.js:109`). Re-ingesting the same material can therefore create parallel pages instead of a reviewed update. Raw source is saved before model resolution (`:66`), and malformed/empty model output can return success with zero pages (`:104`, `:147`). These are source-verified behaviors; the intended deduplication/merge policy needs a product decision. Show “source saved, no pages created” and offer repair/retry; propose revision-guarded updates with source provenance rather than accumulating near duplicates.

### R4 — Context freshness should be explicit

First-turn snapshots intentionally replay old notes/code maps. That stability is useful, but a long-running build can outlive its project map and decisions. Offer an explicit Refresh context action with a receipt explaining what changed, its source revision and size. Avoid silently replacing context mid-turn.

### R5 — Root ownership must survive every attachment/reference path

Workspace chips contain a path but no root in `src/attachments/workspace-ref.ts:95`; default readers call tools without a captured scope (`:111`). Ordinary messaging also awaits attachment resolution before rechecking chat/epoch (`src/chat/messaging.ts:454`), which is a positive late-result guard but does not by itself prove source scope. Audit file-tree worktree drops, worktree chats and cross-project restored drafts together. No wrong-file attachment was dynamically established in this section; do not treat this as a confirmed exposure.

### R6 — Rejecting an updated memory deletes the page rather than restoring the prior revision

The saved-memory card accepts both Created and Updated tool results (`src/ui/memory-saved-toast.ts:133`), while Reject calls page deletion (`:164`). For an update, a user may interpret Reject as rejecting the latest change. This is a source-grounded interaction risk; no live confusion study was performed. Carry the write's revision/action and offer Undo update/Restore previous version; reserve Delete memory for explicit deletion semantics.

### D1 — Put evidence and ownership ahead of the graph

For chat-driven building, the valuable questions are “what did Minnow remember, why, for which project, and did it help?” Make scope, provenance, confidence, source chat and last verification visible on memories/proposals. Keep the graph as an exploration tool. Batch review should support accepting useful knowledge without learning storage folder conventions.

### D2 — Make learning repairable from the conversation

Allow corrections such as “that applies only to this project” or “stop using that outdated convention” to produce an inspectable change with a durable undo trail. Existing saved-memory receipts provide the right starting point. Prioritize correcting a bad memory over generating more memories.

## Checks actually run

- `node --experimental-test-module-mocks --test --test-timeout=45000 test/brain/store-crud.test.mjs test/brain/retrieve-scope.test.mjs test/brain/retrieve-admission.test.mjs test/brain/synthesis-linking.test.mjs test/memory/proposals.test.mjs test/brain/code/index-host-framing.test.mjs` — **35 passed**, 9 suites.
- `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --test --test-force-exit --test-timeout=45000 test/attachments/pending-lifecycle.test.mts test/attachments/reader-routing.test.mts test/attachments/workspace-text-read.test.mts test/brain/code/code-map-focus.test.mts` — **14 passed**, 5 suites.
- Scratch stdin reproductions of B1 and B2 both succeeded. `evidence/brain-workspace-scope.mjs` preserves both cases with runnable command `node documentation/reviews/2026-10-23/evidence/brain-workspace-scope.mjs`. Embeddings are disabled before page writes; no model/download/external account is used. The script intentionally retains its synthetic temporary home and prints the path, allowing review without recursive deletion.
- A first exploratory proposal reproduction used string stream chunks where the route expects Buffers; it failed before the assertion. The corrected Buffer-based handler reproduction passed. Its synthetic scratch home `C:\Users\dukky\AppData\Local\Temp\minnow-review-proposal-RqQgIk` remained after automatic approval review rejected `Remove-Item -LiteralPath ... -Recurse -Force` with only “blocked by policy.” No further deletion was attempted by this reviewer; the coordinating reviewer received the path/file inventory. No credential files appeared in that inventory.

No full suite/build, semantic quality score, or claim that every page/attachment source was covered.

## Cross-vertical dependencies

Synthesis/proposal scope depends on chat/session/workspace identity. Prompt replay depends on compaction/session persistence, and code indexing depends on LSP and platform process management. Memory/skills share proposal concepts but not all concurrency protections. Global vs expert namespaces need a clear product contract: the generic workspace filter treats non-`workspaces/` paths as global, while expert queries apply a narrower explicit filter. The index-worker POSIX abandonment path kills only the direct child (`server/brain/code/index-host.js:161`) despite the function comment describing a whole subtree; platform process-cleanup reviewers should validate descendants before assigning severity.
