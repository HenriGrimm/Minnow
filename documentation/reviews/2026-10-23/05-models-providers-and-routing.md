# Models, providers, routing, local runtimes and usage

Review date: 2026-10-23 (America/Los_Angeles). Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Source review with offline/scratch evidence and 156 passing scoped assertions. No real account, model generation, model download or installed-runtime operation was exercised.

## Assessment and coverage

Minnow's intelligence infrastructure is unusually capable for a development workspace: selectable provider/model identities, local-library bindings, native CLI adapters, shared generation replay, pools, quota-aware failover, account usage, model residency and resource estimates all support the same chat engine. That breadth is a strength when it lets a builder keep working after a provider or local model becomes unavailable.

The cost is a substantial configuration and state-management surface. The chat-driven product should make a usable choice easy, make the actual running model and reason for waiting understandable, and preserve user preferences while hiding backend mechanics until needed. This review found concrete defects in diagnostics privacy, model configuration updates, token storage, quota aggregation and existing-artifact verification. None requires replacing the shared transport or pool architecture.

Substantial samples: `server/generations/{upstream,store,memory-limits,allowance,quota-error,fallback}.js`; OpenAI Responses mappings; agent CLI invocation/admission/session/lifecycle/output; provider validation; `server/model-routers/{scheduler,generation,availability,evaluator,library-serve,store}.js`; local serve/admission/context-window/download/Hugging Face paths; `src/models/{selection,launch-selection,fit,routers}.ts`; pricing, usage recording/ledger and Settings usage. Tests additionally exercised synthetic CLI concurrency, model process shutdown and local residency. Protocol implementations were sampled rather than fully audited; real CLI version compatibility, physical GPU behavior, MLX/MTPLX hardware, every provider API and model quality remain unverified. The separate UI review covers live navigation and onboarding.

## Good

- **Provider choice is kept distinct from chat execution.** Composite provider/model identity and remembered choice have an explicit module (`src/models/selection.ts:14`), server revision protection and serialized saves (`:86`). New dispatch refreshes the remembered selection (`src/models/launch-selection.ts:7`); existing chat bindings retain their own identity. This prevents simply viewing another conversation from unexpectedly changing new work's model.
- **Pools are a real scheduling service.** `RouterScheduler` shares active counts and FIFO queues by provider/model identity (`server/model-routers/scheduler.js:4`, `:117`), supports cancellation and idempotent release, and maintains sticky chat choices. The global pool catalog has revision checks (`server/model-routers/store.js:96`), preserving edit conflicts across windows. Library entries wait for local model capacity rather than swapping models under another generation (`server/model-routers/library-serve.js:144`).
- **Quota recovery is shared and avoids background inference.** Allowance state persists opaque identity fingerprints and normalized failure information (`server/generations/allowance.js:105`), limits recovery to one real-request probe, and protects newer refusals from a late success (`:49`). Structured refusals distinguish quota from short backpressure. The overlapping-scope flaw below is a bounded defect in a useful design.
- **Replay and memory limits are explicit.** Generation request/replay/aggregate/subscriber ceilings are centralized (`server/generations/memory-limits.js:2`). Slow consumers can detach without breaking fast ones; terminal states release request bytes. Synthetic tests cover oversized checkpoints, tiny-chunk overhead, active replay eviction, subscriber stalls and canceled generations. This supports reliable chat resumption without unconstrained host RAM use.
- **Native CLIs remain model transports, with Minnow owning tools.** Invocation suppresses native shell/tool paths and passes the allowed tool bridge (`server/generations/agent-cli/invocation.js:78`, `:172`). Native sessions retain protocol state and wait for Minnow tool results instead of creating a second independent agent workspace (`server/generations/agent-cli/session.js:99`). Admission, per-chat locks, process ownership, bounded idle retention and redacted output have explicit implementations. Four fixture tests verified concurrent Claude/Codex/Cursor conversations and returning tools to a warm Codex session.
- **Local runtime behavior anticipates failures.** Model memory estimates include model geometry and KV/compute budgets (`server/models/admit-serve.js:76`); active generations protect residents (`:154`). Served context is divided by parallel slots (`server/models/context-window.js:40`) and measured loaded windows take priority over catalog promises. Shutdown waits for actual child exit and reports failed stops; the scoped fixture confirms that behavior.
- **New downloads have meaningful integrity handling.** Range response validation, truncated-stream detection, linked-etag SHA-256 checks and atomic partial-to-final promotion are present (`server/models/hf-client.js:311`, `:382`, `:391`, `:400`). Download tests cover disk-full recovery, split shards, restart, pause and queue limits. The reuse shortcut below bypasses those protections for existing files.
- **Pool editing has useful recovery affordances.** The scoped picker suite verifies retained failed drafts, stale-save protection, disposal guards, keyboard inspection, unknown saved entry editing and explicit Save/Save & use. Those are important safeguards around a complex optional feature.

## Findings

### MODEL-01 — P1 verified privacy/isolation defect: errors persist full prompts without opting in

**Trigger:** An OpenAI-compatible request receives any non-OK HTTP response, or an HTML error page.

**Evidence:** `server/generations/upstream.js:473` and `:511` call `dumpUpstreamFailure` unconditionally. It writes complete parsed request bodies, including messages and tool schemas, plus raw provider response text (`:53`, `:73`). Its destination is `join(homedir(), '.minnow', 'debug')` (`:55`), ignoring `getMinnowHome()` and `MINNOW_HOME`. There is no `MINNOW_DEBUG` check or redaction, and the write is synchronous (`:63`).

**Verified without a real write:** `evidence/upstream-diagnostic-repro.mjs` extracts the exact function and substitutes filesystem spies plus a fixture OS home. With `MINNOW_DEBUG` absent and a different `MINNOW_HOME`, it attempts to write the full sentinel prompt under the OS-home `.minnow`. This is function-level evidence, not an exercised upstream HTTP integration.

**Impact:** Ordinary provider trouble leaves an additional plaintext copy of private project/conversation content outside expected profile isolation. A scratch-profile test or separate installation can write into the primary profile. This report does not claim headers/API keys are directly logged; the concrete exposure is request content and unredacted provider text. Existing diagnostics can also be overwritten by another profile.

**Confidence:** High.

**Repair:** Make detailed dumps an explicit, short-lived diagnostic action; default to bounded status/category metadata. Use `getMinnowHome`, redact content and provider diagnostics, restrict permissions, and provide deletion/retention rules. Add a regression that errors under an alternate home never touch the OS-home profile. Audit similar dump helpers before expanding upstream error tests. No actual error-path integration test was run here because this defect violates the review's scratch-only contract.

### MODEL-02 — P2 verified defect: simultaneous Models patches lose unrelated settings

**Trigger:** Two windows or independent controls update Models settings concurrently; the same problem can intersect another settings update to `config.json`.

**Evidence:** `patchModelsConfig` reads the whole config, merges a Models patch and writes the whole snapshot (`server/models/models-config.js:25`–`:33`). The read and write each acquire separate locks (`server/config/store.js:203`, `:237`); they do not form one transaction. `updateConfigJson` already supplies that transaction (`:276`).

**Reproduced:** In a fresh scratch home, parallel `patchModelsConfig({reviewFirst:true})` and `patchModelsConfig({reviewSecond:true})` end with only `reviewSecond`. No real model directories or tokens were involved.

**Impact:** Saved model directories, HF token changes or unrelated general preferences can disappear after a concurrent edit. Atomic rename protects file completeness, not read/modify/write semantics.

**Confidence:** High.

**Repair:** Move the read/merge/write into `updateConfigJson('config.json', ...)`. Add parallel disjoint Models patches and Models-versus-General updates to a scratch configuration test. Keep cache invalidation after the successful transaction.

### MODEL-03 — P2 verified confidentiality gap: HF token is stored as plaintext settings

**Trigger:** Save a Hugging Face token through Models settings.

**Evidence:** The route places the raw token in a patch (`server/models/routes.js:399`) and `patchModelsConfig` serializes it directly under `config.json → models.hfToken` (`server/models/models-config.js:32`). The client response masks it (`server/models/routes.js:386`), but the storage path does not encrypt it. `resolveHfTokenAsync` reads that same raw string (`server/models/hf-client.js:29`). A scratch dummy-token write confirms the literal value exists in the file.

**Impact:** The credential is an exception to the manual's statement that API keys are encrypted under `.key` (`documentation/manual/reference/configuration.md:79`). A copied settings file contains this credential. This review makes no claim about an unauthenticated remote read. Backup already tags `config.json` as containing secrets (`server/backup/catalog.js:57`); that is a mitigation and should be preserved.

**Confidence:** High.

**Repair:** Store the token in the existing encrypted secret mechanism, migrate the legacy plaintext field, and expose only configured/masked state. Ensure generic config export and diagnostics do not reintroduce the raw value. Update documentation only if plaintext storage is an intentional supported contract; the preferable repair is consistency with provider credentials.

### MODEL-04 — P2 verified logic defect: an expired broad cooldown masks a live model quota

**Trigger:** A model has a long quota block; a concurrent request or another model later records a shorter provider-wide outage; the outage expires before the model quota.

**Evidence:** `AllowanceTracker.block` returns the first stored row in provider → family → model order (`server/generations/allowance.js:25`). `availability` and `claim` inspect only that row (`:33`, `:41`). They do not intersect all applicable blockers. `allowanceFailure('ECONNREFUSED')` produces a provider-wide temporary outage (`server/generations/quota-error.js:127`), so the overlap can arise through production classifications.

**Reproduced:** Record model quota reset at 100,000; record an `ECONNREFUSED` provider block at time 100; move time to 40,000. Availability reports true and a recovery claim succeeds even though the model quota remains active until 100,000. This uses the real pure tracker and classifier, not a real provider.

**Impact:** A pool or direct request can retry a model still known to be out of usage. A broader block can also hide a narrower live probe. Provider/model/family controls do not compose as promised.

**Confidence:** High for the state-machine behavior; frequency in real simultaneous failures is unknown.

**Repair:** Evaluate all applicable rows and reject if any non-expired block or owned probe prevents admission. Recovery should release only the appropriate scope; successful provider connectivity must not erase a model/family quota. Test all overlapping scope pairs, expiry orders and concurrent probes.

### MODEL-05 — P2 verified recovery defect: any nonempty existing model file is treated as complete

**Trigger:** A previously downloaded final file is truncated/corrupted, or an incomplete file appears at the final path; the user retries downloading it.

**Evidence:** `streamHfUrlToFile` immediately returns success for any nonzero destination size (`server/models/hf-client.js:293`–`:298`), before fetching remote size or checking its hash. Its otherwise robust integrity checks apply only to the partial-file transfer path (`:382`, `:391`).

**Reproduced:** A scratch `corrupt.gguf` containing three bytes `BAD` is passed to the real exported `downloadHfFile`, with network disabled and a fixture token. It returns `{bytesReceived:3,totalBytes:3}` and leaves the corrupt bytes untouched. No model was downloaded or loaded.

**Impact:** Re-downloading can report success without repairing the artifact that causes the model to fail loading. An existing final filename is being used as evidence of integrity. The same helper serves MLX snapshot files.

**Confidence:** High for helper behavior; the exact UI path to “download again” depends on existing job/artifact state.

**Repair:** Retain a verified artifact manifest with expected revision, size and digest, or provide an explicit Verify/Repair path that checks existing files before reusing them. Do not require hashing every large model on every normal launch. Test a nonempty truncated final file, same-size corruption, stale upstream revisions and mixed valid/corrupt split shards.

### MODEL-06 — P2 display limitation: cost totals erase whether pricing was known

**Evidence:** Missing pricing intentionally yields null cost (`src/usage/pricing.ts:129`); ledger totals add null as zero (`src/usage/token-ledger.ts:100`) and retain no priced/unpriced coverage count (`src/usage/types.ts:47`). Settings renders that rollup as Estimated cost with a dollar value (`src/ui/settings-usage.ts:89`). Individual recent entries correctly show “Not priced” (`:250`). Provider pricing also accepts a currency string (`src/usage/pricing.ts:25`) while downstream recording and formatting use USD fields unconditionally (`src/usage/record-chat-usage.ts:42`; `src/usage/token-ledger.ts:88`).

**Trigger/impact:** Unpriced hosted/CLI usage can produce a $0 total or an incomplete subtotal with no summary indication. An API-configured non-USD pricing block can be labeled as dollars. This is not evidence of a provider billing error; it is incomplete accounting presented with excessive certainty. Cache-write/cache-read pricing is also outside the current two-rate schema.

**Confidence:** High from source; no real bill or currency conversion was tested.

**Repair:** Track known cost plus unpriced request/token counts and show coverage next to totals. Label estimates and native reported cost separately. Restrict manual rates to USD or preserve currency through the ledger. Keep free local inference distinguishable from unknown hosted cost. Add coverage for mixed priced/unpriced sessions.

## Prioritized improvements and decisions

1. Repair diagnostic privacy/profile isolation first, then transactional Models settings, HF secret migration and compositional quota admission. Add targeted regressions at each existing boundary.
2. Add an artifact Verify/Repair flow that uses existing digest logic. The user should recover from a model load failure without deleting files manually or repeatedly downloading a model that is silently reused.
3. Make the model chip the dependable answer to “what is doing my work?”: current bound model/provider, pool assignment, reason for loading/waiting/rerouting, and an actionable next step. Preserve the explicit runtime events already emitted by pools (`server/model-routers/generation.js:33`), rather than surfacing implementation names as unexplained statuses.
4. **Product decision:** keep pools and local load tuning optional. First-use chat should need a usable model choice, not comprehension of evaluator models, tiers, concurrency, library aliases and runtime variants. Advanced scheduling remains valuable behind progressive controls.
5. **Design risk:** evaluator decisions see a clipped current user request plus a short previous request (`server/model-routers/evaluator.js:95`), and confidence can be self-reported. The pure tests prove schema/routing behavior, not that the correct model is chosen for real build work. Evaluate difficult short follow-ups, attachments and post-compaction requests with outcome/latency/cost evidence. Explain manual override and reevaluation in the chat surface.
6. **Operational limitation:** CLI protocols and local backend behavior change outside Minnow. Synthetic conformance is necessary but cannot certify installed CLI versions or GPU drivers. Maintain a small explicit compatibility matrix and opt-in real-provider smoke procedure. Claude interactive sessions expressly reject a dollar budget (`server/generations/agent-cli/invocation.js:216`); the UI should make that compatibility choice clear rather than presenting a setting that later blocks normal chat.
7. Keep performance estimates honest: architecture-aware memory calculations are a strong aid, while predicted fit/throughput cannot promise real hardware latency. Prefer confidence/measurement provenance and observed load diagnostics over silently expanding tuning knobs.

## Checks and evidence

**156/156 scoped assertions passed**, with `--test-force-exit --test-timeout=45000` and a temporary `MINNOW_HOME`:

- 50: router scheduler; allowance; generation memory/backpressure; Responses map/SSE; synthetic agent-CLI concurrency/output; model shutdown; provider base URL validation.
- 74: download/download-fault fixtures; context-window resolution; model memory calculations; library binding; evaluator logic; synthetic local residency.
- 32: pricing/token ledger and pool picker (using `--import tsx --import ./test/test-loader.mjs`).

Exact files: `test/model-routers/scheduler.test.mjs`, `test/generations/{allowance,memory-budgets,store-backpressure,openai-responses-map,openai-responses-sse,agent-cli-concurrency,agent-cli-output}.test.{mjs,js}` (each existing filename), `test/models/{serve-shutdown,download,download-faults,context-window,memory-model,serve-residency}.test.mjs`, `test/providers/validate-base-url.test.mjs`, `test/model-routers/{library-serve,evaluator}.test.mjs`, `test/usage/{pricing,token-ledger}.test.mjs`, and `test/ui/model-pool-picker.test.mts`.

Reproduction commands:

```powershell
node documentation/reviews/2026-10-23/evidence/models-state-repro.mjs
node documentation/reviews/2026-10-23/evidence/upstream-diagnostic-repro.mjs
```

The first creates and removes a fresh temporary profile, uses only dummy credentials and disables network. It reproduces MODEL-02 through MODEL-05. The second uses filesystem spies around the exact diagnostic function; no file is written. These scripts assert defective current behavior and are review evidence, not shipped regression tests.

No full suite/build, dependency installation, upstream error integration, real account query, model download, real CLI invocation or actual GPU serving occurred. Tests that could call the unconditional dump were intentionally excluded. Tests with synthetic child processes use isolated fixture homes. Passing tests show the exercised boundaries work; they do not establish complete vendor/hardware compatibility.

## Cross-vertical follow-through

- Runtime/security should include the plaintext HF exception and diagnostics outside `MINNOW_HOME` in its storage review. Backup's secret-tagged settings handling already mitigates plaintext backup export and must remain intact.
- Chat's immutable context/acceptance repairs should preserve captured provider/model identity and surface actual pool assignments, not make the remembered default race active work.
- Scheduler, boards and Reef should consume the same allowance and loaded-window resolution, with their own understandable terminal recovery states.
- Models configuration should use the same transactional updater as other settings to avoid clobbering unrelated General changes.
- Real-model build quality, model recommendations and the usability of the full Models app need a separate live/benchmark session; this report offers no universal model recommendation or whole-product performance score.
