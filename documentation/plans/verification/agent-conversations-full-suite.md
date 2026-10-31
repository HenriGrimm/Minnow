# Full-suite verification — persistent conversations

Date: 2026-10-30. Baseline commit: `0f54bbf5b7b09de2b0627e3d5d509345aa7b72cf`.

The completed four-worker run exited **1**. Seven recorded failures were repaired and verified separately; eleven remain existing-source, environment or non-reproducing failures. Focused repairs below do not turn this full run into a clean pass.

After verification, the task-owned root log files were moved into `.minnow/agent-chat-qa/logs/release-gate/`. Filenames below identify those retained logs; the command shows their original capture location.

```powershell
$env:MINNOW_TEST_CONCURRENCY = '4'
npm test *> .agent-full-suite-c4.log
```

| Runner batch | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Plain Node | 2,389 | 2,381 | 0 | 8 |
| TSX mocks | 1,021 | 1,014 | 2 | 5 |
| TSX loader 1 | 1,993 | 1,991 | 1 | 1 |
| TSX loader 2 | 1,928 | 1,924 | 3 | 1 |
| TSX loader 3 | 2,050 | 2,045 | 4 | 1 |
| TSX loader 4 | 2,255 | 2,243 | 6 | 6 |
| TSX loader 5 | 2,029 | 2,010 | 2 | 17 |
| TSX loader 6 | 105 | 105 | 0 | 0 |
| Node TSX | 28 | 28 | 0 | 0 |
| **Total** | **13,798** | **13,741** | **18** | **39** |

No cancelled tests. A new process-restart test was added after this run's discovery and verified separately; it is not included in these totals.

## Repairs verified after their full-run failures

| Recorded failures | Cause and repair | Follow-up evidence |
|---|---|---|
| `test/chat/pending-mode.test.mts` (1) | Transcript rendering attempted focus capture without a common chat mount. Rendering now returns before DOM work; focus capture is null-safe. | Pending mode + child conversation + request attention: **32/32**, normal exit. |
| `test/electron/runtime-process-log.test.mjs` (1) | Logging fixture omitted the launcher's new preparation builder dependency. An explicit asynchronous builder stub and child readiness assertion preserve launcher/exit/log coverage. | **13/13**. No production build bypass. |
| `test/skills/load-skill-access.test.mts` (1) | Source regex required `load_skill` to be the first allowed tool. The assertion now parses the actual bounded frontmatter allowlist and tests membership. | Combined model/policy/fixture gate: **33/33**. |
| `test/sub-agents/effector-runner.test.mjs` (1) | Newly added `server/runner/server-deps.js` imported product agent configuration inside the pure runner directory. Application binding moved to `server/runtime/server-runner-deps.js`; the purity guard remains intact. | Same **33/33** gate; plain Node bundles **4/4** and typecheck passed. |
| `test/sub-agents/orchestrator-store.test.mts` (1) | Old source-shape assertion prohibited source context needed for durable admission. Behavioral checks now prove pre-abort prevents POST while an accepted child wait survives parent abort. | Same **33/33** gate. |
| `test/tools/install-dom-before-imports.mts` after-hooks (2) | Teardown imported application modules late, triggering unrelated named-export/interop errors. The helper now guards timers after window closure, dispatches `pagehide` and closes Happy DOM without importing app modules. | Actual `loop-resume` + `tavily-integration` consumers **5/5**; wider lifecycle/UI gate **74/74**, normal exit without force-exit or sleeps. |

Two additional issues found in the initial loaded run were fixed before their four-worker batches ran: shared ledger accounting moved to neutral `server/usage/ledger.js` without changing its behavior (**16** runner/canonical usage and **20** frontend ledger/pricing checks passed); the migration tools fixture gained exactly the six new coordination defaults (**18/18** configuration cases passed).

## Existing source and environment failures

For each unchanged-source row below, the audit used `git ls-tree HEAD -- <path>` to confirm the file exists in the baseline and `git diff --quiet HEAD -- <path>` to check the source at that checkpoint. A quiet diff alone is not baseline evidence for a new untracked file. The new server adapter above was explicitly identified as new and repaired. Subsequent TypeScript 7 verification added one `Boolean(exportPanel.hidden)` conversion in the hidden Reef preview callback; that unrelated type compatibility change does not alter the model menu covered by the recorded baseline failure.

| Recorded failures | Evidence and result |
|---|---|
| `test/models/serve-crash.test.mjs` (1) | Fake run `test-run-crash-1` is unknown to the real stop helper. Focused **5/6**, same failure. Fixture, `server/models/serve.js` and `server/terminal-runner.js` exist and are unchanged at HEAD. |
| `test/server/orchestrate-board-testing.test.mjs` (1) | Windows denies creating its file symlink with `EPERM` before endpoint assertions. Fixture and `server/orchestrate/board-testing/{middleware,fake-model-host}.js` exist and are unchanged at HEAD. No symlink checks were weakened. |
| `test/file/file-tree-batch-ops.test.mts` (1) | Existing no-op case expects an `idle` status callback but receives none. Focused reproduction matches. Fixture and `src/ui/file-tree-ops.ts` exist and are unchanged at HEAD. |
| `test/godot/scene-outline.test.mjs` worker (1) | All five assertions pass, then Windows libUV aborts with `UV_HANDLE_CLOSING` under the existing forced-exit runner flags. Focused reproduction matches; without `--test-force-exit`, **5/5** pass and exit normally. Fixture and Godot scene/middleware/resource-path modules exist and are unchanged at HEAD. |
| `test/os/issues-app.test.mts` (1) | Literal CSS expectation for `--issues-peek-cols` differs from the existing stylesheet. Focused **9/10**, same failure. Fixture and `src/styles/issues.css` exist and are unchanged at HEAD. |
| `test/reef/page.test.mts` (1) | Hidden Reef fixture expects three model menu options but finds none. The identical failure reproduces against a separate exact `git archive HEAD` source tree, with a private scratch home and no dependency modifications. Evidence: `.minnow/agent-head-baseline-1793362075637/reef-HEAD.log`. |
| `test/remote/dev-remote-bundle.test.mjs` (1 plus a suite teardown error) | Existing scratch bundle fixtures hit Windows `EPERM` during immediate directory cleanup after stopping the builder. Focused reproduction matches. Fixture and `server/remote/dev-remote-bundle.js` exist and are unchanged at HEAD. |
| `test/remote/dev-remote-filter.test.mjs` (1) | Fixture constructs `/@fsC:\...` using a Windows path; the existing path policy rejects it. Focused reproduction matches. Fixture and `server/remote/dev-remote-filter.js` exist and are unchanged at HEAD. |
| `test/terminal/execute-command-background.test.mjs` (1) | Full run received a non-JSON stop error. The exact case passes **1/1** in isolation. Fixture, terminal runner and `server/dev-server/manager.js` exist and are unchanged at HEAD. Recorded as a non-reproducing full-run failure, not a clean full-suite pass. |
| `test/tools/tool-start-indicator-remount.test.mts` (2) | An existing tools-phase guard suppresses unfinished-argument remount. The first failed assertion leaves a turn open and causes the second timeout. Tracked fixture and stream source were confirmed with `git ls-tree`; the identical pair reproduces in the exact-HEAD archive. Evidence: `.minnow/w7-head-indicator-tap.log`. No production indicator behavior was changed. |

## Initial contention run

`.agent-full-suite.log` retains the earlier default-concurrency-26 run. Its first Node batch recorded six failures and four cancellations, including new workflow deadlines and slow Git setup. The two-child workflow passed at approximately **11.5 s** with four workers after timing out at **30 s** under load; checkout setup fell from **74.7 s** to approximately **11.8 s**. The verified task-owned full-suite process tree was stopped before the bounded rerun; unrelated user processes were untouched.

The exact-HEAD baseline checkout uses ordinary ancestor dependency resolution. No `node_modules` junction was created, no worktree or tracked user file was reset, and no native dependency rebuild was used during test execution.
