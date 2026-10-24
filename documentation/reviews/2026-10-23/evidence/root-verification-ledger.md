# Primary reviewer's verification ledger

Baseline: ba2068d1c5353f86287f9a02b665fb7ea0bbac3f. This ledger distinguishes independent checks from section reviewer assertions.

## Existing checks

- `npx tsc --noEmit`: exit 0; evidence/typecheck.txt (empty output on success).
- `node test/check-test-coverage.mjs`: pass, 1,773 discoverable files, 1,770 in npm test, 3 excluded. This measures discovery registration, not line/branch coverage.
- `npm run architecture:check`: pass.
- `npx vite build --outDir <review scratch>/dist`: exit 0. This checks the current frontend graph with existing generated inputs; npm prebuild was deliberately not run. No packaged installation claimed. Log: vite-build.txt.
- Fresh scratch build analyzed with repository analyzeDistAssets/evaluateBundleBudgets helpers. Eager hrefs explicitly loaded from the matching scratch dist/index.html rather than analyzer's default existing repo dist. Results in bundle-metrics.json: entry JS 347.8 KB, CSS 769.8 KB, largest lazy JS 3,314.9 KB, eager JS 4,372.3 KB, JS+CSS assets excluding data packs 11,707.2 KB, no breaches. Total ceiling 11,725 KB; 17.8 KB remaining. These are uncompressed sizes, not browser latency measurements.
- Five boot/theme/a11y test files: 83 tests passed; root-boot-a11y-tests.txt. Boot harness tests loader gating, not full Electron cold start. Theme token tests do not disprove rendered component contrast violations.
- Impeccable installed CLI supports detect, not skill reference's outdated flags. Partial scan: src/onboarding, src/os, home-page.ts, settings-page.ts, index.html. Requested composer.ts does not exist and was skipped. 28 advisory findings, 5 warnings. Font warnings judged false positives for a familiar product interface; heading skips require runtime confirmation. Raw output impeccable-scan.json. Not a whole-app scan or objective visual-quality score.

## Independently rerun review reproductions

- chat-context-and-plan-repro.mts: actual concurrent executeTool list crossover B->A, both Plan guards accept traversal, first of two Push now entries lost. Exit 0 asserts current undesirable behavior.
- chat-queue-failure-repro.mts: real adapter/queue with injected failed runner leaves accepted prompt both in history and queue. Exit 0 asserts current undesirable behavior.
- workspace-dirty-root-switch.mts: dirty tab removed, no dialog. Exit 0.
- workspace-terminal-attach-race.mts: latest requested B, sockets connect B then A. Exit 0.
- workspace-quick-edit-race.mts: B pending but Accept enabled after A cancellation. First root invocation omitted experimental module mock flag and failed to start; correct invocation with `--experimental-test-module-mocks` passed. Invocation error is not a Minnow product failure.
- 08-secret-init-race.mjs: 32 synthetic encryptions succeeded, 1 decrypted, 31 failed after concurrent first initialization. Exit 1 is expected bug-detecting assertion, not an existing-suite regression.
- 08-restore-crash.mjs: forced process exit 77; retry false with EPERM on Windows, restored Issues plus old Brain. Expected invariant assertion exit 1.
- 08-revoked-terminal-socket.mjs: invalid credential after revocation, but one input delivered to mocked PTY through an existing real WebSocket. Expected assertion exit 1.
- 09-scheduler-result-and-timeout.mjs: valid 70,078-character result recorded completed without chat link; timed-out fake child retained active slot until manually closed. Expected assertion exit 1.
- 09-corrupt-job-blocks-tick.mjs: corrupt synthetic prompt caused tick failure and zero spawn calls despite a healthy due job. Expected assertion exit 1.
- models-state-repro.mjs: real scratch helpers reproduced lost disjoint config patch, plaintext dummy HF token, skipped corrupt existing model file, and overlapping cooldown incorrectly allowing a request. Exit 0 asserts current behavior.
- upstream-diagnostic-repro.mjs: exact function with filesystem spies retained full sentinel prompt and attempted hardcoded OS-home write without debug opt-in. Zero real writes; exit 0.
- brain-workspace-scope.mjs: actual helper/handler marked B's note stale in favor of A and accepted an origin-less workspace proposal into B. Root reproduction retained synthetic home C:/Users/dukky/AppData/Local/Temp/minnow-review-brain-scope-QXzRn9. Exit 0.
- services-identity-and-tts.mts: MCP delimiter round-trip error, hyphen/underscore emitted-name collision and un-settled canceled start promise. Exit 0.
- reef-recovery-repro.mjs: repeated launch never attempts dependency repair for partial node_modules, composed setup exceeds enqueue limit leaving queued app/no runs, one malformed sibling blocks listApps. Exit 0.
- Actual authenticated isolated HTTP POST /api/tools, modeId plan, save_file path documentation/plans/../../plan-traversal-proof.md: response Saved plan-traversal-proof.md; file confirmed at scratch workspace root. plan-traversal-http.json. Only synthetic review-owned scratch file created.

## Source cross-checks

Read all twelve complete section reports. Traced actual issue Git cwd omissions, premature keyboard ownership overwrite, Dashboard merge request/handler lack of reviewed revision, PR merge freshness fallback and hostless PR review identity; inspected key initialization, diagnostics, MCP dispatcher, proposal acceptance/schema and restore bootstrap continuation. Cross-checked relevant source contracts, not remote GitHub behavior. Full head ordering assumption still needs official/real transport validation; no authenticated external operation was performed. Delivery/security reviewer independently checked the working synthesis and found its evidence qualifications accurate.

## Live UI

See live-observations.md and screenshots. Basic stub chat completed. Initial tagged axe commands had zero checks and are inconclusive; unfiltered Code scan has actual passes and violations. Scheduler editor axe later hung the browser daemon and returned a tool timeout; excluded from accessibility conclusions. Root stopped only its known task-owned hung daemon after verifying process identity. Screenshot 16-code-mobile.png actually captured Settings during a paint transition; exclude it from Code responsive conclusions. No valid root mobile Code visual assessment claimed.

Report 11 supplies separate independent desktop/setup/phone screenshots, raw axe and keyboard-focus observations from its own named session. That reviewer verified four accessibility issues and closed its browser successfully. Those are attributed observations rather than root reproductions. Report 10 records 63 native passing assertions, 21 passing UI assertions and one repeated existing Reef picker expectation failure; do not claim all scoped tests passed.

## Isolation exceptions and cleanup

The review deliberately uses scratch profiles. Models reviewer identified a hardcoded failure-dump path ignoring MINNOW_HOME. A packaged-boundary test already running in another reviewer may have written synthetic fixture request/response diagnostics to real homedir/.minnow/debug. No reviewer read live chats, credentials, or debug payloads. Do not claim all runtime writes were isolated.

Automatic approval review rejected removal of a synthetic Brain fixture directory, with only `rejected: blocked by policy`. Exact target C:/Users/dukky/AppData/Local/Temp/minnow-review-proposal-RqQgIk was inspected and contains synthetic scaffold/Brain fixtures. No retry of recursive deletion; directory retained. This has no effect on review findings.

At completion the root review server/stub were stopped and ports 19473/18766 had no listeners. Root browser minnow-review-01a16bf9 closed successfully after the earlier daemon timeout. All 12 section reports were read and all local Markdown links passed validation. Git status showed only the added documentation/reviews tree; no tracked application files changed. The comprehensive report was queued in a Codex file panel; successful immediate display was not asserted.
