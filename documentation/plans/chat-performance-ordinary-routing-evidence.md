# Ordinary routing implementation evidence

Status: supported ordinary-root admission and idle promotion are **enabled by default** in `server/chats/feature.js`. `MINNOW_ORDINARY_CHAT_EXECUTION=0` blocks new promotions only; canonical ownership, receipt recovery and command execution remain server-owned. No user setting, commit or live configuration was changed.

## Implemented contract

- `GET /api/chats/:id/ordinary-routing` authorizes the current reader and returns `{chatId, route, eligible, reason, revision}`. An already-canonical chat always reports `server`, including rollback.
- Protocol-v1 `POST` to that endpoint accepts only `{expectedRevision, clientRequestId}` from the authenticated renderer human ingress. It shares send/configuration admission serialization, verifies the saved revision, idle ownership, current checkout and supported scope before and after asynchronous profile capture, then commits the canonical marker, profile and immutable promotion receipt in one SQLite transaction. It does not start a model turn or release a legacy lease. Devices can observe but cannot promote.
- Promotion receipts use the existing outbox and survive database reopen and gate rollback. Reusing a receipt identity with changed input fails. A second window finding the root already canonical uses that authority instead of creating another profile.
- Both composer and programmatic ordinary sends run the routing coordinator before selecting their existing managed command path. Eligible raw roots flush their legacy shell/transcript with existing session reconciliation and pin its clean acknowledged revision. Local slash controls and empty sends do not promote. Active raw owners remain on their legacy path.
- Once promotion is dispatched, uncertain/malformed responses retain the original revision/request identity in memory and session storage. Errors preserve the draft and never dispatch a renderer model request. Canonical chats always remain command clients. Direct human command admission into an unpromoted root is rejected even if ordinary feature gates are injected as enabled.
- Observer streams do not initiate promotion. Closing/replacing a bridge aborts fallback hydration; late decoded responses cannot repaint its old view. Explicit raw notices/frames cannot downgrade a canonical marker or replace its transcript. Session summary refresh also fences raw replacements if promotion occurs before or during its history read. Local drafts remain viewer-owned.

## Released supported scope and remaining exclusions

Eligible roots are ordinary, workspace-backed General/Build/Plan/Debug conversations. Existing roots must have a fully loaded, settled history with complete call/result groups and no unresolved calls, duplicate/orphan results, system/injection rows, compaction, native-resume state, legacy branch selection, pending corrections/mode changes, active controllers, child delivery state or specialized/background preparation. Completed historical calls are copied only as observations and never executed to reconstruct context. Unsupported cases report named reasons and remain legacy before any promotion attempt. Deferred worktree intent is handled by the existing server workspace-preparation path after canonical admission; this routing slice does not create another worktree service.

The conservative historical restriction is deliberate: installing a marker is not proof of full-fidelity legacy replay/native continuity. Unsupported historical/specialized cases remain outside automatic promotion. The supported subset is released; this does not claim complete historical migration or packaged Windows/macOS/Linux certification. Existing canonical histories, queue/steer/Stop, approvals and server host recovery continue through the shared implementation. JSON storage explicitly advertises admission/promotion/recovery unavailable rather than publishing contradictory enabled gates.

## Verification

All commands used scratch/in-memory fixtures, not live settings.

- Default-activation regression: **51 server tests passed** across routing, middleware and production runtime. The runtime worktree test now starts with a raw root, promotes through the actual HTTP endpoint without injecting a gate, then verifies isolated file effects/final prompt cwd and the next turn. A second actual HTTP fixture promotes saved idle history, rolls admission back, replays the original promotion receipt and continues canonical inference with the historical messages preserved.
- After adding rollback-during-profile-capture coverage, routing/commands regressions and **24 renderer tests passed**. The real renderer save → promotion → send fixture now reads the actual default server capability and uses the default service gate, not an injected enabled capability. Released/disabled capability parsing, rollback, malformed responses, slash/pinned intent and attachments are covered. `npx tsc --noEmit` passed; capability-reader diagnostics were clean.

- Earlier ordinary-routing server suite: **8 passed**; commands: **37 passed**; middleware: **32 passed**. Presentation and actual process-restart suites passed in the earlier integrated run.
- Earlier combined ordinary routing client, activity bridge, managed client, legacy autosave/Continue UI, host capabilities, multi-window sessions and dirty tracking: **80 passed**.
- The shared accepted-settings recapture edit temporarily broke two old capture/fork assertions during the broad rerun. The shared fixtures were reconciled with fresh accepted settings; focused commands and middleware reruns are green.
- Deferred worktree, followup interception, git-setup background, shared chat and bridge: **33 passed** with `--experimental-test-module-mocks`.
- `npx tsc --noEmit`: passed. Edited TypeScript files have no diagnostic errors.
- `npm run headless:build`: passed; generated bundles were not staged.

The real HTTP client test exercises session save -> revision-checked promotion -> managed send -> one server host invocation and canonical user row, and asserts no `/api/generations` request. Lost receipts, concurrent promotion/sends, late owner acquisition, saved-revision races, database reopen, device promotion denial, rollback, malformed acknowledgements, observer disposal and stale multi-window summaries have focused coverage. The broader git-setup probe initially failed because its `mock.module` tests require the experimental module-mock flag; rerunning with the repository-required flag passed. Full-suite/production frontend build and packaged cross-platform behavior were not certified by this slice.
