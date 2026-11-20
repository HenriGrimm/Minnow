# Project memory rework — validation

2026-11-20, Windows development checkout. Implementation is in place; the full release gate is **not green**.

## Implemented

- Project identity from Git's common directory, shared by linked worktrees; canonical-folder scope for non-Git/multi-repo roots. Mirrored checkouts must belong to the claimed source's storage namespace. Project-move recovery rebinds memories without changing ids.
- Project/user records with limits, capacity errors, same-title/semantic duplicate checks, credential rejection, revision-checked updates and backed-up deletion. Duplicate checks do not rely on background vector sync finishing first.
- Scoped keyword/semantic search, compact results, supersession, no recency fallback. Legacy notes and other projects never enter memory results.
- Four `memory_*` tools; old wiki tools removed from agent/MCP catalogs. Children and board attempts have read-only memory tools. Reads are parallel-safe; writes retain app-write and planning-clamp classification.
- No memory retrieval or legacy Brain-notes replay during prompt preparation. One static policy (read-only variant where needed), including older captured profiles. No onboarding or end-of-task capture mandate.
- Background synthesis proposes skills only. Legacy memory proposals remain stored but are not displayed in the Proposals view.
- Brain Memories groups current-project and user records by kind, supports revision-checked edits/Forget and capacity counts, and refreshes on agent tool results without replacing an edit draft. The Graph/tree excludes agent memories and labels its remaining pages as legacy notes.
- Manual, architecture context, release compatibility notes and generated catalogs updated. Existing unrelated worktree changes were preserved.

## Passing checks

- `npm run test:brain` (final JavaScript runner batch: 284 passed; its separate synthesis-route batch also passed).
- `npm run test:memory` (56 passed), `npm run test:skills` (140 passed).
- `npm run test:product-wiki` (13 passed); `npm run wiki:generate`.
- `npm run test:check-coverage`, `npm run architecture:check`, `npx tsc --noEmit`.
- `npm run build`; warnings: `INEFFECTIVE_DYNAMIC_IMPORT` (mixed static/dynamic imports). No budget increases or generated build output staged.
- Focused tests: memory store 18, memory search 8, memory tools/HTTP routes 10, MCP hub 14, project move 5, managed preparation 33, commands 45, memory guidance 6, memory tool wiring 4, sub-agent memory 4, renderer parallel policy 11, CLI read batching 3, Memories UI 9, Proposals UI 1, save toast 10, composer overflow 12, prompt composer 5. These were run with their discovery-defined runner profiles, not all with plain Node.
- Headless bundle, managed headless boundary, managed chat and scheduler runner tests passed. Native live execution had no passing live cases and is not counted as runtime certification.

## Browser evidence and limits

A separate scratch `MINNOW_HOME` on port 9611 was used; the live user's memory corpus was not migrated or cleared. Seeded project/user memories were listed and a programmatically submitted edit persisted with `source: user`. Layout measurements covered desktop and 760px/430px viewports. At 430px the memory detail was reachable by scrolling, with document width 430px and detail bounds within the viewport horizontally.

This is **not** a completed Electron-shell manual acceptance check. The scratch browser displayed “Minnow is taking longer to load” in `#app-loader`, which intercepted a native Forget-button click. Underlying form/HTTP behavior was tested, but this is not a claim that the whole rendered click flow passed. Browser page errors were empty when checked; provider discovery could not reach the scratch instance's unconfigured LM Studio. Console/network monitoring was not comprehensive.

## Full-suite failures still requiring triage

`npm test` ran to completion with failures. The stale memory/overflow expectations it exposed in `test/prompts/prompt-composer.test.mjs` and `test/ui/composer-compact.test.mts` were fixed and pass focused reruns. The entire suite was not rerun after those repairs; no green full-suite result is claimed. No clean-HEAD comparison was performed, so the other failures are not asserted to be pre-existing.

`npm run check:performance-budgets` also fails: current total assets are **12,545.0 KB**, exceeding the 12,525 KB ceiling by **20 KB**. A separate temporary archive of HEAD, with the pre-existing issue/history/types/Antislop edits and multi-repo manual page copied in, was built against the same installed dependencies. That comparison produced **12,560.4 KB** total assets (35.4 KB over) and **4,858.8 KB** eager JS (13.8 KB over). The memory implementation reduces total assets by about **15.4 KB** versus that working-tree baseline and brings eager JS below its ceiling, but does not make the total-asset gate green. No budget or committed baseline was increased.

Focused reruns still fail in:

- `test/chats/native-execution.test.mjs`: `missing-proof`, `active-command`, `wrong-turn` handoff/quiescence cases.
- `test/chats/runtime.test.mjs`: native workspace-ceiling assertion (“Missing expected rejection”) and permission-revocation assertion (`Cannot read properties of undefined (reading 'code')`).

The full run also reported failures in these files, not repaired or certified by this memory-focused change:

```text
test/appearance/fonts.test.mts
test/benchmark/capability-matrix-suite.test.mts
test/benchmark/skills-probes.test.mts
test/chat/experts/create-expert-parse.test.mjs
test/chat/shared-chat-live.test.mts
test/chats/child-model-controls.test.mts
test/headless/packaged-agent-conversations.test.mjs
test/lsp/file-uri.test.mjs
test/notifications/managed-chat.test.mts
test/orchestrator/board-reasoning-live.test.mts
test/orchestrator/board-state-schema.test.mjs
test/orchestrator/p2g-e2e.test.mjs
test/orchestrator/p3e-e2e.test.mjs
test/os/scheduler-app.test.mts
test/os/source-control-app.test.mts
test/server/workspace-open-in-app.test.mjs
test/state/session-save-scaling.test.mts
test/ui/appearance-density-layout-browser.test.mjs
test/ui/dev-server-polling.test.mts
test/ui/messages-history-scroll.test.mjs
test/ui/orchestrate-plan-screen.test.mts
test/ui/research-panel.test.mts
test/ui/sidebar-ledger.test.mts
test/ui/super-plan-entry.test.mts
test/ui/terminal-xterm-theme-browser.test.mjs
test/ui/transcript-view.test.mts
test/ui/workbench-surface-tabs.test.mts
```

Before release: triage these failures, resolve the total-asset budget breach, rerun the full suite and complete the Electron desktop/narrow edit-and-forget flow on a normally booted shell. External MCP clients and scheduled prompts that name the retired tools require updates (see `documentation/releases/project-memory-unreleased.md`). Restart the tool server to load the changed catalog/handlers.
