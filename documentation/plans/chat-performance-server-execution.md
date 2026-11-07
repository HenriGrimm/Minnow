---
name: chat-performance-server-execution
planType: build
overview: Reduce chat latency, migrate ordinary conversations to Minnow's existing server execution service, and add an opt-in Codex native coding tools experiment without weakening permissions or recovery.
---

# Chat performance, server execution, and Codex native coding tools

Implementation status (2026-11-07): **partial, rollout gates not passed**. See [implementation evidence](chat-performance-implementation-evidence.md), [ordinary-chat parity and recovery](../contributor/chat-server-execution-rollout.md), and [native capability evidence](chat-performance-native-report.md). Ordinary automatic promotion and native coding remain disabled. Unchecked acceptance items below are not claims of delivery.

## Goal and scope

User decision: do not transplant T3 Code's chat system. Improve Minnow's own shared runner and existing server-owned conversation service. Competitor implementations are references, not dependencies. This plan is implementation work, not a claim that changes have shipped.

Deliver all latency recommendations, move ordinary chat execution to the server, and add a default-off switch under Models → CLIs → Codex for native coding tools. Keep Minnow tools for integrations and providers without native coding support. Do not introduce a third execution engine, a second authoritative transcript, or a new UI framework.

Planning evidence was gathered on November 7, 2026. Recheck affected code and test commands before each implementation step because the checkout may advance.

## Evidence and sources

- Ordinary renderer turns await pre-snapshot at `src/chat/run-turn-chat.ts:1509` and post-snapshot at `:2132`. `src/chat/turn-snapshots.ts:26` skips board/orchestrate/worktree cases but not General.
- Actual `server/git/git-ops.js:snapshotCreate` took 1832/1858/1860 ms using isolated Git index/object writes on the Windows checkout. This is component timing, not an end-to-end benchmark or a guaranteed 3.7-second saving.
- `src/tools/client.ts:220` unconditionally fetches plugins; ordinary round refresh awaits it at `src/chat/run-turn-chat.ts:1813`. MCP already uses revision-driven caching in `src/mcp/tool-cache.ts`.
- Among 80 recently updated chats, 48 retained runner timings. Configuration refresh averaged 118.6 ms over 2431 events. Intervals overlap; do not sum them or call model-round time pure inference. These timers omit some renderer preflight.
- Source-extracted dirty-tracking functions from `src/state/sessions.ts:304` took 33–37 ms on a 2544-row, 12.57-million-character stored chat. This was a Node probe, not a renderer profile. The 6 ms loop budget cannot interrupt one synchronous serialization/hash.
- Existing sessions already reconcile DB rows incrementally; existing streaming uses coalescing and incremental Markdown. Preserve these improvements rather than solving historical versions of the problems.
- Persistent execution already exists in `server/chats/runtime.js`, `service.js`, `execution-host.js`, `transcript-store.js`, and `repository.js`. It uses the shared `server/runner/run-turn.js`.
- Persistent tool checking and ordinary dispatch can both call `context.resolveTarget` (`server/chats/runtime.js:162,173`), which rebuilds Git/worktree membership in `server/chats/context.js:33`.
- Current Codex transport disables native tools, starts in a private home, rejects native execution items/approval requests, and checkpoints only the currently supported conversation shape. Settings updates currently dispose provider sessions before validation/save.
- OpenCode reference: https://github.com/anomalyco/opencode/blob/fdce6365bcdf2af0fdac65d46dc1806a75d10b02/packages/core/src/session/runner/step.ts — overlaps initial snapshot and request but still waits at safety/settlement boundaries.
- T3 reference only: https://github.com/pingdotgg/t3code/blob/e455200077ce60806a01c8f28435b58860dcfc74/docs/internals/overview.md — separates provider completion from checkpoint settlement and uses scoped projections.
- Official Codex protocol read during planning: https://developers.openai.com/codex/app-server — bidirectional approvals, native items, thread/turn lifecycle, sandbox parameters, and version-specific schema generation. Exact installed-version flags and enforceability remain implementation gates, not assumed contracts.

## Decisions and constraints

1. One fenced execution owner per chat. SQLite/server records own accepted commands, canonical transcript, requests, side-effect intents/results and completion.
2. Renderer owns drafts, selection, painting and connected-host capabilities. Closing it does not cancel server-capable work. Browser/clipboard or other genuine host tools may explicitly wait for a capable host.
3. Receipt means admitted, not executed. Lost acknowledgements retry identical identities; reconnect does not resubmit work.
4. Never replay an uncertain write or shell invocation. Preserve recovery-required states and stale-owner rejection.
5. Security decisions intersect captured ceilings with current restrictions. Cache discovery, not stale grants. Human-authorized mode changes affect subsequent executions; active work never gains authority silently.
6. Snapshot safety includes concurrent chats sharing a checkout, user edits, branch changes, symlinks and staged/unstaged separation. Faster scheduling is not permission to lose rollback correctness.
7. Provider-finished, transcript-durable, checkpoint-finalized and execution-idle are separate milestones. Final prose can be visible while finalization runs; a subsequent mutation cannot race its required checkpoint.
8. No full-history renderer serialization or hashing on routine managed-chat streaming/metadata updates. No per-token database writes.
9. Optional enrichment has a real deadline including cold initialization. Required attachment/context failures are explicit, not silently omitted.
10. Codex native-tool opt-in does not widen filesystem, network, shell, mode, child or account authority. Unsupported enforcement fails closed.

## Relevant files

Primary boundaries: `src/chat/messaging.ts`, `managed-chat-client.ts`, `managed-chat-bridge.ts`, `run-turn-chat.ts`; `src/state/sessions.ts`; `server/chats/{service,runtime,preparation,execution-host,repository,transcript-store,context,policy}.js`; `server/runner/run-turn.js`; `server/git/git-ops.js`; `server/generations/codex-app-server/{manager,pump,conversation,translate,rpc}.js`; `server/providers/{store,validate}.js`; `server/models/agent-cli-middleware.js`; `src/ui/models/cli-panel.ts`. Each step below identifies its additional files and verification boundary.

## Target flow

Composer → durable shell/attachments → validated send intent → server admission and receipt → workspace preparation → shared prompt/model preparation → shared runner/provider adapter → scoped durable events and live presentation → renderer projection.

Snapshot capture overlaps safe model preparation/request where possible. Minnow-executed mutations await baseline readiness. Native execution must await baseline before starting a native turn unless a verified pre-action admission barrier provides the same guarantee.

The server persists settled messages/actions and bounded recovery state. The renderer subscribes through the existing managed bridge and shared transport, never writes canonical transcript snapshots back.

## Implementation steps

### 1. Establish latency instrumentation and regression fixtures
- [ ] Capture a reproducible baseline before optimization.
- Changes: Extend bounded payload-free timing across composer submission, admission, worktree/setup, enrichment, snapshot, provider queue/session initialization, request dispatch, first provider delta, first paint, native/external tool admission/execution/return, final prose, durable transcript and checkpoint settlement. Use correlation IDs and monotonic local durations; do not subtract uncalibrated browser/server clocks. Separate nested spans, model wait, human wait and host wait.
- **Touches:** `server/runner/timing.js`, `server/chats/execution-host.js`, `server/generations/codex-app-server/pump.js`, `src/chat/run-turn-chat.ts`, existing timing presentation/diagnostics.
- Verify: Deterministic fake provider and fake CLI scripts, delayed snapshot/plugin/embedding dependencies, long synthetic histories, 1/4 concurrent chats and clean/dirty scratch repositories. No live user data in fixtures or exported metrics.
- **Accept:** One report distinguishes dispatch latency, received-to-painted delay, tool overhead and durable idle without double-counting. Timings cannot block generation or expose content/secrets.

### 2. Make catalogs and discovery revision-driven
- [ ] Remove unchanged plugin inventory HTTP work from every round.
- Changes: Reuse MCP's cache/invalidation pattern for plugin definitions. Add opaque revisions, single-flight reload, explicit refresh, reconnect reconciliation, invalidation on install/remove/enable/config/handler changes, and bounded abortable reads. Failures remain explicit; stale definitions cannot authorize disabled tools.
- Changes: Share expensive settings/prompt/tool discovery by revision in server preparation. Avoid repeatedly reading every work-agent prompt for unchanged policy checks.
- **Touches:** `src/tools/client.ts`, `src/mcp/tool-cache.ts`, `server/tools/loader.js`, `server/plugins/`, `server/chats/preparation.js`.
- Verify: Repeated unchanged rounds perform zero additional catalog requests/discovery; concurrent callers share one refresh; changes and reconnect invalidate; revoked tools remain denied; failed refresh does not cause retry storms.
- **Accept:** Ordinary and persistent paths use the same freshness semantics, with no new permission cache.

### 3. Reduce repeated authority reconstruction safely
- [ ] Avoid duplicate full worktree scans per ordinary server tool.
- Changes: Split immutable execution identity, expensive project-registry discovery, and current authorization. Pass a validated, revision-bound context through check/dispatch instead of recomputing the same registry twice. Coalesce discovery; invalidate on registered worktree/config changes and verify target canonical identity at dispatch. Define behavior for external Git changes, replaced directories, junctions and watcher loss; uncertain identity requires revalidation, never trust a cached lexical path.
- **Touches:** `server/chats/context.js`, `runtime.js`, `execution-host.js`, `policy.js`, worktree registry/allowlist.
- Verify: Count Git invocations over repeated calls; revoke permissions between check and dispatch; remove/replace checkout, change registration, race approval with revocation and run concurrent chats.
- **Accept:** Cheap unchanged calls avoid duplicate scans while all existing authorization/escape tests remain effective.

### 4. Bound and parallelize preparation
- [ ] Prevent optional enrichment from hanging dispatch.
- Changes: Parallelize independent settings/memory/code-map/document work with bounded concurrency and deterministic assembly order. Share cold embedding initialization without letting one caller cancellation poison shared initialization. Apply an overall enrichment deadline covering initialization/download and embedding queries; cancel/discard late results. Keep actual required attachments and explicitly required context failures blocking and actionable.
- Changes: Preserve first-turn injection/replay behavior, stable CLI prompt prefixes and exact selected model/options. Keep utility titles and nonessential indexing off dispatch's critical path. Register host/browser runtime lazily when safe, retaining guide delivery and ownership.
- **Touches:** `src/chat/prompts/compose-context.ts`, `src/headless/chat-preparation.ts`, `server/chats/preparation.js`, `server/engine/retrieve.js`, `embeddings.js`, `src/tools/agent-browser-runtime.ts`.
- Verify: Hung cold initialization, optional failure, required missing document, cancel/retry, shared initialization, deterministic prompt equality and no late injection into the next turn.
- **Accept:** Optional enrichment completes or reports omission within its configured total budget; required data is never silently dropped.

### 5. Extract safe shared checkpoint coordination
- [ ] Remove unconditional pre-dispatch snapshot waits where execution semantics permit.
- Changes: Move turn snapshot lifecycle into a server/shared service used by the migration path, retaining a compatibility adapter during rollout. Start baseline capture concurrently with model request when all mutations are interceptable; gate mutating/unknown tools, shell and host effects before execution. A native turn with autonomous mutations must wait before turn/start unless protocol tests prove a safe earlier barrier.
- Changes: Cache repository initialization and reusable index stat state without modifying the user's index. Benchmark unchanged captures and changed-file discovery. Reuse a baseline only with validated workspace/HEAD/index/content identity; watcher notifications alone are not proof of unchanged files. Retain untracked-file coverage; do not copy competitor file-size exclusions silently.
- Changes: Separate provider-finished from finalization. Serialize conflicting checkpoint/mutation boundaries across the same canonical checkout; use existing mutation coordination where applicable. Capture final state before releasing the relevant mutation barrier. Keep patches lazy, but retain data needed for replay/undo.
- **Touches:** `src/chat/turn-snapshots.ts`, `server/git/git-ops.js`, `server/git/action-run-lock.js`, `server/chats/execution-host.js`, run metadata.
- Verify: Slow capture overlaps request; no write precedes baseline; two chats and next queued turn cannot contaminate checkpoints; external edits/branch switch, staged files, untracked files, crash/cancel and failed capture are handled explicitly.
- **Accept:** Demonstrate reduced pre-dispatch latency on the original Windows fixture, correct rollback and unchanged real Git index. No promised fixed millisecond saving.

### 6. Define canonical ordinary-chat admission and feature parity
- [ ] Prepare ordinary chats for server ownership before flipping routing.
- Changes: Extend existing validated command intent with ordinary per-turn skills, attachment/reference metadata, issue/code-map context and programmatic send options. Do not accept arbitrary trusted system prompts from clients. Persist shell/attachment references before acknowledgement; retain drafts on definite failure and stable request IDs on uncertain acknowledgement.
- Changes: Move deferred worktree creation/dependency setup into server preparation, bind the verified final checkout before inference and preserve Retry/Back to Local behavior. Never silently execute in the wrong checkout.
- Changes: Reuse Node-safe prompt composition for slash/pinned skills, UI Designer, rules, links, first-turn/replayed context, sampler/thinking, pools/local model loading, title/issue integration and goal/loop seeds.
- **Touches:** `server/chats/contracts.js`, `service.js`, `preparation.js`, `src/headless/chat-preparation.ts`, `src/chat/managed-chat-client.ts`, `messaging.ts`, `src/state/chat-worktree.ts`.
- Verify: Golden renderer/server preparation fixtures; attachment-only send, rejected size/image fallback, slash-local command versus real send, issue seed, queued options, setup failure/reload and duplicate receipt.
- **Accept:** A documented parity checklist has passing coverage for all ordinary send entry points before promotion.

### 7. Add canonical replay, fork and human configuration
- [ ] Preserve workflows currently blocked for managed history.
- Changes: Add server-owned revision-checked fork/edit/replay commands. Preserve immutable branch lineage, snapshots, actual model options, attachments and atomic call/result groups. Do not lift local-history guards and mutate canonical arrays.
- Changes: Allow explicit human Plan→Build and model changes through authenticated configuration for future turns; preserve active captured ceilings and narrower child profiles. Handle create-chat-with-mode via an authorized command/host interaction rather than silently widening an existing execution.
- **Touches:** `src/chat/fork-from-run.ts`, `history-truncate.ts`, `src/state/chat-relationships.ts`, `server/chats/middleware.js`, `service.js`, `repository.js`, `runtime.js`.
- Verify: Stale revisions, fork at tool boundary, interrupted write, replay into different model, legacy branch fixtures, simultaneous edits and active-turn mode change.
- **Accept:** Replay/fork remain usable after migration, without replaying side effects merely to reconstruct history.

### 8. Route ordinary execution to the existing server host
- [ ] Make the renderer a command/projection client.
- Changes: Add explicit ordinary-chat server capability separate from agent-creation gating. Route new eligible roots through managed admission, then promote idle existing roots after durable reconciliation. Never take over a live renderer lease/generation. Reuse managed bridge, requests, host capabilities, Stop/queue/steer, completion delivery and canonical transcript store.
- Changes: Preserve selected-chat output versus project summaries, multi-window drafts, paired-device observer restrictions and host-tool indeterminate receipts. Server-only work continues with the renderer closed; missing host capability appears as waiting, not an invisible stall.
- Changes: Protect canonical transcript fields from generic session saves. Unsupported server/storage versions get an explicit compatibility state; no automatic fallback after server admission.
- **Touches:** `src/chat/messaging.ts`, `remote-chat-client.ts`, `managed-chat-client.ts`, `managed-chat-bridge.ts`, `host-capabilities.ts`, `stop-generation.ts`, `server/chats/feature.js`, `service.js`, `runtime.js`.
- Verify: Reload/close renderer during reasoning/tool/approval, server restart, two sends/windows, late Stop, queue/steer, parent completion, host disconnect and mixed-version clients.
- **Accept:** Exactly one owner and transcript, no renderer model/tool loop for promoted roots, no duplicate sends/effects/accounting. Depends on steps 2–7.

### 9. Eliminate full-chat save/hash work and bound presentation
- [ ] Make routine UI work proportional to changed entities.
- Changes: Managed renderer saves contain only editable presentation/draft fields, not transcript/run detail. Track per-entity revisions and acknowledge only the versions saved; edits to B must not force resending A. For necessary legacy compatibility use changed-message operations and preserve conflict recovery.
- Changes: Remove production whole-chat hashing from routine saves; retain targeted bounded diagnostics off the interaction path. A worker is not a substitute if every update still clones megabytes.
- Changes: Reuse shared streaming/Markdown scheduler; bound batch bytes and counts, preserve terminal/error/approval ordering and flush final text. Keep inactive/hidden heavy output unsubscribed. Profile long prose, code blocks and expanded reasoning before adding virtualization or parser workers.
- **Touches:** `src/state/sessions.ts`, `src/config/api-client.ts`, `server/config/sessions-repo.js`, `server/chats/transcript-store.js`, presentation/managed bridge, shared Markdown/painter.
- Verify: Long synthetic chats, metadata-only save, concurrent dirty epochs, conflict/reconnect, slow subscriber, final flush, hidden chats and typing during fast streams.
- **Accept:** No transcript-sized stringify/hash on managed metadata saves; settled messages survive restart; unchanged rows retain identity; no regression in existing incremental DB writes.

### 10. Verify Codex native capabilities and permission feasibility
- [ ] Establish the supported native protocol before exposing a switch.
- Changes: Record supported CLI version(s), generate/inspect matching app-server schemas in an isolated fixture, and implement a capability matrix for native commands/read/search/file edits, sandbox/network boundaries, approvals, events and resume. Verify actual Windows enforcement and private credential isolation.
- **Policy:** Native coding means read/search/command/edit only in the supported scope. Native browser, arbitrary plugins/hooks, native subagents, image generation and other capabilities stay disabled unless separately authorized/designed. Keep Minnow-specific tools available.
- **Policy:** Opt-in is a preference, not a grant. Require enforceable intersection with current mode/tool/FS/shell ceilings. Native shell can perform file writes, so checking only the shell's label is insufficient. If per-tool Ask/Off or path restrictions cannot be represented before action, disable that native capability or block the native run with an explicit explanation. Never use unrestricted sandbox/approval settings as a workaround.
- **Policy:** Plan native execution remains read-only; allowed plan-document writes continue through guarded Minnow tools. Dynamic-only/tool-choice-none utility requests cannot acquire native capabilities.
- **Accept:** A reviewed matrix proves permitted actions work and prohibited actions fail before effects. Unknown versions/methods fail closed. Approval notifications that arrive after execution are not an enforcement mechanism.

- Verify: Exercise the generated-version protocol fixture against real supported CLI installs in scratch workspaces. Assert native read/edit/command approvals precede effects where required, Plan writes and out-of-scope/network access are denied, and unknown requests or insufficient sandbox enforcement prevent activation.

### 11. Implement native action admission, events and recovery
- [ ] Integrate native actions without creating fake executable tool calls.
- Changes: Add trusted native execution policy from server admission to the Codex adapter. Separate real workspace cwd from isolated CODEX_HOME. Preserve user credential isolation; do not inherit ambient hooks/MCP/features that widen authority. Capture native mode, policy/schema/capability version and workspace in session/checkpoint fingerprints.
- Changes: Bridge supported approval requests to durable Minnow questions/approvals with exact execution/request identity, bounded arguments and revocation checks. Deny unknown/escalating decisions. Prevent action until baseline readiness; when native full-authority actions cannot be intercepted, establish durable turn-level mutation intent before launch and retain conservative uncertainty on crash.
- Changes: Persist stable native thread/turn/item action records, progress, terminal output, failures and code changes. Observational native events must never be dispatched as Minnow calls. Keep mixed dynamic calls paired/deduplicated, cumulative and request usage separate, and prevent failover after potentially executed effects.
- Changes: Resume only verified compatible native histories. Rebuild/fork/provider-switch projection must preserve completed action context without rerunning actions. If faithful reconstruction cannot be proved, offer explicit recovery rather than silent continuation.
- **Touches:** `server/generations/codex-app-server/{manager,pump,conversation,translate,rpc}.js`, `server/generations/agent-cli/checkpoints.js`, `server/chats/{execution-host,requests,transcript-store}.js`, shared transcript/event declarations.
- Verify: Native read/edit/test in scratch workspace; denied/approved/cancelled actions; duplicate/late items; crash before/after action/receipt; tampered checkpoints; native↔Minnow switch; mixed calls; no duplicate mutation; secret redaction.
- **Accept:** Native coding is usable with observable actions and equivalent enforced ceilings on supported configurations, otherwise clearly unavailable. Depends on steps 5, 8, 10.

### 12. Add the Codex CLI experiment switch and comparison data
- [ ] Expose the working experiment, default off.
- Changes: Proposed Codex-only boolean `agentCli.nativeCodingTools`, omitted=false. Validate boolean type and reject enabling on other CLI kinds. Thread through provider storage allowlists/status/types/client.
- **UI:** Reuse existing `createSettingsSwitch` in `src/ui/models/cli-panel.ts`. Label: “Use Codex native coding tools (experimental)”. Hint: “Let Codex run supported coding tools directly. Minnow permissions still apply. Changes apply to newly submitted turns.” Show effective unavailable/limited reasons, saving/error state and keyboard-accessible label/description. Keep existing tokens and icon conventions.
- **Lifecycle:** Validate and save before invalidating compatible idle sessions. Do not dispose active/waiting runs when changing this preference. Accepted queued turns retain their captured choice; newly submitted turns use the new choice. Policy revocation still takes effect immediately. Turning off prevents new native admissions, not silently interrupts current work.
- **Comparison:** Record requested/effective tool mode, CLI/model/effort, capability exclusions, handoff count and timings per run. No silent fallback that contaminates A/B measurements. Do not auto-enable or auto-run paid comparisons.
- **Touches:** `server/providers/{validate,store}.js`, `server/models/agent-cli-middleware.js`, `src/providers/types.ts`, `src/models/agent-clis.ts`, `src/ui/models/cli-panel.ts`.
- Verify: Default off, invalid values, unrelated settings preservation, non-Codex rejection, active/queued lifecycle, persistence/reload, unavailable platform, prompt/tool catalog mode changes and UI failure rollback.
- **Accept:** User can deliberately compare supported native and Minnow-tool turns without changing global permissions. Depends on steps 10–11; no inert shipped toggle.

### 13. Optimize native checkpoint/session overhead without weakening verification
- [ ] Address long native histories and cold session churn.
- Changes: Measure Codex full thread reads/digests and Claude snapshot polling separately from provider time. Coalesce duplicate checkpoint requests, reuse verified unchanged data where provable, use supported incremental/paged reads where available, and bound retained data and deadlines. Retain fingerprint invalidation, canonical prefix validation, credential-change handling and late-event ownership.
- Changes: Separate UI “provider finished” from native checkpoint finalization. Background only work that is not needed for durable acknowledgement/restart safety; serialize continuation where necessary.
- **Touches:** `server/generations/codex-app-server/manager.js`, `agent-cli/{session,claude-state,checkpoints,lifecycle}.js`.
- Verify: Large native transcript, delayed native commit, concurrent sessions, restart/tamper, timeout/cancel, account change and no clean checkpoint claimed before verification.
- **Accept:** Reduced measured checkpoint work or bounded failure with no weakened replay guarantees; report remaining unavoidable waits.

### 14. Cross-platform verification, rollout and legacy retirement
- [ ] Enable server execution only after parity and recovery gates pass.
- Changes: Roll out new roots first, then idle existing roots after reconciliation. Preserve backup/restore and old transcript reading. Rollback disables new promotions/native admissions; already canonical chats stay server-owned and readable. Never downgrade them into competing renderer writers.
- Changes: Remove redundant renderer execution/preparation hot paths after all supported entry points migrate; retain explicit historical/unsupported-runtime compatibility only where documented. Boards/Scheduler retain shared runner contracts, not a new loop.
- Verify: Existing affected suites in `test/chat`, `test/chats`, `test/config`, `test/state`, `test/remote`, `test/generations`, `test/models`, `test/ui`, plus headless bundle, backup, Scheduler/board integration. Extend fake Codex fixture and existing app-server tests. Use repository-supported runners; direct node tests include --test-force-exit. Run typecheck, full tests, production/headless builds, coverage discovery and performance budgets after focused suites. Record pre-existing failures separately.
- Verify: Actual packaged Electron on Windows, macOS and Linux; no dependency on dev tsx/source assets. Native capability support is platform-specific and documented, not inferred from mocked tests.
- **Docs:** Update architecture/context, shipped manual, settings explanations and migration/recovery docs only with implemented behavior; add release notes and benchmark report.
- **Accept:** Feature parity checklist complete, security/recovery tests pass, measurable improvements published, unsupported native cases explicit, no unfinished replacement runner.

## Performance acceptance and experiment design

Deterministic operation-count and ordering gates are mandatory; hardware timings are measured on a declared reference machine with warmup and repeated runs.

- Warm unchanged catalog: zero refresh HTTP/discovery per model round.
- Delayed 2-second snapshot fixture: external-tool provider request starts before snapshot finishes, but no mutation does; native mutation-capable turn starts only after baseline unless a verified admission barrier exists.
- Managed metadata save size/CPU does not scale with historical transcript bytes. Synthetic 10/100/2500-message fixtures demonstrate this.
- No chat-save/hash task above 50 ms in the long-chat reference renderer profile; target p95 composer input response below 100 ms under four scripted streams. Treat targets as release goals, not current results.
- Target p95 first-received-delta to first-paint below 100 ms on the local reference setup; report cold renderer/provider cases separately.
- Optional enrichment stays within its configured end-to-end deadline, including initialization; Stop remains responsive during every wait.
- Compare native off/on with identical CLI version, model/effort, prompt, workspace seed, permissions and cold/warm status. Fresh matched scratch checkouts avoid mutation contamination. Report tool calls, safety exclusions, dispatch/paint/handoff/finalization and outcome correctness; do not claim faster from one stochastic paid run.
- Retain all correctness assertions even if a budget improves. If safe native execution cannot be enforced on a platform/version, ship it unavailable there with reasons rather than weaken policy.


## Rollback and non-goals

No T3 transplant or new framework. No deletion of user history or automatic Git cleanup. No broad native feature enablement, unsafe shell mode, bypassing approvals, or copying upstream permission assumptions. No fallback to renderer execution after server admission. No automatic retry of indeterminate native or Minnow mutations.

Milestone rollback uses capability gates and compatible schema readers; captures and canonical histories remain intact. Use scratch homes for destructive recovery tests. Implementation must not alter live settings to demonstrate the new switch without explicit user action.

## Acceptance checklist

All fourteen steps have recorded evidence, server ownership is the default for supported ordinary chats, prior workflows still work, the native coding switch is functional and default-off with honest capability reporting, and benchmark results distinguish actual improvements from remaining provider/host waits.

- [ ] Ordinary supported chats execute on the server and survive renderer closure without duplicate actions.
- [ ] Fork, replay, attachments, skills, worktrees, approvals, queues and remote clients pass parity tests.
- [ ] Catalog, preparation, snapshot, persistence and rendering performance gates have measured evidence.
- [ ] Codex native coding tools are opt-in, policy-safe, observable and restart-safe on documented supported configurations.
- [ ] Cross-platform/package, rollback, backup and privacy checks pass; remaining unsupported cases are disclosed.

## Risks and open questions

- Installed Codex version/platform may not offer pre-execution admission for every native operation. Step 10 must prove the enforceable capability set; this blocks activation, not the server migration.
- Native unrestricted reads, shell-based writes, ambient hooks and network access can defeat narrower per-tool policies. Disable unrepresentable capabilities; never use prompt instructions as enforcement.
- Snapshot overlap/reuse must account for user edits and other chats in the same checkout. Filesystem watchers alone cannot certify a reusable baseline.
- Canonical fork/replay and ordinary skill/worktree preparation are migration blockers; resolve them before broad promotion.
- New phase timings may reveal other dominant costs. Reprioritize optimizations based on evidence without dropping any security, migration or native-tool acceptance gate.
- Performance targets require calibration on declared reference hardware; source comparisons are not end-to-end benchmark results.
