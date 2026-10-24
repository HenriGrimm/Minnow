# 09. Scheduler, headless runtime, desktop and operations

Date: 2026-10-23. Baseline: ba2068d1c5353f86287f9a02b665fb7ea0bbac3f. Read-only review with bounded scratch validation.

## Assessment

Scheduled work uses the real headless engine, carries its workspace/model selection, persists chats and is included in both development and installed hosts. Packaging explicitly builds the headless bundle. These are strong foundations.

The operational weakness is outcome supervision: one corrupt prompt can stop every scheduled dispatch; timeout settlement depends indefinitely on a child closing; long valid result JSON can lose its chat link; Run now reports admission only after completion. A chat-led product should make delegated work observable and stoppable from the same assignment/result model as foreground work.

## Scope and boundaries

Read/sampled `server/scheduler/{store,tick,runner,host,headless-entry,workspace,resolve-job-model,delivery,schedule,middleware}.js`; `src/headless/{cli-main,runner,approval,persist-chat,result}.ts`; `src/scheduler/notifications-poll.ts`; `src/ui/scheduler/{scheduler-panel,job-editor-overlay}.ts`; `electron/{main,server-host,trusted-ipc,navigation-policy,window-close-prompt,updater,updater-core}.ts`; `scripts/{electron-builder-run,build-electron,validate-packaged-runtime-files}.mjs`; package scripts and selected tests.

Not exhaustive: every GitHub watcher stage, all Electron IPC payloads, native updater download/signature/install behavior, NSIS/macOS/Linux installations, real-model unattended operations, power-loss behavior or process-tree cancellation on every OS. Existing compiled artifacts were exercised, not freshly rebuilt in this review.

## Good

- **Shared runtime rather than a parallel agent implementation.** Headless calls the shared turn runner, applies mode/tool policy and persists a normal chat using PATCH rather than whole-session replacement (`src/headless/runner.ts`; `persist-chat.ts:27`).
- **Workspace and model capture are explicit.** Scheduler passes workspace, provider/model, chat ID and host credential to its subprocess (`server/scheduler/runner.js:134`). It does not repoint the foreground project's workspace.
- **Admission is bounded and generally releases resources on error.** Tick sorts due work, reserves two slots and lets siblings settle independently (`server/scheduler/tick.js:31`; `runner.js:277`). Preparation/history-failure tests passed.
- **Unattended policy is explicit.** Scheduler supplies the documented automation opt-in and rejects interactive questions; disabled tools remain disabled (`server/scheduler/runner.js:145`; `src/headless/approval.ts:40`). Existing approval tests passed.
- **Installed builds account for real packaging constraints.** The bundle uses an existing directory outside app.asar as cwd (`server/scheduler/headless-entry.js:22`); the packaging wrapper validates runtime files and builds the bundle for every package entry point (`scripts/electron-builder-run.mjs:15`, `:23`).
- **Desktop lifecycle owns active transports.** Server close handles upgraded WebSockets as well as HTTP connections (`electron/server-host.ts:16`); shutdown coordinates model cleanup, renderer state and managed runtimes (`electron/main.ts:703`). Selected shutdown tests passed.
- **Updates preserve meaningful state.** Download-ready state survives later check errors; manual failures are surfaced while routine background failures stay quiet (`electron/updater-core.ts:132`). Reducer tests passed. This does not prove native update installation.

## Findings

### 09-01 [P1] One unreadable scheduled prompt prevents all automatic dispatch

**Evidence:** `listJobs` decrypts every prompt sequentially, without per-row isolation (`server/scheduler/store.js:202`, `:206`; `toPublicJob` at `:73`). Tick calls that public decrypted list before its per-job try/catch (`server/scheduler/tick.js:31`, `:54`). The job-list API uses the same function.

**Trigger:** any stored prompt is corrupt or sealed with an unavailable key. Concurrent key creation in 08-01 is one concrete way to create such records.

**Observed:** with one corrupt synthetic prompt and one healthy due job, runSchedulerTick throws Job prompt is missing or corrupt and makes zero spawn calls.

**Impact:** a single damaged row blocks healthy schedules and the job-list UI needed to diagnose/edit/delete it. Existing preparation-failure tests directly call startStoredJob, bypassing the failing tick/list seam.

**Confidence:** confirmed scratch reproduction.

**Repair:** use a raw metadata list for due-work admission; decrypt one selected job inside its existing failure boundary. Public listing should preserve row identity with an actionable prompt error. Provide repair/delete for unreadable prompts without first decrypting them.

**Reproduce:** `node documentation/reviews/2026-10-23/evidence/09-corrupt-job-blocks-tick.mjs` (expected invariant assertion failure).

### 09-02 [P2] Long valid CLI results lose the persisted conversation link

**Evidence:** scheduler retains only the last 64,000 stdout characters (`server/scheduler/runner.js:41`, `:199`) and then parses from the first remaining opening brace (`:220`). Headless JSON contains unbounded userPrompt/assistantFinal/turn assistantText fields (`src/headless/result.ts:19`, `:48`). A truncated result becomes null; exit zero is still completed (`runner.js:365`), but chatId is recovered only from parsedResult (`:374`).

**Trigger:** successful run emits a final JSON artifact over the capture limit, which can happen with a long prompt/answer or many turns.

**Observed:** a valid synthetic 70,078-character result exits zero and is recorded completed, but its known chatId is missing. No real model ran.

**Impact:** the run can lose its direct path to the persisted transcript, quiet flag, structured failure detail and useful notification summary exactly when the task is large enough to need inspection.

**Confidence:** confirmed runner reproduction using its injected child boundary.

**Repair:** write final results through a separate bounded control channel/file (the CLI already supports a JSON artifact path), keep human logs capped independently, and validate the result schema before treating it as a usable completed outcome.

### 09-03 [P1] A timeout does not guarantee the run settles or releases its slot

**Evidence:** the timer sets timedOut and sends one SIGTERM (`server/scheduler/runner.js:193`), then waits for child close. There is no escalation, process-tree ownership or independent settlement deadline in that promise. The active job ID is removed only after completion's finally (`:426`). Shutdown similarly sends one signal and clears tracking (`:468`).

**Trigger:** a runner or descendant does not exit cleanly, a native/platform process remains alive, or cancellation is stuck in a non-cooperative operation.

**Observed:** an injected non-closing child receives one signal after timeout but keeps one active slot. The reproduction manually emits close afterward so the evidence script itself leaves no work running.

**Impact:** two such jobs can block the entire scheduler indefinitely despite the configured timeout. Descendants may survive terminating only their immediate parent.

**Confidence:** confirmed control-flow/runner-boundary behavior; actual process-tree survival was not tested across OSes.

**Repair:** reuse the managed process-tree cancellation machinery with graceful deadline, force escalation and bounded settlement. Preserve timeout/failure evidence and release admission capacity only after the managed process tree is stopped or clearly quarantined. Cover ignored signals and descendants on supported platforms.

**Reproduce 09-02/03:** `node documentation/reviews/2026-10-23/evidence/09-scheduler-result-and-timeout.mjs`. It prints both observations then fails the chat-link invariant; fake children are explicitly released.

### 09-04 [P2] Run now acknowledges Started after the run has finished

**Evidence:** `POST /api/scheduler/jobs/:id/run` awaits runJobNow (`server/scheduler/middleware.js:143`); runJobNow returns runStoredJob (`runner.js:455`), which awaits the completion promise (`:299`). UI awaits that response before displaying Started and refreshing (`src/ui/scheduler/scheduler-panel.ts:438`). Button disabling reads only the previously fetched job.running (`:434`).

**Trigger:** manually start a long scheduled task.

**Impact:** there is no immediate admission feedback from this action, repeat clicks remain possible before a refresh, and the eventual Started message describes an already-settled run. This undermines confidence in delegated background work.

**Confidence:** high from the direct client/server promise chain; no real ten-minute run was started.

**Repair:** return a durable run ID and admission state promptly, disable locally during submission, and observe run progress/history separately. Use completed/failed/timeout when a terminal result arrives.

### 09-05 [D] Scheduled work needs a first-class stop and result-review path

**Evidence:** job actions are Run now/Edit/History/Delete (`src/ui/scheduler/scheduler-panel.ts:552`). The scheduler API has run-now but no per-run cancel route (`server/scheduler/middleware.js:143`); ordinary job deletion does not terminate its active child (`server/scheduler/store.js:270`). The UI explicitly says schedules pause when Minnow closes, which is useful, but control over a currently running assignment is less clear.

**Impact:** users can delegate tasks but cannot readily intervene through the same conversation/activity interaction they use in Code. Delete/disable can be misunderstood as stopping current work.

**Proposal:** expose Stop current run independently of Pause future runs/Delete schedule, with retained chat/results and a clear interrupted state. Follow the same task ID from scheduling through agent activity, acceptance evidence and any delivery approval.

## Concrete improvements

1. Isolate corrupt jobs so healthy work continues (09-01).
2. Separate stdout logs from machine results and enforce bounded cancellation (09-02/03).
3. Make manual admission asynchronous and observable (09-04).
4. Unify lifecycle controls with foreground delegation (09-05); preserve history on stop.
5. Keep native update/signing tests separate from reducer tests. Add installed-build smoke coverage for real cancel/restart and missing helper/bundle failures without claiming that mocked success proves OS lifecycle behavior.

## Checks actually run

- `test/scheduler/{tick,runner,restart-recovery,headless-entry,unattended-contract}.test.mjs` and `test/headless/packaged-boundary.test.mjs`: **27 passed**. Preexisting compiled host/dist artifacts were present, so the latter imported `test/headless/production-boundary.test.mjs` in packaged mode and ran actual CLI/shared-runner/auth/cancellation/persistence cases against fixture providers. No fresh package/build was produced.
- `test/electron/{navigation-policy,server-host-close,updater-core}.test.mts`, `test/headless/{approval-policy,preflight}.test.mts`: **26 passed**.
- The two saved synthetic scheduler repro scripts intentionally fail the violated invariant. No real child/provider is launched in those scripts.
- Source review of package manifests, bundle construction, updater wiring, Electron shutdown and sandbox configuration. No native update/install, full build or full suite.

**Isolation limitation:** the packaged-boundary suite was already running when another reviewer identified the hardcoded upstream failure-dump path. Its provider-terminal-failure fixture may have written synthetic request/response diagnostics to `~/.minnow/debug/openai-upstream-last-error.json` through `server/generations/upstream.js:53`. Explicit profile state used temporary MINNOW_HOME, but the diagnostic bug bypasses it. No live debug/credential contents were read or deleted. Report 08 records the defect; do not claim all incidental runtime writes were confined to scratch.

## Cross-vertical dependencies

Storage key correctness affects scheduler availability; shared generation cancellation affects timeout cleanup; notification persistence and Code chat identity affect review continuity. GitHub watcher boards also need the issue/board result reconciliation from report 03. Automatic execution should retain a clear permission policy and verification/landing boundary even when no user is watching.

