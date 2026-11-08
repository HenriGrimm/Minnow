# Native execution host seam — implementation handoff (2026-11-07)

Historical seam handoff. The host is now integrated for the explicitly supported Windows candidate; see [production validation](chat-performance-production-validation.md) for current evidence and remaining certification limits. Statements below describe the original isolated handoff.

This is an implemented, tested **private server seam**, not product availability or completion of plan steps 10–12. No settings, preference enablement, live inference or commits were performed. Existing shared-branch edits were preserved.

## Owned implementation

- `server/chats/native-execution.js`: `deriveChatNativePolicy` and async `createChatNativeExecution`.
- `server/generations/native-execution-context.{js,d.ts}`: process-local branded authority and WeakMap generation binding. JSON copies and similarly named body fields have no authority.
- `server/runner/generation-binding.{js,d.ts}`, `adapters.d.ts`: internal `options.nativeExecution` forwarding, exact candidate and no failover.
- `server/generations/upstream.js`: obtain authority from the private WeakMap and pass it to `pumpAgentCliUpstream`; refuse non-Codex/API providers before inference. This small additional dispatch edit prevents silently running a native-only request through ordinary HTTP.
- `test/chats/native-execution.test.mjs`, `test/runner/generation-binding.test.mjs`: executable contracts and negative tests.

No edits were made to parent-owned execution-host/runtime/service files or worker-owned Codex manager/pump/native files.

## Host construction contract

Call `createChatNativeExecution({ repository, checkpoint, capturedPolicy, resolveCurrentPolicy, subscribePolicyChanges, chatId, executionId, fence, cwd, workspaceId, providerId, modelId, cliVersion, signal, requestedNative, waitForApproval, redactionSecrets })` only from trusted accepted execution preparation.

- `requestedNative === true` must come from the captured server selection. It is a preference, not a policy grant; current policy is separately resolved. The host independently requires the following matching record in `repository.getExecution(executionId).captured.nativeExecution`. Persist it on the accepted command at service admission and copy it unchanged into the execution, never recreate it from a later provider runtime/settings read. Missing, Minnow-selected or mismatched records reject before inference. Subsequent capture changes abort the authority.

```js
nativeExecution: {
  version: 1,
  requestedMode: 'native',
  effectiveMode: 'native', // native-only or an explicit refusal; never silent fallback
  providerId,
  modelId,
  cliVersion: '0.166.0',
  networkAccess: 'off'
}
```

For native-off queued commands, persist requested/effective `minnow`; do not construct native authority for them even if the preference becomes enabled later. Capture model/effort options using the existing modelSelection/options snapshot. This module reads no live provider native preference. Fixed `networkAccess: 'off'` is also included in its returned policy/fingerprint because current ChatPolicy has no distinct network grant. The adapter must enforce network denial, not infer access from shell permission.
- `checkpoint` is the existing `createChatCheckpointCoordinator.prepare(...)` result, not a new checkpoint engine. A real Git baseline must settle before native inference; non-Git/skipped baselines are unavailable.
- `subscribePolicyChanges(listener)` must synchronously install **all effective policy** invalidation and return its disposer. On any invalidation the authority aborts conservatively, including a transient revoke/regrant. A timer-only policy cache is not equivalent. This production subscription is NOT supplied by this worker.
- Outer `signal` must be aborted on Stop/lease loss. Exact repository lease, cancellation epoch, running execution and checkout identity are also checked on every boundary.
- `waitForApproval(request, signal)` must use the existing durable request service/host human wait. The request includes exact execution, generation, native thread/turn/item/request and a stable native approval toolCallId. Only `allow_once` maps to native `accept`; session grants, shell/network escalations, unknown answers and read-only approvals do not.
- Inject the returned authority through a **server-owned deps.postChatCompletions wrapper**, merging `nativeExecution` and `fallbackRole: 'default'` into its internal options. Do not put authority in the runner body, runOptions or HTTP request. Utility/sub-agent/tool-choice-none requests cannot acquire it.
- Dispose the authority at host teardown. Invalidation aborts must be mapped to conservative recovery once native effects may have run, not ordinary success or automatic replay.

The experimental candidate policy subset is intentionally strict (not a product-availability claim): Windows, Codex 0.166.0, gpt-5.5; Full for equivalent filesystem/code/Git reads, Python/JavaScript and command tools. Captured/current optional shell aliases and Git mutation names are also checked even if their effect metadata falsely claims read-only. Workspace-write additionally requires Full for all listed filesystem/Git write equivalents and known file-write/git-write effect tools. Current and captured policies intersect; missing/Ask/Off grants fail closed. Plan/plans/no-write scopes get native read-only; plan-document writes remain guarded Minnow tools. The native adapter still owns actual MXC/network/private-home enforcement and exact installed-version verification. A caller-supplied version string alone does not certify enforcement.

## Required adapter return contract

The host rejects a bare `{ outcome: 'complete' }` as insufficient; an executable regression test proves it becomes checkpoint uncertainty. Follow-up source inspection found the adapter now retrieves the private WeakMap grant, supplies `nativeQuiescence` only after checkpoint/interrupt/process-close handling, and defers final completion publication until `runTurn` returns. These source changes remove the previously reported missing return shape; actual end-to-end integration still requires verification.

`authority.runTurn(meta, operation)` admits one native-running region per exact generation. Initial metadata can omit thread/turn before creation; subsequent `assertCurrent`/record callbacks bind them once. The operation must:

1. Run no native inference before the callback is invoked (baseline and durable checkpoint `executing` intent are already in place).
2. Never execute dynamic Minnow calls, causal child waits or wait for their results inside this region.
3. Before returning, prove that ALL native work has stopped or is safely parked, drain durable `record` writes, and verify the private native checkpoint.
4. Return its normal result plus:

```js
{
  nativeQuiescence: {
    verified: true,
    source: 'turn-completed', // or 'dynamic-tool-pause'
    generationId, threadId, turnId
  }
}
```

A dynamic request, item/completed notification or CLI-parent exit alone is NOT proof no concurrent native command or detached descendant is still running. The adapter must establish whole MXC process/container-tree quiescence before claiming this flag, including spawned children that outlive their shell item. The host also rejects proof while any observed native item remains incomplete. The private callback shape is not independent OS attestation; keep native availability disabled until the actual adapter lifecycle and installed integration are verified. Returning without proof, Stop, a failed record, lease/policy loss, or a failed post-checkpoint leaves durable uncertainty and blocks later checkout writes. Verified pause settles the region and releases the checkout before dynamic/child execution. Actual proof production must be implemented/tested in the owned Codex adapter; do not manufacture this flag merely to satisfy the shape.

The adapter must not publish final generation completion before the outer host region/post-checkpoint settles. The current `publishNativeCompletion` placement follows that requirement in source; this worker has not independently certified the updated installed-CLI ordering. Native escalation requests now carry `allowedDecisions: ['decline', 'cancel']`; the host honors this ceiling without offering a human acceptance that the adapter cannot safely apply.

## Observation and recovery limits

Only commandExecution/fileChange start/completion records are accepted. They have stable native identities, bounded/redacted command/output/path metadata, duplicate checks, path/junction rejection and canonical assistant rows with `nativeAction`; no executable tool_calls or native-as-Minnow dispatch is produced. A successful native fileChange under Plan is recovery-required.

Observation/approval payload limits are UTF-8 **bytes**, not JavaScript string lengths: 512 KiB per item/approval changes payload, 4 MiB observations per region, 100 changes per approval and at most three supported approval decisions. Oversized change lists reject before serialization/hash or human presentation. Known secrets are copied at authority creation, bounded to 128 strings (64 KiB each, 256 KiB total), and removed before the shared 2000-character diagnostic tail limit; quoted JSON credentials and CLI token/password flags are also scrubbed. Approval paths requiring redaction/truncation are declined rather than accepted with hidden details. These patterns are defense in depth, not a claim that arbitrary unlabelled secret text can be identified without the adapter's actual secret list.

These are **bounded observational summaries**, not a certified faithful reconstruction of arbitrary native history/diffs or a complete native-action UI. The adapter must retain its native checkpoints/quarantine and refuse rebuild/provider-switch/replay where faithful projection has not been proved. Host canonical read/restart and actual installed-CLI mixed native/dynamic safety still need integration tests. Do not enable the product toggle on the strength of these seam tests.

## Verification

- Combined native host + ordinary checkpoints + generation binding + existing Codex pump/capability suites: **108 passed, 1 opt-in installed-schema test skipped, 0 failures**.
- After final Plan-completed-write, junction, immutable queued-choice, redaction, UTF-8 argument-limit and Python/JavaScript/Git-equivalence checks: focused host/checkpoints/binding **67 passed, 0 failures/skips**.
- Existing execution-host/production HTTP runtime regression group: **35 passed, 0 failures/skips**. This does not by itself certify the newly wired installed-CLI native path.
- `npx tsc --noEmit && npm run test:check-coverage`: passed (1933 files, 1930 covered by npm test, 3 intentional exclusions at that run).
- LSP: no diagnostics for new host/context and generation binding at the checked revision.
- Missing quiescence proof, unsupported approval decision ceilings and missing invalidation subscription are explicitly tested fail-closed, not claimed complete.
- The inspected installed adapter fixture's real-host construction omitted `requestedNative: true` at that revision. Supply that private captured opt-in and the persisted `captured.nativeExecution` selection above explicitly; do not remove admission checks to make fixtures run. Parent subsequently added `prepareNativeExecution` runtime/host wiring and a `native-policy-monitor.js` subscription; those changes are not owned or end-to-end certified by this worker. The fixture mismatch was identified from source; the installed test was not run by this worker.
- This worker reran two targeted installed Windows CLI probes with `set MINNOW_CODEX_NATIVE_ENFORCEMENT=1&& node --test --test-force-exit --test-name-pattern="native process closure also stops|MXC positive control" test/generations/agent-cli-native-adapter-live.test.mjs`: **2 passed, 0 skipped/failed**. The real Start-Process delayed child reported its payload started; after adapter process/container closure its delayed mutation marker remained absent. The matching positive control completed the same delayed write while the launching command stayed alive. Inference was scripted loopback only, no paid comparison. This is evidence for that pinned host/path, not proof for every Windows escape/descendant mechanism or full product integration. No packaged/cross-platform certification or native A/B inference was performed.

The attempted parent coordination message was policy-denied; it was not rerouted. This document and the completion result provide the integration handoff.

## Policy-monitor follow-up: implemented coverage and remaining blocker

`server/chats/native-policy-monitor.js` is now a real supplied runtime dependency, not a permanently missing callback. The existing config writer calls `invalidateNativePolicyBeforeWrite` before its atomic rename, and provider writes have their existing authority-sensitive pre-commit hook. A regression test reads the old `tools.json` from the invalidation callback and confirms the new value only appears after that callback returns.

This worker narrowed monitoring to a **shallow** home watcher plus recursive watches on existing policy roots (`mcp`, `plugins`, `prompts`, legacy `tools`, work-agent/pack/profile definitions and providers). There is no recursive whole-home subscription: SQLite, native rollouts, logs and ordinary workspace files are not recursively observed. Creation of an absent policy tree invalidates the current admission; subsequent admissions install its recursive coverage. Shared parent watches detect replacement of both checkout and home. Watcher errors/closure, partial setup failure, root-policy junctions and identity replacement fail closed; partial subscriptions are disposed. A provider-directory rename also invalidates, rather than relying only on an old profile-file handle.

Verification: **19 monitor tests passed**, including real filesystem and real config-writer checks; **86 combined monitor/native-host/checkpoints/binding tests passed** before the final event-kind guard, followed by rerunning all 19 monitor tests and `npx tsc --noEmit` successfully. Monitor LSP reported no diagnostics.

**Remaining activation blocker, not certified:** provider profile monitoring currently compares the final authority fingerprint while deliberately ignoring future-only native preference changes. A deterministic coalesced-event probe wrote `enabled:false`, restored the original `enabled:true` profile, then delivered a provider watcher callback. It observed **0 invalidations where 1 was required**. Final-content comparison cannot reconstruct a transient external revoke/regrant. No safe event-attribution mechanism separating internal preference-only writes from arbitrary external authority changes was implemented here. Do not claim this monitor establishes the complete external-revocation contract or enable native availability on this evidence.

Filesystem events also cannot replace synchronous pre-commit invalidation for server mutators that bypass `config/store.js`/provider writers (for example, the inspected raw MCP configuration writes and plugin index mutations). Those remaining writers need explicit ordering coverage before full in-process revocation is certified. Existing product native availability was not changed by this worker. The targeted monitor improvement is not a waiver of these blockers.

## Native observation continuity: real shared-runner verification

The shared branch now exposes private `authority.projectMessages(messages)` and invokes it in `server/runner/generation-binding.js` **after** authority validation and **before** ephemeral generation state creation. It is not inferred from a JSON field. The host seeds its bounded known-content set from durable nativeAction rows and adds observations only after canonical append succeeds. Native summaries remain in SQLite and are retained for other adapters/UI; the same verified native thread already contains those actions, so only its exact known observational prose is removed from the native adapter's prefix projection. Existing observations require the compatible native checkpoint/policy fingerprint before admission. Marker-like unknown prose and user rows remain unchanged.

This worker added a fail-closed ambiguity guard: if a known observation-content candidate carries tool calls/tool-result identity, or the request contains repeated identical candidates, projection refuses with explicit recovery rather than silently dropping executable or ambiguous history. A focused unit test covers these cases and confirms canonical rows are not rewritten. This is still a bounded content-based projection, not a claim of faithful arbitrary compaction/history editing or native-to-other-provider reconstruction.

Installed Windows CLI verification was run **after** that guard:

```bat
set MINNOW_CODEX_NATIVE_ENFORCEMENT=1&& node --test --test-force-exit --test-name-pattern="real native adapter resumes repository-derived|shared runner and real generation binding preserve" test/generations/agent-cli-native-adapter-live.test.mjs
```

**2 passed, zero failures/skips.** The first test uses actual repository-derived canonical observations, Git snapshots, native edit, dynamic handoff and a new fenced authority. The second uses the real shared `runTurn`, `createChatTranscriptStore`, `createServerRunnerDeps`, `postChatCompletionsInProcess` and actual generation-binding projection over **two host commands**. It confirms the second runner request actually contained canonical observation prose before projection; the same native thread resumes, the original edit completes only once, the dynamic integration runs only once, its real result reaches native continuation, and all workspace checkpoints settle. These tests use scratch homes/provider settings and loopback scripted inference, not a paid/live-account comparison.

Latest focused native-host/checkpoints/generation-binding group: **68 passed, zero failures/skips**. `npx tsc --noEmit` passed; host LSP reported no diagnostics. The provider external-revoke/regrant and raw-writer monitoring blockers described above remain separate and are **not** resolved by this continuity evidence. No native availability or live settings were enabled by this worker.
