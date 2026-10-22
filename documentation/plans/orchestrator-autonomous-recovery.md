---
planType: build
---

# Orchestrator autonomous recovery

Status: proposed implementation plan, October 22, 2026. No runtime changes made.

Review: independently checked by a subagent against the current implementation and board audit on October 22. Incorporated first-Start continuation, healthy in-flight preservation, boot discovery/workspace ownership, stale-callback fencing, shared-engine compatibility, snapshot replay, nonisolated workspace protection and repair-directory corrections. This was static verification; implementation and failure-injection tests remain outstanding.

## Product contract

Start a board once. Minnow preserves its progress, recovers from ordinary operational failures, repairs implementation and integration defects, and continues to verified completion. Users should not need to reset tasks, reopen failed boards, reconstruct discarded changes, or fix routine generated-code failures themselves.

Some work genuinely requires a person: signing in, supplying an unavailable reference or device, resolving contradictory requirements, or authorizing additional resources. Present the specific prerequisite once, retain the work, and continue automatically after it is resolved. Do not require a second Start or Retry action. Detect resolution through a bounded check where possible; otherwise the user's answer or “Ready” acknowledgement triggers that check.

This is a reliability target, not a guarantee that every arbitrary specification can be implemented. Exhausted repair budgets must produce a useful diagnosis and preserved work, never a false success or an infinite paid loop. User Stop and Pause always override automatic recovery.

## Evidence and priorities

The parent review and independent subagent verification covered all 20 real project journals, excluding five test journals and 1,700 report-only synthetic directories. At the original capture there were 1,206 ended task attempts: 354 non-pass, including 219 crashes. Fourteen boards had explicit recovery actions. Of 55 distinct tasks ever abandoned, 31 subsequently merged; intervening environment, model or code changes mean this is not a blind-retry success rate.

Three findings make simply increasing retry limits inadequate:

1. Builder failures can discard their checkout before diff evidence is collected. All 25 reviewed builder failures with matching discard events lacked a diff; untracked file contents are not preserved by the current diff collector anyway.
2. Operational errors lose structured metadata between generations and the board. The HTTP classifier misses the actual `Upstream HTTP ...` prefix. Existing quota admission and board quota-stop behavior already cover some cases and must be extended.
3. Completion can coexist with abandoned/skipped planned work. Twenty-seven of 44 final checks failed; eight of 13 latest passing results recorded blocked browser verification. The current final effector additionally passes `browser: false` unconditionally. That current behavior is distinct from the older blocked-rung history.

Other verified gaps: startup failures exist only in memory; tester prompts force unavailable verification into `fail`; builder browser prohibitions conflict with some acceptance requirements; reopened original tasks can be diverted into unrelated final-check repair.

Historical counts span multiple revisions. Reproduce the current behavior before changing each seam; existing report recovery, provider normalization, interruption handling and allowance routing should not be reimplemented.

## Architecture decisions

- Extend the existing server-side V2 engine, journal, pure policy and shared runner. Do not restore the deleted V1 repair controller, add an autonomous supervisor chat, or introduce a second generation/cooldown scheduler.
- Scope board recovery through the board graph/namespace: the generic engine also runs sub-agents and Super Plan. Shared engine changes require regression coverage for those consumers, without enabling board-specific continuation or repair policy for them.
- Keep user intent (`running` versus explicitly stopped/paused) separate from derived execution condition: working, recovering, waiting for a resource, or awaiting action. A recoverable wait leaves the board logically running and releases execution capacity.
- Keep dependency waiting separate from explicit task waiver. An unresolved recoverable task does not abandon its descendants. Unaffected work continues, subject to existing dependency and wave rules.
- Journal completed observations and state changes. The pure core performs no I/O, clock reads, random draws or network calls. Effectors provide observed times and persisted retry deadlines; replay derives counters and decisions from events. Do not fabricate attempt-start events for failures before an attempt started.
- Add a versioned, typed failure/recovery contract rather than more boolean flags or message parsing inside policy. Mirror raw-JS contracts in `.d.ts` and update validators, replay, transport and UI adapters together.
- Retain existing security, tool permissions and selected provider/model policy. Automatic fallback uses only the user's configured eligible model pool. Recovery cannot silently buy capacity, broaden permissions, publish/deploy, waive acceptance, or disable a failing check.
- Treat recovery operations as at-least-once across crashes. Use operation identities and reconcile actual Git/process state before repeating an effect. Exactly-once arbitrary shell/API side effects are not generally available; ambiguous non-idempotent actions require reconciliation rather than blind replay.

### Failure contract and response

Record category, scope (task/provider/account/host), stage, provider/model identity, HTTP/provider code when available, retry/reset deadline, evidence reference, and stable failure fingerprint. Keep the original diagnostic with redaction. Structured data wins; text parsing is a compatibility fallback. Unknown failures remain unknown until diagnosed.

| Observed condition | Automatic response | Budget treatment |
| --- | --- | --- |
| Network error, 5xx, temporary endpoint outage | Shared scoped cooldown, bounded health check, then resume affected work | No code-repair attempt consumed |
| 429 rate limit or quota reset | Respect provider metadata and shared allowance state; wait until eligible, or use an eligible configured fallback | No code-repair attempt consumed |
| Expired login, denied account access, missing executable | Verify prerequisite, attempt supported safe local recovery, otherwise one actionable hold | No repeated generation attempts while unchanged |
| Host CLI slots or aggregate generation memory full | Queue through shared admission; release slots while waiting | No task failure |
| Individual request exceeds memory/context capacity | Compact or rebuild bounded context from preserved progress, then retry | Bounded context-recovery budget; do not merely wait |
| Provider rejects an optional request field | Use shared provider capability normalization; retry only after request changes | Bounded protocol recovery |
| Process disappears, attempt times out, report missing | Reconcile process and side effects, retain checkout, use existing report recovery/continuation | Separate operational budget; escalate repeated fingerprint |
| Reproducible implementation/test failure | Repair existing work against concrete failing acceptance evidence, then retest | Code-repair budget |
| Merge conflict or operational Git failure | Reconcile Git state, repair conflict or specific operational prerequisite, then retry merge | Merge recovery budget; no full rebuild by default |
| Required verifier unavailable | Restore supported verifier or await its prerequisite | Never infer pass or implementation failure |
| Final integrated check fails | Create scoped integration repair, merge, rerun verification | Separate final-repair budget |

Do not classify every 403 as bad credentials or every 429 as quota. Preserve enough evidence to distinguish malformed intermediary responses, account limits and service availability. Parse reset timezones centrally; unknown reset times use bounded probes without inventing a deadline.

## Implementation sequence

### 1. Preserve work before recovery or cleanup

Primary files: `core/policy.js`, `worktree-lifecycle.js`, `effector-runner.js`, `board-graph.js`, `touches.js`, and existing worktree cleanup utilities.

- Make builder failure repair use the existing checkout. Update both policy and seed/worktree allocation semantics; changing `sameWorktree` alone is insufficient if allocation still treats the seed as fresh.
- Cover the supported nonisolated effector path too. Record baseline ownership before work and preserve pre-existing user edits; recovery must not commit, reset, clean or overwrite unrelated workspace changes. When ownership cannot be established, retain the workspace and diagnose instead of applying an automatic restore.
- Stop automatic failed-attempt cleanup. First settle the worker, capture recovery evidence, durably record the result, then decide whether cleanup is permitted. If capture or journal persistence fails, retain the checkout and surface a storage hold.
- Before any recovery path replaces a checkout or deletes its branch, create and validate a recoverable checkpoint. Include committed changes, staged/unstaged tracked changes, deletions, and intended untracked source contents, including binary files. A truncated report diff is not a checkpoint.
- Keep board-local recovery refs/manifests with base SHA and attempt identity. Never publish these refs. Preserve index/worktree distinctions needed to restore faithfully. Exclude generated caches and secrets using existing policies; if unsupported symlink/submodule/ignored-file state cannot be safely captured, retain the original checkout instead of deleting it.
- Reconcile interrupted checkpoint creation on load. Garbage collection must protect active, waiting and unresolved recovery work; only reclaim according to explicit retention policy after verified completion or deliberate disposal. Test orphan reclamation and backup behavior too.
- Define the durable boundary before deleting original work: a successful buffered write alone does not establish power-loss durability. Verify checkpoint contents/manifest and persistence ordering, and exercise backup/restore when recovery refs or Git objects live outside the board directory. On disk-full, permission or journal-write failure, retain work and expose an operational diagnostic even when the journal itself cannot record the hold. Never silently discard a corrupt journal; distinguish a recoverable torn tail from corruption requiring recovery.
- Seed the next attempt with verified checkpoint location, prior summary, remaining acceptance failures and changed paths. Label model-written progress claims as claims.

Acceptance: a failed builder that creates a new file and edits an existing file continues with both intact, including after server restart. Inject failures before/after checkpoint, journal append and cleanup; no boundary loses recoverable work. An explicit Reset/Rewind remains a distinct user operation.

### 2. Preserve failure metadata and record setup failures

Primary files: `server/generations/`, `server/runner/generation-binding.js`, `run-turn.js`, `transient-fetch-retry.js`, `effector-runner.js`, `engine.js`, and core event/type validation.

- Carry structured terminal failure, status, quota and reset metadata through the thrown error, runner result, attempt end and journal. Keep compatibility with plain errors and older records.
- Fix prefixed HTTP parsing and add exact historical-message fixtures, including CLI session limits. Distinguish `GENERATION_MEMORY_LIMIT` request oversize from aggregate pressure.
- Extend existing allowance/admission paths for missing distinctions; keep one authoritative account/provider cooldown source shared with chats and other boards.
- Persist observed preflight/allocation/start failures with stage, operation identity and affected task. Derive the visible failure and backoff from the journal after restart instead of relying on `startFailures` memory.
- Include the first Start endpoint: it currently runs preflight before `startBoard`, so a prerequisite failure leaves no accepted continuation state. After request validation, persist acceptance of Start as an observed user action and establish a held running board if preflight fails recoverably. Return that durable state; prerequisite resolution must not require Start again. Invalid requests and lack of authorization must not start or auto-start a board.
- Deduplicate one causal failure across runner retry, attempt end and scheduler recovery. Give each layer clear retry ownership so nested retries do not multiply requests.

Acceptance: a real-shaped generation terminal failure reaches policy without losing category or reset time. A failed start appears after replay without a fake running attempt. Ordinary chat generation and configured pool fallback remain compatible.

### 3. Add durable waiting and automatic resumption

Primary files: `core/types.d.ts`, event validation, `core/derive.js`, `core/policy.js`, `core/plan.js`, `engine.js`, `resume-gate.js`, and shared admission adapters.

- Add derived recovery/wait/action state and journaled observed holds/resolutions. Store retry eligibility and policy version; derive retry counts from events.
- Use capped exponential backoff with jitter calculated outside the core, respecting provider retry/reset times. Proposed transient probe defaults: 5 seconds initially, cap at 5 minutes; coalesce by failure scope. Known quota reset waits should not repeatedly call generation endpoints.
- When one provider/account fails, hold new attempts using that resource across boards through existing admission. Continue unrelated eligible work. Avoid waking every affected task simultaneously when capacity returns.
- Apply admission holds only to new starts. Preserve healthy in-flight attempts in the desired set: the existing engine stops inspected work omitted from `graph.plan()`. One task's quota/outage must not cancel another task that is streaming, testing or merging successfully.
- Preserve the allowance tracker's single real-request probe at expiry; do not add paid background inference probes. Prefer existing health endpoints and actual eligible work. Define restart persistence for transient rate-limit holds (currently only quota rows are saved), and account for changed login/provider/model identity so stale cooldowns do not hold newly valid work.
- Waits consume neither a worker slot nor implementation-attempt budget. Update dependency propagation so recoverable holds never become automatic skip cascades.
- Automatically resume an action-held task after the prerequisite check passes. No repeat notification while the cause is unchanged. Unknown prerequisite resolution may require a single user answer, never a board rerun.
- On process restart, reconcile leases/process liveness and worktrees before reissuing work. Replace the unconditional boot-resume question for newly started recovery-enabled boards with persisted continuation intent established by Start. Retain the existing gate for legacy boards, explicit pause/stop, and ambiguous external side effects. Closing and reopening the board UI has no scheduling effect.
- Add explicit server boot discovery of eligible board journals; removing the resume prompt alone is insufficient because current engines load on demand. Bind each resumed engine to its recorded workspace and effective tool/security context, independent of the currently selected UI workspace. Missing/moved workspaces become holds, never a fallback to another project's directory. Enforce one active owner for a board before launch.
- Bind delayed probes, action acknowledgements and completions to persisted board-instance/run and recovery generations plus current task/plan/model revisions. Stop, reset, rewind, delete/recreate, waiver, abandonment, task edit, plan resync and model/credential changes must cancel or re-evaluate obsolete recovery. A stale callback cannot resurrect deleted work, overwrite a changed task, or duplicate a repair task. Existing in-memory task-generation checks are insufficient across restart and do not cover every mutation.
- Exhausted operational recovery remains a durable diagnosed hold. Do not convert an indefinite outage into task abandonment. Low-cost resource checks may continue while the board remains running; expensive attempts require a material change or budget eligibility.

Acceptance: a multi-task outage ends without abandonment or skips, then resumes automatically with a bounded number of probes. Repeat with two boards sharing an account, application restart during the wait, and user Stop just before the deadline. Stop/Pause prevents every automatic launch.

### 4. Make repair change strategy and retain acceptance scope

Primary files: `core/policy.js`, `seeds.js`, `resume-digest.js`, `report-tool.js`, builder/tester prompts, and runner continuation limits.

- Use failing test names, diagnostics and remaining acceptance items to direct repair. Preserve original task requirements and the same checkout.
- Track repeated failure fingerprints and observable progress: resolved failing checks or acceptance items, not token count or an assertion that work is nearly done. A changed diff alone is insufficient evidence of improvement.
- Proposed initial policy: two direct corrective attempts; on the same unresolved fingerprint, one focused diagnostic attempt using the existing builder runner; then at most two diagnosis-guided repairs. Missing reports use existing recovery first. A new fingerprint must not reset the total task budget indefinitely.
- Diagnostics must identify the blocked condition and change the repair approach. They may produce an internal prerequisite repair task through existing task events when scope and dependencies are explicit and acyclic. They must not rewrite acceptance or create unlimited subtasks.
- After bounded attempts with no progress, retain work and show what was tried, the remaining defect, and the smallest unresolved decision/resource requirement. The user should not have to rediscover the failure or reconstruct code.
- Add a board-wide limit for active recovery work using existing usage accounting and configured limits; distinguish active execution from time spent waiting. Do not invent reliable dollar accounting for providers that expose none. Bind limits in the live V2 engine rather than assuming legacy Autopilot settings already control it.

Acceptance: repeated identical failures trigger a different diagnostic strategy and eventually a useful hold, without hot-looping. A partial implementation resumes rather than rebuilding. Progress does not erase the cumulative resource limit.

### 5. Make verification executable and truthful

Primary files: plan validation, `effector-runner.js`, `report-tool.js`, builder/tester prompts (full and lite), `final-test.js`, and supported server browser-driver/rung integration.

- Resolve required acceptance checks, commands and capability ownership before spending implementation attempts. Verify referenced prototype/token assets exist in the isolated checkout; stage authorized references through an explicit supported path rather than assuming files in the user's workspace are committed.
- Give required browser checks an owner with supported server-side browser capability. Builders may author tests; the designated verifier executes them and returns evidence. Remove contradictory prompt requirements and the unconditional final `browser: false` in favor of an explicit verification contract.
- Allow tester `blocked` with a typed unmet prerequisite. Reserve `fail` for an observed defect. Report parsing and policy must enforce the same distinction as prompts.
- Mark required checks explicitly. Unsupported required checks hold completion; optional checks may be recorded as not run with a reason. Do not silently downgrade legacy acceptance requirements during migration.
- Associate verification with exact task/integration content identity. Invalidate relevant results after edits, rebases and conflict resolution; the current shortcut from conflict-repair builder pass straight to merge must not reuse stale tester approval.
- Completion requires all required tasks merged (or explicit user waivers recorded) and required verification passing against the current integration SHA. Display a distinct “Completed with waivers” result; unresolved abandoned/skipped work is incomplete.

Acceptance: the Gitbox-style browser requirement executes through the permitted owner. A missing verifier waits rather than cycles builder failures. A final pass cannot mask missing planned work or stale evidence.

### 6. Automatically repair final integration

Primary files: `core/plan.js`, `engine.js`, `seeds.js`, `merge-queue.js`, `board-graph.js`, `final-test.js`.

- Use the existing synthetic integration-fix task mechanism automatically after an actionable final failure. Identify it by failing integration SHA and failure fingerprint so replay cannot duplicate it.
- Keep original unfinished tasks on their original scope. Remove broad injection of previous final failure into unrelated reopened task seeds.
- Give the repair the failing command, diagnostic output, acceptance contract and relevant changed files. Express the reproduction directory relative to the repository and map it into the repair's own task worktree, including nested projects. Keep the integration checkout's absolute path as diagnostic provenance only; do not send the repair outside its isolated workspace. Narrow touches when evidence supports it; preserve merge serialization when broad scope is necessary.
- Test and merge repair work, then rerun the required final ladder on the new integration SHA. Any concurrent integration change invalidates the earlier final result.
- Proposed initial limit: three final repair rounds, with unchanged fingerprints entering diagnosis before consuming more rounds. Infrastructure-blocked final checks use waiting, not the code-repair counter.
- Operational merge failures use targeted Git reconciliation; check whether the merge already completed before retrying. Never reset integration to an older commit as an automatic recovery shortcut.

Acceptance: typecheck failure followed by lint failure triggers distinct repair rounds and finishes without Reopen. A crash after Git merge but before the journal update does not merge twice. Final repair never claims that an unfinished original task is delivered.

### 7. Show useful status and ship with replay compatibility

Primary files: `middleware.js`, `src/orchestrator/client.ts`, board header/cards/detail/report adapters and existing notification/settings surfaces.

- Expose concise conditions such as “Recovering test failure”, “Waiting for provider; resumes at 11pm”, and “Sign in to continue”. Show retained progress, the next action and last useful diagnostic in task details.
- Keep manual Retry/Reset as advanced escape hatches. Normal recovery requires no click. One actionable notification per distinct unresolved cause; ordinary successful recovery belongs in history.
- Add local journal-derived counters: automatic recoveries, manual recovery interventions, wait duration by category, recovery usage, repeated fingerprints, checkpoint failures and completion coverage. Include setup failures so future audits have a complete operational denominator. No new telemetry service.
- Make readers understand new events before enabling writers. Persist policy version on new board starts; migrate existing running/unfinished boards at an explicit continuation boundary. Historical replay must retain historical meaning. Never auto-reopen stopped, archived or completed old boards.
- Bump snapshot format when recovery state changes and compare full-journal replay with snapshot-plus-tail replay. Batched JSONL append is not a transaction: recovery must tolerate a persisted prefix of related events and reconcile the remainder without duplicate work.
- Update programmatic board consumers, including GitHub Watch, alongside the API. A recoverable wait must not become a permanently blocked scheduler job that requires another Retry. Respect user stops and existing publication authorization; require fresh delivery/verification evidence before publishing. Status and completion coverage in generated or mechanical reports must come from authoritative state, not model-written prose. Preserve the existing mechanical report fallback if summary generation fails.
- Roll back recovery policy through a compatible reader/runtime; old binaries that do not understand new events are not a safe rollback path. Preserve checkpoints through any rollback.
- Update architecture and shipped user documentation in the implementation PRs as behavior lands. Audit legacy retry/Autopilot controls so the UI only promises behavior the V2 engine actually honors.

Acceptance: user action clears a verified prerequisite and the board continues without another Start. Reloaded UI reflects the same server state. Old journal fixtures still replay, user waivers remain explicit, and no old board unexpectedly starts.

## Validation and rollout

Build sanitized regression fixtures from the audited failure shapes, not copies of private prompts or transcripts. Use deterministic fake effectors and virtual time for policy/concurrency tests; use real Git scratch repositories for preservation and reconciliation. Test both concurrency 1 and 2+, and more than one board sharing a constrained provider.

Required scenario matrix:

| Scenario | Required result |
| --- | --- |
| Gymnast-shaped repeated 429/503 outage | Shared wait, no retry-budget cascade, automatic recovery |
| Dave-shaped session limit with timezone reset | Correct allowance deadline, no repeated task failures |
| Gitbox/Rancher partial work then builder failure | Existing and newly created files retained; next repair continues |
| Missing CLI, expired login, missing reference | One accurate prerequisite hold, automatic continuation once resolved |
| Aggregate memory/CLI pressure versus oversized request | Queue pressure; compact oversized request; do not confuse them |
| Provider thinking-field rejection / malformed upstream response | Structured diagnosis and changed request or scoped wait |
| Missing report, timeout and vanished process | Reconcile and continue without duplicating active/non-idempotent work |
| Required browser check unavailable | No false pass and no forbidden-builder repair loop |
| Final typecheck then lint failure | Separate automatic integration repairs and fresh full verification |
| Required task unresolved despite final pass | Incomplete status, no successful completion claim |
| Crash during checkpoint/start/merge/hold resolution | Idempotent reconciliation, preserved bytes and no duplicate tasks |
| Stop/Pause during backoff or server restart | No automatic execution until user resumes |
| First Start encounters a recoverable prerequisite failure | Accepted continuation persists; resolution needs no second Start |
| One task enters quota wait while another is healthy | Only new affected starts wait; healthy streaming/testing/merge continues |
| Cold boot with no board UI, or another workspace selected | Eligible boards resume in their recorded workspace with one owner |
| Reset/edit/resync/delete/model change races a delayed callback | Stale recovery cannot launch, overwrite or recreate work |
| Disk full, torn journal batch, bad snapshot or checkpoint restore | Retain work; reconcile valid prefixes; expose unrecoverable corruption |
| GitHub Watch, sub-agent and Super Plan consumers | Wait semantics integrate correctly; no unrelated lifecycle regressions |
| Nonisolated recovery with pre-existing user edits | Unrelated tracked/untracked user work remains unchanged |
| Integration failure from a nested package directory | Repair reproduces inside its own corresponding worktree directory |

Each implementation slice runs its affected suites. Before enabling recovery by default, run `npm run test:orchestrator`, `npm run test:runner`, relevant generation/allowance suites through the repository test runner, `npm run board:scenario-contract`, `npm run test:check-coverage`, and `npx tsc --noEmit`. Run the full suite before merge and document unrelated baseline failures. UI/build changes also require build and performance-budget checks.

The 126 existing engine/policy/seeds/quota tests passed during the audit; they demonstrate the baseline, not the proposed behavior. Add failure-injection tests for the new contracts rather than only updating assertions to match new state names.

Ship preservation first, then metadata and durable waits, then targeted repair/verification, then automatic final repair and the complete user flow. New recovery event readers and minimal truthful status displays must accompany each writer change; step 7 is the final experience/compatibility pass, not permission to leave earlier states invisible. Use an internal policy-version rollout switch, not another user-facing autonomy mode.

Release gates: all transient-failure scenarios finish with zero manual reruns; all prerequisite scenarios continue after one necessary action with zero manual reruns; crash tests lose no recoverable source; no stale/blocked required check yields completion; no retry storm exceeds its admission/probe bounds. Follow with representative live boards under configured resource limits and report actual recovery rate/usage before claiming a production improvement.

## Suggested PR boundaries

1. Preserve failed worktrees and checkpoint before destructive recovery.
2. Structured failures and durable startup diagnostics.
3. Journaled waits, scoped admission and restart-safe continuation.
4. Progress-aware bounded task repair and diagnostic escalation.
5. Verification ownership, capability preflight and truthful completion.
6. Automatic scoped final-integration repair and merge reconciliation.
7. Finish user experience, migration/rollout coverage and operational reporting.

Steps 1–3 are the first delivery milestone: remove routine infrastructure babysitting without losing work. Steps 4–6 address the remaining need to repair code or rerun final checks manually. Step 7 closes the end-to-end release criteria. Shared journal and runner contracts should stabilize before implementation is split into parallel work.
