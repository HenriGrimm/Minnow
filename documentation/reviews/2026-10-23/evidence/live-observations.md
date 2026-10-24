# Live review observations (incremental)

Host: isolated scratch MINNOW_HOME under OS temp; headless Vite/tool server on localhost:19473. Named agent-browser session `minnow-review-01a16bf9`. No live Minnow profile used. Local deterministic fake model server on 18766. Browser-only runtime, not Electron.

## Journeys observed

- First launch: workspace picker behind welcome/setup dialog; appearance -> model source -> local endpoint -> chat model -> optional role routing -> search -> extras -> GitHub check -> tool permissions -> Memory/Brain -> Context7 -> finish. Setup progress reached step 12 of 13. Local stub successfully passed Test connection and appeared in shared model picker.
- No models/runtimes downloaded; deselected memory download and did not connect external accounts or provide keys.
- Context7 step disables Continue without a key; Set up later advances to finish. This is a recoverable product/design barrier, not a total onboarding dead end.
- Selected Ask first. Opening Sandbox immediately triggered list_directory approval from UI file browsing/hub reads. Three further Always allow actions displayed another queued identical list_directory approval. Reload cleared pending queue and fresh file reads respected persisted permission. Source corroboration from chat reviewer: queue drains next previously enqueued prompt before permission update persists; no permission recheck at dequeue. Evidence 08/09. Video attempted but agent-browser recording unavailable because ffmpeg not installed; no video claimed.
- After reload Code hub included composer (Build selected), file tree, chat sidebar, dev-server/code-map/board navigation. A prompt sent through the local stub streamed `Done.`, appeared in history and persisted; this checks plumbing only, not genuine model build ability or task completion quality. The stub also supplies automated chat title, so title `Done` is not reported as a title bug.
- Dashboard empty state: goal input, Plan a goal / Add issue, Continue building in Code. Clear connection to building.
- Issues quick capture created SAN-1, opened detail with Issue/Work/Chat/Activity, worktree and model selection. Opening detail also asked to run `gh --version`; declined. Source reviewer handles logic; no external GitHub operations attempted.
- Reef store and first creation step observed: separate App store / New app mental model, prompt examples, wizard; no build launched (stub cannot validate a real generated app).

## Accessibility checks

Initial tagged agent-browser a11y invocations returned zero passes/inapplicable/violations and are inconclusive (likely comma-argument handling); retained raw files are not used as evidence of accessibility success.

Unfiltered `a11y --json` on settled Code completed with 36 passes, 53 inapplicable, 3 incomplete and 3 violation categories. `a11y-code-all.json` preserves evidence:

- aria-allowed-attr: textarea #msgInput carries unsupported aria-expanded=false.
- color-contrast: .chat-item-model 2.12:1 (9px); #statusMetricPreview 2.82:1 (11px), default dark theme. These are specific rendered states, not a whole-theme compliance finding.
- region: content outside landmarks, including composer; best-practice finding rather than automatic WCAG AA failure.

## Evidence captions

- 01-first-launch.png: welcome.
- 02-permissions-setup.png: actually Pick your chat model (filename retained).
- 03-permissions.png: actually Connect web search (filename retained).
- 04-tool-permissions.png: actual permission selection.
- 05-context7-gate.png: Context7 setup, disabled Continue.
- 06-code-empty.png, 07-code-workspace.png: Code hub with queued permission prompts; do not infer composer absent permanently.
- 08-allow-before.png, 09-allow-after.png: repeated queued Always allow prompts.
- 10-chat-stub-result.png: settled basic chat.
- 11-dashboard-empty.png: goal empty state.
- 12-issue-detail.png: detail and unrelated gh --version permission request.
- 13-reef-store.png, 14-reef-create.png: Reef store/creation.

## Tooling limitations

agent-browser occasionally returned EOF on navigation/reload, then subsequent snapshots succeeded. These are browser automation errors, not classified as Minnow defects. No full accessibility certification, desktop-native automation, GPU serving, real paid-provider generation, or real Reef build has been performed in these observations.

When the review runtime was stopped, its buffered console also contained startup/reload diagnostics: a failed fetch during issue persistence, a changed-without-touchChat warning, a chat.history read before ensureChatHistoryLoaded, and an aborted plugin catalog load during teardown. These were not independently root-caused or reproduced apart from the interrupted navigation sequence. They are retained as follow-up observations, not additional confirmed defects or evidence that the normal settled chat failed.

The root review server on 19473 and deterministic stub on 18766 were stopped at completion; neither port remained listening. The root named browser session closed successfully. Report 11 has separate independent UI evidence and also closed its own session.
