# Codex 0.166.0 native effects: Windows enforcement follow-up

Date: 2026-11-07. This supersedes the earlier report's **not exercised** statements for the Windows cases below. It does not complete steps 10–12 or establish a native-on product configuration.

## Environment and reproducible command

- Installed `codex-cli 0.166.0`, Windows x64 (`Windows 10.0.26300` reported by the app-server), Node 24.19.0. MXC is available on this host; no sandbox setup was performed.
- Generated-version schema digests match the earlier [native report](chat-performance-native-report.md). The effect fixture pins the initialization version; it fails rather than certifying an unknown CLI.
- Inference is a scripted **loopback fake Responses** server, not an actual model or paid account. Model identifier `gpt-5.5` selects the installed CLI's native tool metadata, not a paid inference call. Commands, edits and approvals are executed by the **real installed app-server**.
- Every process uses a scratch `CODEX_HOME`, `HOME`, `USERPROFILE` and workspace. Fixture-only marker files stand in for private data. No real auth is copied; no provider keys, proxy settings, hooks, plugins or live settings are inherited. Windows runtime paths remain available for starting MXC. Private-home isolation is measured, not inferred from changing `HOME`.
- All attempted filesystem effects are confined to fixture-owned scratch roots, including the deliberately disallowed sibling directory. The network negative and positive controls use a second local HTTP listener. No external network request, administrator action, local-user creation, global permission change or live sandbox setup is used.

```bat
set MINNOW_CODEX_NATIVE_ENFORCEMENT=1&& set MINNOW_CODEX_APP_SERVER_SMOKE=1&& set MINNOW_CODEX_SCHEMA_SMOKE=1&& node --test --test-force-exit test/generations/agent-cli-native-enforcement.test.mjs test/generations/agent-cli-codex-app-server-live.test.mjs test/generations/agent-cli-native-capabilities.test.mjs
```

Effect fixtures: `test/fixtures/codex-native-enforcement.mjs` and `test/generations/agent-cli-native-enforcement.test.mjs`. Normal CI discovers these tests but skips installed Windows probes without the explicit flag. An opted-in host without working MXC fails the probe; it does not silently skip or fall back to an unrestricted implementation.

## Actual effect matrix

Official references fetched during this follow-up: [app-server protocol and generated schemas](https://developers.openai.com/codex/app-server), [Windows sandbox implementations](https://developers.openai.com/codex/windows), [sandbox and approval semantics](https://developers.openai.com/codex/sandbox), and [named permission profile configuration](https://developers.openai.com/codex/config-reference). These sources guided the probes; observed installed behavior, not current documentation alone, determines the matrix.

| Attempt | Before-effect policy | Observed result |
| --- | --- | --- |
| `command/exec` workspace write with `sandboxPolicy: { type: 'readOnly', networkAccess: false }`, no explicit Windows sandbox | Protocol policy only | **Write succeeded** (exit 0, real marker). This protocol field alone is not an OS enforcement boundary on this Windows configuration. This explicit RPC is an integration probe, not an exposed model tool. |
| Native `exec_command` workspace read | Explicit MXC, read-only, approval `never` | Read marker returned exactly once to fake inference; no approval request. |
| Native private `CODEX_HOME` marker read | Same read-only policy | **Read succeeded without approval.** Moving credentials into a private home does not isolate them from a native read-only shell. |
| Native shell and `apply_patch` Plan writes | Explicit MXC, read-only, approval `never` | Both left no file. Shell returned denied/blocked; patch rejected without requesting escalation. |
| Native reads in a named permission profile | MXC, `:minimal=read`, `:workspace_roots=read`, explicit deny on private home and sibling root | Workspace read succeeded; private/sibling markers did not reach inference. Access through a workspace junction to the denied sibling also failed. |
| Native shell writes with `minnow-read` | Same named profile, network disabled | No write. |
| Native shell write with `minnow-write` | Workspace write grant, private/sibling deny, network disabled, approval `never` | In-scope marker created; no approval. Thus an **approval-only** admission hook cannot implement Ask/Off on this policy. |
| Native shell out-of-scope write, including model-selected outside `workdir` | Same write profile | No outside file. Model-selected workdir did not expand the writable roots. |
| Native `apply_patch` approval held 100 ms | Named write profile, approval `untrusted`; correlate thread/turn/item with preceding fileChange item and exact path | File absent before and throughout approval hold. `decline` left no file; single `accept` wrote the exact marker. The returned native result reached inference once. |
| Native Node test of the edited file | Named read profile, real `exec_command`/Node | Core assert read the actual edited file and printed `NATIVE_TEST_OK`. |
| Accepted native patch into explicitly denied sibling root | Named read profile, `untrusted`, single `accept` | No outside file: explicit deny survived approval. |
| Accepted native patch into read-only workspace | Same named read profile, single `accept` | **Workspace file created.** Read permission does not make accepting a patch safe for Plan; a trusted bridge must refuse this request before answering. |
| Native HTTP access with network off | Named write profile, network `enabled=false` | Zero listener hits; no network marker in output. |
| Native HTTP positive control | Matching named read profile, network `enabled=true` | Exactly one listener hit and network marker returned. The negative result is not a broken client/listener. |
| Cancel native patch approval | Named write profile, `untrusted`, `cancel` | Turn ended `interrupted`; no file. |
| Adversarial unexposed `exec_command` and `apply_patch` against production manager | Actual dynamic-only manager config and `environments: []`; fake caller-supplied `minnow_native_policy` included | CLI returned unsupported/unavailable native-tool results; no command or edit marker. Request-body policy fields did not grant authority. |

This is evidence for the named primitives on **this host**, not proof that every command, race, rule, path alias or OS is covered. MXC named profiles are materially more capable than the previous untested report established. In particular, **the CLI has not been shown categorically incapable of a safe subset**.

The first draft assertion expected an accepted patch to bypass an explicit outside deny; the real CLI refused it. That assertion was corrected to record the stronger observed enforcement, while separately demonstrating that accepting a patch overrides a workspace *read* grant. Neither result was inferred from schema descriptions.

## Implemented recovery safety

The existing dynamic-only adapter now treats unexpected native actions as uncertainty, not executable Minnow calls or a reason to silently rebuild:

- `server/models/agent-cli-native.js` shares the supported item allowlist between event handling and native-history inspection.
- `server/generations/codex-app-server/pump.js` refuses unsupported native observations. A notification is not claimed to precede its effects. A native action found during final checkpoint verification makes the generation fail, rather than report a clean completion.
- `manager.js` marks the existing checkpoint `nativeRecoveryRequired`, keeps the private rollout/evidence, removes its copied `auth.json`, and **does not sync potentially changed private credentials back**. An unsupported history discovered before resume receives the same treatment, regardless of whether its digest matches.
- A quarantined chat refuses a later spawn/resume/rebuild before inference; the rejection is fatal and cannot silently fall over to another tool mode. Existing normal text-history tampering still follows the supported dynamic-only reconstruction path.
- `server/generations/agent-cli/checkpoints.js` does not expire or prune recovery-required records. There is no new home directory, database, tool dispatch or transcript authority. Explicit cache deletion still deletes evidence; no automatic recovery/replay or native-history projection is offered.
- Receipts retain identifiers/state, not command bodies or credentials. The retained rollout remains private native evidence, not a canonical Minnow action transcript. As with other storage, disk failure can prevent persisting a receipt; this is not a proof of crash-safe native action admission.

Executable regression checks cover unsupported live observations, native histories found before resume, no fake tool dispatch, no subsequent spawn/inference, retained evidence, auth removal/no source sync and retention beyond 30 days.

## Precise remaining blocker / host handoff

Native-on stays unavailable and the UI has **no experiment switch**. This is not justified by lack of an OS test: the probes above actually exercised the candidate native controls. The missing piece is the **trusted server execution contract**, outside the owned adapter files:

1. Admission must derive the supported subset from captured AND current mode/tool/filesystem/shell/network/child ceilings. Client body fields and a provider preference cannot supply that authority. The current native adapter only receives the ordinary provider profile/request; no trusted native policy is admitted by the server host.
2. The host must create a durable exact execution/turn mutation intent and finish the shared baseline **before** a mutation-capable native `turn/start`. It cannot wait for `item/started`; both automatic shell writes and some automatic native effects have already been admitted by then.
3. A durable approval bridge must bind execution/lease + native thread/turn/item/request, correlate the actual native file change/command, bound data, recheck current revocation, reject session-wide/execpolicy grants and refuse Plan/out-of-scope changes. The scratch callback proves protocol timing, not a production human-approval bridge.
4. Canonical native observational action records, lease-loss/Stop/uncertain-outcome recovery and faithful native↔Minnow projection must be connected to the existing server transcript. New inference/failover must be fenced once effects may have run. The new quarantine refuses unsupported continuation; it does not supply this missing projection.

The parent has now connected the production ordinary checkpoint/admission/worktree pipeline. Reinspection confirms `execution-host.js:132` prepares the checkpoint and `:240` wraps ordinary mutating `execute` calls with `checkpoint.effect`; `checkpoints.js:81` supplies the real baseline/intent barrier. These are usable building blocks, not a reason to claim checkpoint coordination is absent. However, `execution-host.js:263` still invokes `runTurn` without a native provider policy/admission/approval contract, and no trusted native policy is passed to `pumpCodexAppServer` or its `turn/start`. Native actions bypass ordinary `execute`, so merely enabling shell/edit features would bypass the new barrier. The remaining integration requirement above is specifically to bind those existing host primitives around native execution and canonical native records—not to build another checkpoint engine. This worker did **not** modify `server/chats/*`, grant authority through prompts, enable native preferences or add an inert switch. An attempted coordination message to the parent was denied by the chat permission ceiling; it was not retried or routed through another conversation. This report supplies the integration handoff instead.

Further exclusions: no native availability on unknown CLI/platforms; no `unelevated`/`elevated` certification or automatic setup; no native browser/plugins/hooks/subagents/image generation; no utility/tool-choice-none native authority; no paid A/B timings. Existing Models CLI status/settings validation remains fail-closed. No UI files or captions changed in this follow-up, so prior desktop/narrow UI evidence remains applicable to the unchanged surface.

## Verification

**Final combined run: 127 passed, zero failures/skips**, with all three installed flags enabled. Files: `agent-cli-{checkpoints,codex-app-server-pump,native-capabilities,persistence,native-enforcement,codex-app-server-live}.test.mjs` and `test/models/agent-cli-api.test.mjs`. `git diff --check` also passed (only line-ending warnings in other shared-branch files). After strengthening the quarantine test to allow failover in its caller, that focused test was rerun.

- Installed schema/live/enforcement group: **8 passed**, no skips/failures. Scoped MXC test was extended with the Node edited-file test and cancelled approval, then rerun: **1 passed**.
- API/persistence/native-capability/checkpoint/pump group: **120 passed, 1 opt-in skipped**, no failures.
- After credential-quarantine hardening: checkpoint/pump group **69 passed**, no skips/failures.
- `npx tsc --noEmit` and `npm run test:check-coverage`: passed (1930 discovered files, 1927 in npm test, 3 excluded at the recorded run).
- Manager LSP: no diagnostics; pump has a non-error TypeScript hint on the existing `await stopping` expression.

These focused groups overlap. They are not a full repository or packaged/cross-platform certification, and steps 10–12 remain incomplete pending the trusted host integration above.

## Implemented trusted native adapter experiment (later follow-up)

This section supersedes the earlier missing-adapter-contract statement, **not** the production settings gate. The adapter now supports the privately admitted Windows / CLI 0.166.0 / gpt-5.5 subset with real shell/read/edit/test and real Minnow integration calls. The host's current/captured policy intersection, live revocation subscription and real Git checkpoint remain mandatory. No client/body policy or profile boolean grants it.

### Exact host/adapter API

- The host creates a frozen branded context with `createChatNativeExecution` and binds it via the existing private generation-binding options. `pumpAgentCliUpstream` and `pumpCodexAppServer` obtain it **only** through `getNativeExecutionContext(state)` (process-local WeakMap), then reassert exact chat/provider/model identity.
- `policy = { version: 1, workspace, mode: 'read-only' | 'workspace-write', fingerprint }`; `signal` must revoke on Stop, lease/fence loss and policy invalidation.
- `runTurn(meta, operation)` receives `{ generationId, chatId, providerId, threadId, turnId: null, workspace, mode, policyFingerprint }` **after** thread creation/resume but **before** inference, item injection or `turn/start`. The host owns the baseline, durable intent and shared checkout lock. The adapter never calls the operation twice.
- `assertCurrent(meta)` runs before inference, records, approvals, result injection and settlement. The real turn ID binds on observations/terminal settlement. `record(event)` is awaited observational metadata with original generation/thread/turn/item identity, not a reconstructed executable tool call.
- `approve(request)` receives only bounded correlated in-workspace file-change requests. The adapter permits **decline/cancel only**, even if a host callback returns accept; native Ask, shell/network escalation, session grants, and grantRoot remain unsupported. Ordinary Full native actions run inside the OS profile; guarded Minnow tools retain their own approvals.
- Success returns `{ outcome: 'complete', nativeQuiescence: { verified: true, source: 'turn-completed' | 'dynamic-tool-pause', generationId, threadId, turnId } }`. Generation success is published only **after the host checkpoint barrier settles**.

### Parked dynamic calls are not quiescence

An adversarial real-CLI fixture demonstrated that a native command can create a marker **while a sibling Minnow dynamic request is unanswered**, even with `unified_exec=false`. Consequently the experiment never releases a checkout merely on a dynamic-tool request, an empty native-active set, or a quiet timer.

At handoff, the adapter interrupts the native turn, awaits its terminal interrupted notification, drains native records, verifies the full thread and rollout digests and writes a bounded checkpoint containing pending-call identities. It then **closes the native process tree and confirms exit before returning the quiescence proof**. Before subsequent inference, a fresh process verifies/resumes that saved thread and injects the actual recorded Minnow result once using the original native call identity. It does not replay the tool/native action. This deliberately costs a process resume per handoff/terminal region rather than claiming warm parked sessions are safe. Background command continuations fail to uncertainty; unknown native items/capabilities and unverified shutdown/checkpoint/history never silently rebuild or fail over.

Windows resumed rollout paths use the `\\\\?\\` namespace. Private rollout containment now compares like namespaces with `path.toNamespacedPath` while preserving per-component symlink rejection and full-content digest verification.

### New installed-CLI coverage

```bat
set MINNOW_CODEX_NATIVE_ENFORCEMENT=1&& node --test --test-force-exit test/generations/agent-cli-native-adapter-live.test.mjs test/generations/agent-cli-native-parallel-live.test.mjs
```

The fixtures cover private admission holding inference/effects; native read/edit/Node test; no provider-secret inheritance; exact real Minnow integration result round-trip; interrupted-handoff resume and later native-history resume without replay; Plan/private/outside/network denial; forged/missing/revoked authority; mid-command revocation with a durable uncertain checkpoint; mixed delayed native sibling shutdown before handoff; and the **real** fenced host + real Git safety snapshots + canonical observation journal followed by ordinary mutation and resumed native execution.

This is a usable supported **private experiment**, not a shipped settings switch. Broader production routing/current-policy invalidation and user-facing capability exposure remain the parent's integration gate. No host-owned files were changed by this adapter worker.

Additional shutdown control: a native `Start-Process` returned a real child PID (`-PassThru`, exit 0), then the region closed. The delayed child marker remained absent after its deadline. The test does not count a failed spawn as successful cleanup. All installed enforcement/adapter/parallel probes run together below: **12 passed, 0 skipped** (rerun command recorded in task output). Typecheck, test discovery and 153 regression tests also passed (one separate opt-in schema smoke skipped).

Supported mixed results are text-only and tool selection must be automatic; named/required/none tool-choice requests and image-bearing dynamic-result continuations fail closed rather than being silently approximated. These exclusions are emitted in native effective-mode metadata.

## Descendant lifecycle revalidation — limits on the preceding shutdown claims

The earlier PID-only Start-Process result did **not** prove that the child payload had run. It is superseded by controlled probes in `test/generations/agent-cli-native-adapter-live.test.mjs`:

- The child now writes an immediate `.started` marker; its launching native command waits for that marker before returning. Merely obtaining a PID is not sufficient.
- Positive control: the launching native command waits for its child to exit. The real child payload writes the delayed marker successfully.
- Raw terminal control: the launcher returns after that start handshake while the app-server stays alive. After the delayed-write deadline, the child marker remains absent. On this pinned MXC path the observed cleanup therefore occurs at the **native command lifetime**, not solely when Minnow later closes app-server.
- The adapter's matching started-child case also leaves no delayed marker after its region returns. This is consistent with the raw command-lifetime control; it cannot establish that app-server shutdown was what killed the child.
- Requested `yield_time_ms: 1` with a three-second delayed command returned a completed native item with **exit code 0** and the expected file effect. The same adapter request likewise completed before returning its region. A genuinely live yielded session was **not demonstrated**; the fail-closed exitCode-null branch must not be described as installed-runtime proven by this probe.
- During the first revalidation run, the stronger controls failed because they expected child survival/yielding which the runtime did not exhibit. Assertions were corrected only after observing the actual outcomes above. Those initial assumptions are not security evidence.

These are concrete scratch-host observations, **not a structural proof that arbitrary detached/breakaway descendants cannot survive**. Windows job ownership, breakaway rights, arbitrary process trees and every filesystem-generation permission variant are not certified by these marker tests. Production native shell writes must remain unavailable until the host/adapter owners establish an enforced descendant-lifetime contract; do not expose a switch based on these probes alone. Existing all-Full policy requirements and granular Ask/Off exclusions are unchanged.

Focused reproduction:

```bat
set MINNOW_CODEX_NATIVE_ENFORCEMENT=1&& node --test --test-force-exit --test-name-pattern="positive control|short-yield|demonstrably started|raw completed-launcher" test/generations/agent-cli-native-adapter-live.test.mjs
```

## Repository-derived continuity with exact host observation projection

The real-host installed fixture now persists its user, assistant handoff, actual tool result and settled assistant rows in SQLite, rather than manually constructing a clean side transcript. Its outbound messages come from `repository.readTranscript`, with only the host authority's `projectMessages` applied before binding the generation. The exact frozen host authority is bound directly, not copied/rebranded.

It exercises native edit → interrupted dynamic handoff → actual persisted Minnow result → resumed completion → finalized/released execution → newly claimed fenced execution/new authority → native read of the saved edit. All three native generations resume the same thread. The new authority discovers the exact known native observations from SQLite; their summaries remain in the canonical transcript, while the native accepted prefix omits those duplicates. Unknown assistant prose with the same marker prefix is preserved. The original completed edit is recorded once and never replayed. Every native/Git checkpoint settles without uncertainty in this fixture. No adapter source/API change or relaxed history fingerprint was required; projection remains exclusively the parent's private host/generation-binding responsibility.

This continuity result does not close the arbitrary-descendant lifetime gap above or authorize a production switch.

Final revalidation commands for these additions: the three installed native test files together passed **16/16, zero skips**. `npx tsc --noEmit`, `npm run test:check-coverage`, and `git diff --check` passed. Affected host/native capability/Codex pump suites passed **106 tests**, with one separately opted-in schema smoke skipped. These counts supersede earlier aggregate counts, not the explicit descendant-lifetime limitations.

## Shared runner + production generation binding continuity (not fixture-side projection)

Added installed test `shared runner and real generation binding preserve canonical native observations across two host commands` in `test/generations/agent-cli-native-adapter-live.test.mjs`. Unlike the lower-level adapter harness, this test does **not** project the outgoing transcript itself. It uses the real `runTurn`, `createChatTranscriptStore`, `createServerRunnerDeps`, `postChatCompletionsInProcess`, provider lookup in a scratch Minnow home, real `createChatNativeExecution`, SQLite fences, Git snapshots and installed Codex/MXC. Only Responses inference and a fixture integration handler are scripted; no live account/settings are used.

Command one executes a real native edit, returns a dynamic call to the shared runner, executes one actual fixture filesystem integration under the shared checkpoint boundary, persists its real result and completes. Command two claims a new execution and authority and reloads the canonical repository transcript. The test asserts that command two's unprojected runner body includes native-observation assistant prose; only the **real generation binding** applies the host projection. Both commands use the same verified native thread. The native edit and ordinary integration each occur once, their real files/result survive, all native observations remain canonical, and every safety checkpoint settles.

Focused command:

```bat
set MINNOW_CODEX_NATIVE_ENFORCEMENT=1&& node --test --test-force-exit --test-name-pattern="shared runner and real generation binding" test/generations/agent-cli-native-adapter-live.test.mjs
```

Result: **1 passed, 0 skipped** against the installed CLI. This verifies same-native continuity, not a faithful arbitrary adapter/model switch; history/policy changes still require explicit recovery rather than silently rebuilding native effects. The descendant-lifetime and production capability gates above are unchanged.

After adding the real shared-runner fixture, the full installed adapter-live file passed **12/12, zero skips**. Test-file LSP diagnostics were empty; typecheck, test discovery and diff checks passed. The older three-file installed aggregate was not rerun for this test-only addition; its last measured count remains 16/16 before the new shared-runner case.
