# Code workspace and runtime tools review

Review date: 2026-10-23. Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Read-only product review; only this report and review reproductions were written.

## Scope and assessment

Sampled project selection and switching, workspace/window identity, Code boot and session integration, file tree and editor tabs, saves and external-edit reconciliation, LSP/completions/Quick Edit, PTY tabs and process lifecycle, managed dev servers, file previews and browser-to-chat handoffs. Sources include `src/state/{workspace,view-workspace,session-workspace-scope,file-panel}.ts`, workspace switching and Git panel callers, viewer/tab store and editor extensions, `server/workspace/*`, `server/lsp/middleware.js`, terminal UI/API/host/WebSocket modules, dev-server manager/UI/API, preview origin middleware/URL resolver, presented-file cards, browser preview tools and agent-browser runtime. Consulted AGENTS.md and the applicable architecture context.

Minnow already has useful ingredients for chat-driven building: a conversation can expose generated files, open a rendered result, accept feedback tied to an element, run commands, and isolate work in a checkout. The strongest improvements are consistency and recovery at these boundaries. Users should be able to change conversations, inspect a result, and return without losing drafts or changing the meaning of the terminal/editor they are looking at.

This is a bounded code and scoped-test review. No live Electron/browser session, model-backed build, actual LSP server invocation, installer, container, device pairing, or production project was exercised. The central chat engine and broader Git/orchestration correctness are covered by other reviewers. No Linux/macOS execution was performed here.

## Good: preserve these foundations

1. **Explicit workspace-bound renderer identity.** `src/state/view-workspace.ts:1` defines one workspace per renderer, and transport URLs include the view's workspace (`src/api/session-token.ts:97`). Electron workspace switching requests a replacement view instead of trying to reset every global in place (`src/ui/workspace-switch-guard.ts:222`). The in-memory, reference-counted open-workspace registry intentionally does not persist stale claims (`server/workspace/open-workspaces.js:1`). These are sound foundations for multiple projects and background agents.

2. **The editor anticipates agent/human concurrency during saves.** Saves use a disk revision precondition (`src/ui/file-viewer.ts:1383`), track the submitting tab instance and document revision, and preserve typing done while the save is pending (`src/ui/file-viewer-tab-store.ts:237`). External edits offer keep/reload/compare/merge without immediately writing to disk (`src/ui/file-viewer-external-conflict.ts:37`). The scoped tests cover pending-save/reopen and newer-draft behavior. This protects trust in a workspace where agents modify files continuously.

3. **Result handoffs can retain source scope.** `src/ui/presented-file-cards.ts:26` converts cross-root source paths to absolute paths before opening them, and carries `workspaceRoot`. HTML opens in preview rather than dumping source. The preview resolver honors source scope (`src/ui/preview-load-url.ts:129`), and downloads return original bytes. This is an unusually important part of a chat-first workspace.

4. **Preview feedback is connected to the conversation.** The context-menu handoff captures a selector, element metadata, accessibility name, geometry and screenshot into a composer reference (`src/ui/preview-context-menu-handler.ts:112`). This supports requests such as “make this button clearer” without requiring code navigation. Existing Send to chat tests passed.

5. **Executable previews have a distinct origin.** `server/preview/isolated-host.js:34` scopes capability URLs to a workspace and only serves preview routes. Main-origin HTML remains sandboxed (`server/preview/middleware.js:249`). Boundary/download tests passed. This is positive evidence about these sampled paths, not a complete security assurance.

6. **Terminal scope is deliberately visible.** New terminals follow the file explorer, while existing shells retain their directory and receive a scope-change hint (`src/ui/terminal-worktree-cwd.ts:71`). Agent output is a separate tab, with follow/badge policy rather than compulsory focus changes. Reload reconnects to existing PTYs instead of automatically killing them (`src/ui/terminal-tabs.ts:364`).

7. **Managed dev servers include lifecycle concepts beyond a shell command.** There is a registry, worktree root, port and health metadata, bounded startup reconciliation, process-tree termination and persisted run identity. The UI's Detect in chat action uses the same agent workflow (`src/ui/dev-server-screen.ts:64`). The scoped manager tests passed, including health promotion and timeout.

8. **Code boot isolates failures between surfaces.** `src/boot/code-workspace-modules.ts:18` catches individual initialization errors so terminal, file panel and other modules do not all disappear after one throw. All three boot tests passed. Failed individual steps are still treated as initialized; retry behavior is an improvement opportunity below.

## Verified defects

### W1 — P1: Changing checkout scope discards unsaved editor drafts

- **Evidence:** `src/ui/file-tree.ts:414`–433 resets open tabs and calls `closeFileViewerForce()`. That function explicitly bypasses unsaved prompts (`src/ui/file-viewer.ts:1916`) and clears the entire tab store through `resetAllViewerTabs` (`src/ui/file-viewer.ts:1886`). The store only persists tab paths, not dirty contents (`src/ui/file-viewer-tab-store.ts:152`, `:548`).
- **Reachable trigger:** Type in an editor without saving, then choose another existing worktree in the Git checkout picker. The picker calls `onWorktree` (`src/ui/git-checkout-picker.ts:185`), which calls `setGitPanelCwd` (`src/ui/git-panel.ts:730`); that invokes file-tree sync (`:258`, `:930`). Ordinary chat activation also calls `syncPanelFromActiveChat` (`src/ui/sidebar.ts:1673`), which can change this root (`src/ui/git-panel.ts:1792`).
- **Observed:** The real `syncFileTreeToPanelWorktree` removed a dirty tab; zero dialogs were created. See `evidence/workspace-dirty-root-switch.mts`.
- **Impact:** Unsaved human edits disappear during normal navigation. Git's dirty-checkout guard cannot protect changes that exist only in editor memory.
- **Confidence:** High, dynamic reproduction plus caller tracing. Full Electron workspace replacement was not exercised; that is a separate unsaved-draft recovery question.
- **Repair:** Preserve drafts under canonical document identity across checkout switches. Until durable restoration exists, collect Save/Discard/Cancel for every dirty tab before changing root, including inactive/split tabs. Do not reuse the force-close path intended for deleted files.

### W2 — P2: A stale terminal attachment can take control after a newer tab selection

- **Evidence:** `src/ui/terminal-xterm.ts:422` assigns global active identity before awaiting session validation or creation. Both completion paths call `connectWs` without checking whether that tab remains selected (`:443`–463). `connectWs` disconnects the currently active socket (`:277`). `src/ui/terminal-tabs.ts:270` similarly renders/persists after the awaited attach without an activation token.
- **Trigger:** Open/select terminal A, then B before A's session creation/reconnection finishes; let B resolve first and A last.
- **Observed:** Deferred HTTP responses resulted in socket order B→A although B was the latest requested tab. See `evidence/workspace-terminal-attach-race.mts`. No real shells were started by this reproduction.
- **Impact:** Terminal tab metadata, active input identity and the connected process can disagree. A command can reach a shell in an unexpected checkout. The actual connection reversal is verified; the exact final tab-label outcome depends on subsequent persistence completion order.
- **Confidence:** High for the stale connection; source-verified user trigger.
- **Repair:** Use an activation generation, check it after every await, and retain stale-created sessions for their own tab without attaching them. Closing/detaching a tab must also invalidate its pending attachment. Add reversed-completion and close-while-creating cases.

### W3 — P2: Cancelling an old Quick Edit marks the new edit complete

- **Evidence:** `src/ui/editor-quick-edit/panel.ts:192` aborts the previous request and replaces global `activeSession`. The old request's continuation only checks that some session exists, then sets that session's `streaming` flag to false (`:222`–224). Streaming partial callbacks likewise write the global session (`:215`). Accept is enabled when the flag becomes false (`:123`).
- **Trigger:** Open Quick Edit for selection A, immediately open it for selection B, and receive a partial for B while cancellation of A settles.
- **Observed:** Accept becomes enabled while B's promise remains unresolved. See `evidence/workspace-quick-edit-race.mts`. The mocked cancellation resolves `{text:null}`, matching the client's cancellation contract; no model was contacted.
- **Impact:** A partial replacement can be accepted as though generation finished. A late result/error can repaint or change the current edit's state.
- **Confidence:** High, deterministic reproduction of the real panel with only its request boundary mocked.
- **Repair:** Capture session/controller identity in every continuation and partial callback, and ignore results for a replaced or disposed editor session. Keep Accept disabled until the owning request settles successfully.

### W4 — P2: Worktree editor documents lose their scope when calling LSP

- **Evidence:** File reads and saves carry `tab.workspaceRoot` or listing root (`src/ui/file-viewer.ts:943`, `:1354`). LSP extensions and notifications receive only `path` (`:668`, `:781`); `src/lsp/completion-client.ts:145`–155 serializes path/event/text with no root override. The middleware validates and resolves against its request's project root (`server/lsp/middleware.js:48`, `:112`). Electron's default request workspace remains the window workspace, not the selected file-tree worktree (`src/state/view-workspace.ts:1`).
- **Trigger:** Browse a non-main worktree in the same Code window and open a relative-path source file. Alternatively open a presented source file whose absolute path is outside the window's project root.
- **Impact:** The first case syncs/querys the worktree buffer as a main-checkout document, with main-checkout imports/configuration; the second is rejected as outside the project. Hover, definitions, completions, diagnostics and formatting do not reliably describe the same document that file IO displays.
- **Confidence:** High from the complete client→middleware data flow; not validated with a live LSP process. Tool-level per-request root support exists, so this is a UI integration gap rather than an assertion that the whole LSP manager lacks worktree support.
- **Repair:** Carry one validated document root through all LSP lifecycle/query/format calls. Ensure server instance/document URI identity includes the canonical root. Cover two checkouts with the same relative file name and different imported types.

### W5 — P2: Dev server action failures can disappear without an actionable explanation

- **Evidence:** Start, Stop and Restart await API helpers but discard their `{ok,error}` result (`src/ui/dev-server-screen.ts:604`–630); the helpers return JSON without throwing for application failure (`src/config/dev-servers-api.ts:116`). The manager moves an error with no run ID to stopped and saves it only as `lastError` (`server/dev-server/manager.js:277`). Its list projection omits `lastError` (`:534` onward), and idle `error` is derived from startup parse errors (`:493`).
- **Trigger:** Starting a server returns an application error, such as a missing/deleted startup guide or a launch validation failure. A transport rejection follows the same handler's unhandled `void` call path rather than a local recovery UI.
- **Impact:** The user can click Start, see stopped/setup again, and receive no reason or repair action. This breaks the “show me the result” loop for users who depend on chat and preview rather than command-line troubleshooting.
- **Confidence:** High source-verified control flow, not a live UI observation. Existing tests explicitly cover persisted error→stopped migration; they do not make the discarded feedback a satisfactory workflow.
- **Repair:** Check action results, show the specific error beside the server and offer Retry/Edit/Ask chat. Preserve last failure in the list model until acknowledged or superseded by a successful start. Guard pending actions and catch transport failures.

## Design risks and product improvements (not confirmed end-to-end defects)

### R1 — Document identity remains too dependent on a path string

`src/ui/file-viewer-tab-store.ts:85` keys by normalized path alone, and reopening an existing path mutates its root without replacing its baseline/draft (`:377`). A direct API reproduction retains checkout-A's draft while changing its save root to checkout B; see `evidence/workspace-tab-identity-risk.mts`. **The current presented-file caller avoids this by using absolute cross-root paths** (`src/ui/presented-file-cards.ts:26`–34), and normal worktree switches clear tabs. This reproduction is therefore a latent invariant problem, not proof of a current user-facing cross-checkout overwrite.

Related source risks: in-flight viewer loads use only path keys and validate loading status rather than original tab identity (`src/ui/file-viewer.ts:987`–1021); persisted tabs store only paths (`src/ui/file-viewer-tab-store.ts:548`). Use `{canonicalRoot, relativePath}` as document identity for tabs, loading, LSP, recent files and persisted restoration. Preserve the existing absolute-path mitigation until all consumers migrate.

### R2 — Asynchronous editor transformations need the save path's revision discipline

Manual formatting reads the document, awaits LSP, then applies ranges against the current document without verifying its revision (`src/ui/lsp-editor/format-document.ts:18`–28). Deferred completion resolution similarly applies `additionalTextEdits` after typing may have moved those ranges (`src/ui/file-editor-extensions.ts:203` onward). These are source-observed race risks; no live formatter reproduced corruption here. Apply captured edits only to the captured document or map them through intervening changes, and ignore destroyed views.

### R3 — PTY resource ownership needs a deliberate multi-project policy

The cap is eight sessions for the entire host (`server/terminal/pty-host.js:20`, `:132`), while unload intentionally preserves them (`src/ui/terminal-tabs.ts:364`). This can be reasonable, but multiple projects and abandoned views need an inspectable session inventory with source workspace and “stop unused shells.” Do not silently kill useful processes during a reload. The review did not demonstrate an orphan leak across actual Electron window close.

### R4 — Lifecycle idempotency and retry should be audited together

The dev-server manager's existing-running check handles `running`, not `starting` (`server/dev-server/manager.js:619`), and the sampled start path has no per-server start promise/lock. Repeated start requests while health is pending therefore deserve a deterministic concurrent-start test; duplicate spawning was not exercised here. Code boot catches failed steps but subsequently sets `initialized=true` (`src/boot/code-workspace-modules.ts:87`); offer a failed-surface retry rather than requiring a reload. These are follow-up audit items, not claims of observed production outages.

### D1 — Make the running result the natural companion to chat

The core workflow should read: describe change → see progress → inspect running result → point to what should change → see verification. Preserve Code's chat as the anchor. Use preview/result actions as progressive disclosure, with Files, terminal and server detail available for investigation. A compact result panel should identify the relevant checkout, URL, readiness and last verification, and offer “Open result,” “Check it,” and “Send feedback.” This is a product proposal, not a missing-feature defect proven by source alone.

### D2 — Present technical failure as a repairable conversation task

Detect in chat and Send to chat already establish useful patterns. Extend them to a stopped preview, startup failure, browser permission denial, LSP absence and terminal attachment error: explain what happened, keep the user's work, and let a fresh turn investigate with captured logs/scope. Avoid making setup state look like successful completion. Keep logs/code available to users who want them.

### D3 — Use one visible working context across chat and supporting tools

Show which project/checkout the conversation is building and which the result, editor and terminal refer to. Their scopes can legitimately differ; the product should make that difference understandable. Changes in chat selection should preserve drafts and should never silently repurpose a running shell or already-open document.

## Prioritized work

1. **Repair W1 first:** protect drafts during worktree/chat navigation and establish durable scoped draft restoration.
2. **Repair W2/W3:** add ownership tokens to terminal and Quick Edit continuations, with deterministic reversed-completion tests.
3. **Repair W4:** unify document identity across file IO, preview, LSP and saves; retain all existing disk-conflict protections.
4. **Repair W5:** retain actionable server failure messages and put recovery beside the result/initiating action.
5. **Validate R1–R4:** scoped identity/load/formatter races, session inventory and lifecycle idempotency. Do not turn source hypotheses into a broad rewrite without reproduction.
6. **Design D1–D3:** organize supporting tools around the conversational build/result loop, and validate the flow with real users who do not routinely inspect diffs.

## Checks run and outcomes

All reproductions use synthetic strings, mocked requests/DOM or test scratch homes. No live Minnow home, credentials, provider accounts or user shells were accessed.

- Existing UI/state checks: `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --test --test-force-exit --test-timeout=45000 test/file/file-viewer-tab-store.test.mts test/file/file-viewer-external-conflict.test.mts test/ui/terminal-worktree-cwd.test.mts test/ui/preview-tab-store.test.mts test/ui/preview-send-to-chat.test.mts test/ui/workspace-switch-guard.test.mts test/boot/code-workspace-modules.test.mts` — **55 passed**. Boot error logs are intentional assertions. The first exploratory invocation omitted `--experimental-test-module-mocks`, so that boot file failed to initialize; a lingering process was stopped and the corrected bounded run passed. `--test-force-exit` makes no assertion that all background test handles dispose themselves.
- Existing server checks: `node --test test/workspace/dev-server-manager.test.js test/terminal/pty-host-registry.test.mjs test/terminal/graceful-stop.test.mjs test/server/preview-middleware.test.mjs` — **23 passed**, 4 suites. Scratch homes are created by these fixtures.
- `node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-dirty-root-switch.mts` — exit 0, reports `dirtyTabsBefore:1`, `tabsAfterWorktreeRootSwitch:0`, `dialogCount:0`; demonstrates W1.
- `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-quick-edit-race.mts` — exit 0, new request pending while Accept enabled; demonstrates W3.
- `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-terminal-attach-race.mts` — exit 0, latest requested tab B but connection order B→A; demonstrates W2.
- `node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-tab-identity-risk.mts` — exit 0, one tab with B root/A draft; demonstrates R1's API invariant risk, not current end-to-end reachability.

The reproduction assertions intentionally assert the current undesirable behavior so their success documents a bug, rather than claiming the product is correct. No full suite, build, typecheck, performance run or real-model end-to-end test was run in this section.

## Cross-vertical dependencies and unresolved questions

- Session/chat navigation owns when `syncPanelFromActiveChat` runs; fixing W1 needs its cooperation, not just the file tree.
- Workspace-bound views solve many global-root races, but browser/LAN in-place switching and Electron view replacement still need explicit draft/foreground-run continuity contracts.
- LSP and runtime/tool worktree contexts should share the same root validator and identity model. Existing tool-level worktree tests do not prove the editor uses it.
- Git/review owners should inspect whether changed-file and Markdown references from a worktree chat resolve to that chat's checkout. This section traced some callers but did not establish every reference path end to end.
- Native preview lifecycle, agent-browser process cleanup, phone access and packaged availability need the runtime/security and Electron reviewers' findings. The inspected capability origin does not replace those reviews.
- Browser automation has multiple transports (Electron preview and server-owned browser service). Preserve capability-aware tool exposure; ensure chat, headless and board paths describe what each host can actually verify. This review sampled interfaces, not every transport implementation.
- Test success above covers existing intended behavior. It does not resolve the independently reproduced navigation/request ownership defects.
