# Reef: generated apps, delivery lifecycle and product placement

Review date: 2026-10-23 (America/Los_Angeles). Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Read-only source and synthetic/scratch review. No real app generation, installation, browser download, native export, cloud repository or provider operation was performed.

## Assessment

Reef is a constrained **personal utility factory and app library** built on Minnow's shared intelligence and chat execution. It accepts an idea, chooses defaults, plans and builds in separate agent contexts, verifies the result, promotes a release, runs it, and can package it as an independent desktop app. Its distinctive feature is the managed artifact lifecycle, not the absence of a visible code editor.

That distinction matters after the user's clarification: **Minnow itself is already a chat-driven builder**. “Reef is for people who do not code” is therefore not a sufficient reason to split it out. The meaningful question is whether users are trying to develop a project with an ongoing workspace, or acquire and maintain a small local app with a managed runtime and export lifecycle.

Implementation quality and placement are separate. The source contains substantial real orchestration, checkpoint/recovery and isolation work; Reef is not merely an alternate chat skin. Its simplification also comes with a narrow generated-app contract, reduced opportunities to steer, and a separate shelf/build/preview mental model. The user's feeling that it works inside Minnow but feels out of place is consistent with those differences. This review does not assume extraction is the answer.

## Scope and evidence limits

Substantial samples: all major `server/reef/` lifecycle modules (store, supervisor, pipeline, agent, tool policy, process, activity/events, runtime/runtime host, toolchain, browser verifier, exports and Electron wrapper); headless Reef policy hooks; `src/reef` setup/activity/types/client; source for the Reef page/chat/preview and their shared-model integration; backup catalog and synthetic tests.

Tests exercised scripted build/retry/recovery, cancellation/process behavior, synthetic provider preflight, bridge tool restrictions, local HTTP runtime origin/capability checks, export identity/configuration, backup planning, UI state, preview lifecycle and streaming. They did not establish that a real model can successfully produce arbitrary apps, that exported binaries work on every platform, or that the visual quality of generated apps meets the user's intent. The opt-in real pipeline/export test was deliberately not run.

The root review's live observations cover the store and first creation step only (`evidence/live-observations.md:14`, screenshots 13/14). Those are secondary evidence here; this reviewer did not operate that browser session.

## Good

1. **The build pipeline owns delivery instead of trusting a final message.** Scaffold → separate Planner → Builder → install → TypeScript → node tests → Vite build → browser scenarios → release promotion are explicit host stages (`server/reef/pipeline.js:183`–`:240`). The main repository advances only after checks; failed revisions preserve access to the previous release. This is a useful pattern for Minnow's wider chat-driven outcome handoff.
2. **Recovery is more developed than a generic Retry button.** Checkpoints retain phase, plan, source tree, commit and retry/repair/continuation counters (`server/reef/pipeline.js:114`, `:160`). Resume keeps partial files; phase reset returns to a saved phase entry; full reset starts from the last verified repository while retaining history. User Stop is distinct from host interruption (`server/reef/supervisor.js:159`), and repeated host restarts eventually require manual Resume. Native tests exercised all these paths with synthetic dependencies.
3. **Autonomy has meaningful bounds and failure classification.** Provider sign-in/quota/missing-model issues stop for the user (`server/reef/pipeline.js:67`); temporary failures use backoff; verification failures spend a separate repair budget (`:258`). Context exhaustion can continue in fresh Builder chats before verification directs the next step (`:246`). Stall detection, the run deadline and retained counters prevent a restart from silently granting an endless budget.
4. **Reef reuses the shared spine without taking over Code.** `runAgent` launches the same headless runner, persists ordinary chats and releases its own native CLI sessions (`server/reef/agent.js:13`, `:40`). Each fresh stage reads the app's latest model binding. The Reef composer registers as a scoped surface (`src/ui/reef-chat.ts:49`) while leaving Code's active chat/draft alone; the scoped UI test verifies this. Open in Code is an explicit transition rather than a hidden workspace switch.
5. **The source-tool boundary is deliberate.** Agents receive a small allowlist; Planner/chat are read-only and Builder receives scoped source writes (`server/reef/tool-policy.js:2`). Headless dispatch enforces the phase allowlist and protected paths (`src/headless/execute-tool.ts:151`). Native CLI providers return permitted calls through the same bridge; synthetic CLI-provider tests cover plan/build/chat restrictions.
6. **Preview separation is concrete.** Each runtime listens on a separate loopback port with an app capability path, checks Host/Origin, restricts static paths and sends CSP/referrer headers (`server/reef/runtime-host.mjs:15`). The UI uses an isolated native guest or separate-origin iframe, retains interaction state across view changes and disposes late guests (`src/ui/reef-preview.ts:51`, `:70`). The Electron export disables renderer Node integration and enables context isolation/sandbox (`server/reef/electron-wrapper.cjs:38`). These are valuable browser/renderer boundaries; they are not an OS sandbox for generated backend/test code.
7. **Export and backup have thoughtful ownership rules.** Export captures a verified release and excludes app data, logs, `.env`, credentials-related files and internal history (`server/reef/exports.js:15`). Cloud export requires explicit upload consent and a private repository (`:178`); its synthetic test checks exact-commit workflows and retry without force push. App identity persists across rename, while independent apps get separate user-data directories. Reef backups require a passphrase and omit reproducible dependencies/toolchains/worktrees; the native core test verifies source/data preservation.
8. **The simplified surface retains useful detail.** Plain-language activity separates stage/headline from raw logs (`src/reef/activity.ts:88`); live agent thoughts/tool calls are available behind disclosures; progress has accessible status text; prior verified output remains previewable after a failed revision. Creation retains draft answers during navigation. These are substantial UX choices, not merely decoration.

## Findings

### REEF-01 — P2 verified recovery defect: a partial dependency directory prevents repair on launch

**Trigger:** Runtime dependencies are omitted by restore, installation begins but fails and leaves `node_modules`, or a release's dependency directory is incomplete.

**Evidence:** `launch` reinstalls dependencies only when `fs.access(root/node_modules)` fails (`server/reef/runtime.js:45`). Any existing directory is taken as success, even if required packages are absent. Failed runtime startup does not invalidate that assumption (`:47`).

**Reproduced:** A scratch verified release contains an empty `node_modules` and a backend importing a deliberately missing fixture package. Two calls to the real `launchApp` both fail before readiness. A fixture npm script would mark any install attempt; no install is attempted. Only a synthetic Node child is started; no package or model is downloaded.

**Impact:** The intended Run app retry does not repair a partially restored/broken installation. Someone using Reef as a managed app library can remain stuck without deleting an internal dependency directory manually.

**Confidence:** High. The exact partial-restore scenario was simulated rather than produced by an actual failed network install.

**Repair:** Treat dependency installation as a transaction with a successful lockfile/release marker; detect absent required production packages and provide bounded repair. Keep immutable release source and app data intact. Add an install-interruption/relaunch test using only fixture packages.

### REEF-02 — P2 verified fault-containment defect: one bad app record blocks the whole library

**Trigger:** A Reef app directory has missing or malformed `app.json`, for example after an interrupted first write or external corruption.

**Evidence:** `listApps` awaits `readApp` for every matching directory and lets any failure reject the entire result (`server/reef/store.js:75`, `:83`). Both the library API (`server/reef/middleware.js:100`) and supervisor startup/draining (`server/reef/supervisor.js:22`, `:132`) depend on it. Atomic replacement helps protect an existing file but does not ensure that every directory always contains a valid first record.

**Reproduced:** Add a malformed sibling record beside two valid scratch apps; real `listApps()` rejects with `SyntaxError` rather than returning the valid apps.

**Impact:** A single damaged utility can hide all other utilities and prevent queued work from being discovered. The product currently has no per-record recovery result at this boundary.

**Confidence:** High for library rejection; supervisor disruption is a direct source consequence, not a live-host observation.

**Repair:** Validate records individually, quarantine/report unreadable records and continue listing healthy apps. Show a recoverable damaged-app row or explicit diagnostics rather than silently discarding it. Test missing, truncated and unsupported-version records beside healthy apps; startup should remain useful.

### REEF-03 — P2 verified admission defect: valid setup fields can create a permanently queued empty app

**Trigger:** A long idea approaches the allowed 16,000 characters and the user also supplies a name/look.

**Evidence:** `createApp` accepts a 16k idea, 100-character name and 4k look independently (`server/reef/store.js:87`, `:92`, `:101`). `initialBuildRequest` combines them (`:106`), then `createRun` imposes the original 16k limit on the combined prompt (`server/reef/supervisor.js:60`). The API persists the app before enqueueing (`server/reef/middleware.js:104`–`:105`).

**Reproduced:** A valid 16,000-character idea plus a short name/look produces a 16,122-character build prompt. Enqueue rejects. The app is already saved as `queued` with zero runs; there is no run ID to cancel/resume. No supervisor build was allowed to start.

**Impact:** Creation returns an error after leaving an unusable library item, and retrying can create additional orphan records. The user complied with the setup's individual field limits.

**Confidence:** High for store/composition/admission chain. Full middleware preflight was not run; the source shows its ordering.

**Repair:** Validate the fully composed request before app persistence, use separate structured setup fields or a larger explicit internal prompt budget, and make creation-plus-initial-run admission transactional/idempotent. A client error should not leave an app falsely labeled as in line.

### REEF-04 — P2 scaling risk: live updates repeatedly move all historical build data

**Evidence:** Each activity batch updates the full app record every 200ms (`server/reef/activity.js:17`, `:33`), and `updateApp` reads/serializes the whole record (`server/reef/store.js:67`). Each run's displayed agent history is capped at roughly 512k (`server/reef/agent-stream.js:71`), but `runs`, `exports`, `messages` and `chatIds` have no app-level retention or pagination in the sampled store. Both list and detail APIs return those full objects (`server/reef/middleware.js:100`, `:112`). Detail events can trigger a full GET every 200ms (`src/ui/reef-page.ts:657`, `:674`); coalescing prevents overlapping requests but not the full-history payload.

**Trigger/impact:** Repeated revisions to the same app increase disk serialization, JSON parsing and live network payload with all prior runs, even while old transcripts are closed. This is a source-proven growth pattern, **not a measured performance-budget breach**. It matters for a long-lived personal-app shelf and phone access.

**Confidence:** High for the data shape; practical slowdown remains unmeasured.

**Improvement:** Return slim shelf summaries and a latest-run snapshot/delta; fetch historical runs/transcripts on demand. Retain the actual ordinary agent chats as the durable detail source. Benchmark a revision-heavy app and many-app library before choosing retention limits.

## Verification and operating limits: design assessments

- **“Verified” currently means the generated checks passed.** The host owns the harness and enforces test/scenario structure, which is good. The same Builder still supplies the tests and expected browser results. `checkProject` requires at least one test file (`server/reef/pipeline.js:30`), and the browser harness requires an interaction and text assertion (`server/reef/verify-browser.mjs:13`), but neither proves coverage of the user's actual requirements. A trivial click plus unchanged heading can satisfy that shape. Treat this as an outcome-quality limitation rather than alleging a broken harness. Show a plain-language acceptance checklist derived independently from the request and the observed check results; allow the person to try the result and report a mismatch.
- **Generated code is trusted local code.** The source-tool restriction and clean process environment reduce accidental tool/secret exposure. Host-controlled npm/test/build/backend execution still runs generated JavaScript with the user's OS privileges (`server/reef/pipeline.js:216`; `server/reef/runtime-host.mjs:10`). A renderer sandbox does not change that. This is an architecture constraint, not a demonstrated escape in this review. Match onboarding/product claims to that boundary and coordinate any real containment work with the runtime review.
- **Steering is intentionally unavailable while a build runs.** Chat is hidden/paused and the server refuses another app conversation during a nonterminal run (`src/ui/reef-chat.ts:23`; `server/reef/supervisor.js:184`). This protects a simple pipeline but forces someone with a correction to cancel or wait. For a chat-driven product, evaluate a clearly labeled queued change or “apply at the next safe stage” mechanism. Do not silently inject changes into a phase already being verified.
- **The capability contract is narrower than the creation prompt implies.** Pure JS/WASM, relative local APIs, no native modules/external services/credentials are explicit in the agent contract/template README (`server/reef/pipeline.js:16`; `server/reef/template/README.md:22`). The creation flow mostly says “one clear job” (`src/ui/reef-page.ts:156`). Surface a short useful boundary before committing a user to a potentially long build, especially for connector/account-dependent ideas.
- **Cloud export cancellation needs an explicit contract.** Host shutdown aborts local export controllers (`server/reef/exports.js:17`), but the sampled GitHub path watches a remotely dispatched workflow and contains no remote cancellation (`:158`). No cloud operation was run. Decide whether leaving/stopping Minnow should leave that job running, and communicate the chosen behavior with an accessible workflow link. Do not equate stopping a local watcher with canceling a remote build.

## Product placement options

| Option | What the user experiences | What should remain shared | Main tradeoff |
|---|---|---|---|
| **Focused app inside Minnow** | Reef remains a distinct “make and keep a small app” destination, with a clear route back to Code for deeper work. | Models, credentials, shared runner/tools, saved chats, backups, runtime ownership. | Lowest implementation disruption; needs clearer naming, scope and navigation so it feels intentional. |
| **Separate launcher/experience on the same local service** | A simpler Reef window or launcher can open directly to the app shelf/create/preview flow. Minnow remains available when needed. | The same backend execution, profiles, generation/usage, checkpoints and export service. | Tests whether product separation helps without duplicating the engine; cross-window/process ownership and authentication need a precise contract. |
| **Standalone distribution using shared packages** | Reef installs, starts, updates and manages its own app library independently. | Reusable engine/protocol/policy packages, not a forked tool loop. | Largest operational cost: model setup, secrets, upgrades, support, backups and runtime downloads become an independent product obligation. |

**Recommendation:** Keep the shared execution architecture and validate a distinct entry experience before committing to a standalone distribution. First articulate the boundary as **managed personal utilities versus ongoing project development**. Do not frame it as “Reef for noncoders; Minnow for coders,” because that conflicts with the agreed chat-first direction.

There is also a convergence opportunity: Code can learn Reef's outcome-first preview, visible verification and recoverable delivery without inheriting Reef's narrow template. Reef can learn Code's conversational correction flow without exposing the full workspace. Shared components and protocols are compatible with different navigation, visual tone and distribution decisions.

Useful product validation questions are whether people return to **use** their created apps, whether they request services/credentials beyond the template, whether they ever need Open in Code, and whether an independent launcher improves discovery and repeat use. These decide placement more reliably than the current dock position alone. No telemetry or scheduling work is authorized by this review.

## Checks actually run

1. **63/63 native synthetic assertions passed:**

   ```powershell
   node --test-force-exit --test-timeout=45000 --test test/reef/core.test.mjs test/reef/autonomy.test.mjs test/reef/recovery.test.mjs test/reef/export-identity.test.mjs test/reef/agent-stream.test.mjs test/reef/cli-provider.test.mjs
   ```

   Tests create scratch homes. Host commands/agents/install/browser operations are fixtures where appropriate; local runtime HTTP and synthetic Node-child cancellation are real. A cleanup-time ENOENT log from a supervisor finishing after its temporary test home was removed appeared after successful assertions; no product defect is inferred from that teardown race.

2. **21 UI assertions passed; 1 failed** across setup, page, preview, scoped chat, exports, live stream, agent stream and activity:

   ```powershell
   node --import tsx --import ./test/test-loader.mjs --test-force-exit --test-timeout=45000 --test test/reef/setup.test.mts test/reef/page.test.mts test/reef/preview.test.mts test/reef/chat.test.mts test/reef/export-view.test.mts test/reef/live-stream.test.mts test/reef/agent-stream-view.test.mts test/reef/activity.test.mts
   ```

   Rerunning `test/reef/page.test.mts` reproduced the failure at line 116: it expects all provider/model option rows immediately after opening the shared picker. Current `src/ui/model-provider-browser.ts:129`–`:163` intentionally waits for provider activation and initially renders the provider browser. This is stale test/interaction-contract evidence, not proof that Reef cannot select CLI models. Update the test to navigate the shared provider browser before asserting/picking models. The remainder of that first test after its failed assertion was not exercised; its separate recovery test passed.

3. **Offline recovery evidence passed:**

   ```powershell
   node documentation/reviews/2026-10-23/evidence/reef-recovery-repro.mjs
   ```

   It demonstrates REEF-01 through REEF-03 using a fresh temporary home, a fixture backend and an intentionally stopped supervisor. It disables network, performs no installation/export/inference, and removes only its own scratch tree.

The opt-in `test/reef/pipeline.test.mjs` was not run because it performs real npm/browser/toolchain/export operations. CLI session tests that could inspect native account state were also excluded. No full suite, build, real generated app or native package was produced.

## Prioritized follow-through

Repair dependency-launch recovery, per-record corruption containment and atomic creation/admission first. Align the stale picker test with the shared interaction contract. Then slim live data transport and make supported utility scope/verification evidence understandable. Treat placement as a user-journey decision after those reliability fixes, preserving the shared runner, model bindings, checkpoint logic and explicit Open in Code boundary throughout.
