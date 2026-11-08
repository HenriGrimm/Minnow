# Chat performance implementation evidence

Historical implementation log. The later [production validation](chat-performance-production-validation.md) records the integrated build, checkpoint optimization, installed native tests and final verification. Status statements below describe their original observation date.

Status: partial implementation; not a completed rollout. The original plan's unchecked gates remain authoritative. This report records observations, not inferred end-to-end improvements.

## Reference and benchmark

- Windows x64, Node v24.19.0, 32 logical CPUs.
- Baseline source: Git commit `db8394809e817b03cade5d6a8e0b4ce2c5e5f629`.
- Run: `node scripts/benchmark-chat-snapshots.mjs --samples 3 --files 200 --output documentation/plans/chat-performance-snapshot-results.json`.
- Synthetic repositories: 200 tracked files, clean or staged + unstaged + untracked changes. One warmup then three measured batches, one/four simultaneous captures. No account inference, live chat input, credentials or exported file content.
- This is a Git component measurement, not the original large-checkout fixture, a renderer profile, or a promise about conversation latency. Samples are too few for a release-quality p95. Other implementation workers were active; results are not controlled hardware-isolation measurements.

| Repository | Concurrency | Baseline capture p50/p95 ms | Current capture p50/p95 ms |
| --- | ---: | ---: | ---: |
| Clean | 1 | 349.8 / 410.1 | 356.8 / 416.8 |
| Clean | 4 | 384.9 / 421.5 | 373.5 / 411.7 |
| Dirty | 1 | 311.4 / 395.6 | 404.4 / 477.9 |
| Dirty | 4 | 421.9 / 459.7 | 449.5 / 523.5 |

These numbers are the branch-continuation rerun after adding the final HEAD-stability check. They supersede the earlier component table. The current implementation is not consistently faster; dirty captures are slower in this run. Safety assertions are retained regardless of timing. Baseline failures also make its successful-sample timing unsuitable for a direct throughput win claim.

Correctness: the baseline rewrote index bytes in both dirty scenarios and recorded two failed captures in each four-concurrent scenario across warmup + measured attempts. The current implementation preserved index bytes and recorded zero failures in every scenario. The first benchmark attempt stopped on baseline concurrent failure and cleanup reported Windows EBUSY, masking the original error. The harness now waits for all concurrent attempts and retries scratch-only cleanup. It records baseline failures rather than interpreting failed captures as successful fast samples.

The current snapshot copies Git's real index to a private index before any `write-tree`, retaining reusable stat data without writing cache-tree extensions into the real index. No snapshot reuse based only on watchers, no file exclusions, no changes to restore semantics. Tests cover absent indexes/unborn repositories, split indexes, staged/unstaged/untracked separation and safety undo. External edits are not made atomic by this improvement.

## Timing interpretation

- Every recorder has its own `clockId` and monotonic offsets. Only compare offsets sharing that identity. Execution correlation associates recorder streams; it does not synchronize clocks.
- Existing `request_headers` includes dispatch through response headers. `first_prose_delta` and `first_reasoning_delta` measure request-to-first-output milestones, not pure inference.
- Host `preparation`, `external_tool_execution`, `human_wait`, `host_wait`, `runner_settled` and `host_execution` are separate stages. Host wait can include execution on the host; it is not a pure network measurement.
- `final_prose` and `transcript_durable` are different milestones. Neither claims Git/native checkpoint finalization or durable command idle.
- Renderer `first_prose_dom` ends at the Markdown scheduler's DOM-write callback, not at scheduling or actual hardware compositing. The deterministic delayed-paint fixture demonstrates 45 ms from first received visible prose to the callback. Hidden/disposed/failed-response callbacks cannot claim the replacement response's measurement.
- Timing details use a bounded allowlist. Throwing/rejecting observers cannot stop generation. Renderer timing history stays bounded at 256 entries, using existing round/final saves rather than per-token writes.
- Intervals overlap. Do not sum `turn`, model rounds, tool batches and their child tools into one latency. Renderer/server wall-clock subtraction is unsupported. Composer-to-admission, native queue/init, hardware paint and checkpoint-finalized coverage remains incomplete.

## Verification recorded so far

Passing checks observed during implementation:

- Original execution-host baseline: 19 tests.
- Timing/painter/execution-host/efficiency focused batch: 57 tests.
- Git API: 40 tests; additional index-isolation suite: 2 tests.
- Plugins: 56 tests; renderer plugin cache: 10 tests.
- Painter/conversation-view/stream-end/snapshot focused batch: 47 tests before the final extra stale-paint fixture.
- Remote: 100 tests.
- Backup: 94 tests.
- Scheduler: 85 tests.
- Boards/orchestrator: 1266 discovered test results (1264 pass, zero fail; remaining results are not counted as passes here).
- `npx tsc --noEmit`, production build, headless build, test coverage discovery and bundle budgets.

Not fully green:

- `npm test` was run and exited 1. Detailed local logs: `.minnow/chat-performance-full-tests.log`. Failures include Windows `UV_HANDLE_CLOSING` native-process aborts, timing-sensitive CLI/UI checks and existing contract mismatches. These are not all established as pre-existing.
- An old exact timing-object assertion was updated for the new monotonic fields and passes on focused rerun.
- The runner's assertion that boards have no browser formatter conflicts with untouched baseline source: `git show HEAD:server/orchestrator/effector-runner.js` already contains `formatAgentBrowserGuideForTranscript`. That failure is not caused by this task.
- `test/chats/legacy-result-delivery.test.mjs` still aborts with `UV_HANDLE_CLOSING` on an isolated rerun after 15 individual assertions pass. This is not a successful suite result.
- No packaged Electron testing on Windows/macOS/Linux, real compositor/input-response profiling or paid native A/B comparison has been performed.

## Rollout gates

Do not enable ordinary-chat promotion until admission, attachment/skill/worktree parity, canonical replay/fork and checkpoint recovery checks pass. Do not enable Codex native coding solely because a version's schema advertises it. Pre-effect permission/sandbox enforcement and compatible native recovery must be demonstrated.

The proposed whole-turn shared-checkout lock is not implemented: a parent that holds it while awaiting a child using the same checkout would deadlock. A correct implementation needs causal yield/checkpoint boundaries or another proven ownership scheme; blindly overlapping baseline capture and allowing writes would not satisfy rollback safety. Existing renderer snapshot waits remain in place. This is an explicit unfinished part of step 5, not an optimization silently disabled after admission.

## Integration corrections and current step coverage

The required-document end-to-end regression initially still dispatched a provider request: `resolveOutboundSystemMessages` and the ordinary renderer both swallowed composition failures. Both error fallbacks now propagate failure; empty configured prompts can still use the legacy value. The real renderer regression with no attachments now shows an actionable missing-document error, never calls `runTurn`, and releases streaming state. Optional memory/code-map omissions retain their bounded behavior.

Checkout identity is now captured with admitted commands, rechecked after asynchronous model/profile selection, and checked before reserving a queued execution. A replacement directory at the same pathname cannot inherit the original command. The production regression replacing the directory after receipt but before preparation observes zero upstream model calls. Fork/configuration also compare verified identity after asynchronous validation. Existing legacy commands without captured identity keep their compatibility path; new production admissions supply it.

| Plan step | Implemented evidence and remaining work |
| --- | --- |
| 1 — instrumentation | Bounded recorder-local timings and fake-provider/DOM regression fixtures; composer/admission/native and full reference-renderer profiles incomplete |
| 2 — discovery | Plugin revision/single-flight/failure/deadline/reconnect path implemented and tested; whole settings/work-agent prompt discovery is not fully revision-shared |
| 3 — authority | Reuses verified per-checkout registry rows while rereading Git membership/current restrictions and canonical identities; unchanged real-Git discovery is three cold calls versus two warm calls, not zero Git calls |
| 4 — preparation | Independent optional lanes, total cold-init/query deadlines, shared cold initialization, required-document failures and bounded ordered host-tool availability checks; lazy host/browser activation is not migrated |
| 5 — snapshots | Private index/stat reuse and byte-preservation tests; baseline/request overlap, causal shared-checkout coordination and separate checkpoint-idle milestone remain unfinished |
| 6 — ordinary admission | Unsafe unsupported options/unfinished worktree intent reject explicitly; full server-owned skill/context/worktree setup parity not implemented |
| 7 — fork/configuration | Serialized revision-checked root configuration and new-branch modern canonical replay; compacted/legacy/delegated/native histories, sampler overrides and broader edit/undo parity still guarded |
| 8 — server routing | Independent ordinary capability and compatibility boundary; default promotion/admission disabled, not a completed migration |
| 9 — persistence | Presentation-only managed saves, entity ACKs, no production whole-chat hash and long-history SQLite checks pass; full interaction/subscriber profiles remain unverified |
| 10 — native feasibility | Must demonstrate pre-effect enforcement/recovery; schema support alone does not satisfy the gate |
| 11 — native execution | No admitted native mutation/action recovery implementation; native tools remain disabled |
| 12 — switch | No inert native opt-in switch is shipped; unsupported activation must fail closed |
| 13 — checkpoint cost | In-flight Codex verification reads coalesce and have a deadline, with dirty/revision safety checks; Claude snapshot cost is recorded separately, not removed |
| 14 — rollout | Typecheck/build/headless/discovery/budgets and multiple integration suites run; full-suite failures and packaged multi-platform verification remain open |

Additional passing parent verification: authority/preparation/runtime/hybrid-retrieval batch 43 tests; context/prompt batch 19; canonical contracts/commands/middleware/repository batch 107 (before the final identity regressions); native checkpoints/pump/API batch 79; managed client/activity/CLI UI batch 43; server restart/host/transcript recovery batch 18; managed headless boundary batch 13; packaged-boundary suite 10; memory suite 61; Skills suite passes. The latest root command/runtime identity batch has 41 passing tests. These batches overlap and must not be added into a unique test count.

The latest runner suite has the baseline board-browser assertion mismatch plus the isolated Windows `UV_HANDLE_CLOSING` auth-test abort. The Attachments suite also exits 1: inaccessible-skill redirect and code-selection-drop fixture checks fail. No code in those failing implementations was changed by the parent, but they are not all established as baseline failures. Full rollout remains blocked.

## Browser inspection and installed Codex recheck

Parent inspected the real CLI panel and canonical message menu in an isolated Vite-only synthetic fixture at 1440×1100 and 390×844, using the existing swamp-dark tokens. The unavailable-native reason wrapped in the existing hint style (desktop 54 px, narrow 72 px), no horizontal document overflow was observed, and both menus exposed Copy / Replay in new chat without local history-edit controls. No settings/model/account API requests were made (`__fixtureCalls` was empty); the replay action itself was not executed in this browser fixture. Initial screenshot setup used an invalid theme ID, corrected to the existing swamp-dark ID before visual review. This is component/UI inspection, not packaged-app, full chat-flow or hardware performance certification. Fixture server and private tabs were closed afterward.

Parent independently reran the installed Codex 0.166.0 schema and loopback fake-provider tests: four tests pass, no skips, no paid inference. Ten warm turns reused the native process. This rerun's checkpoint total range was 4.9036–9.7000 ms; ranges vary from the worker report and are not end-to-end improvements. Native-on authority enforcement is still unverified and therefore unavailable.

## Managed save evidence (latest integration run)

`test/state/session-save-scaling.test.mts` passes six deterministic cases. Synthetic histories of 10 / 100 / 2500 messages serialize to 40,362 / 403,738 / 10,099,589 bytes, but their metadata request stays **139 bytes**. Throwing getters prove save/DEV diagnostics do not read history, runs, subagents, token ledger or runner timing. Thirty saves per size (five warmups) measured synchronous Node-call p50 0.023 / 0.016 / 0.015 ms and p95 0.068 / 0.022 / 0.038 ms in the latest integration run. These tiny Node timings are not a renderer/input-latency profile.

Per-entity receipts clear saved A without resending it because B/groups/scalars changed; same-entity edits/deletion remain dirty; global-conflict rebasing reuses one serialized legacy snapshot; PUT/PATCH/keepalive/shutdown paths strip canonical managed fields. The server 2500-message fixture performed three metadata saves with 63 SQLite statements (4.002 ms in one run), did not rewrite message rows, and retained the full transcript and original row identities after closing/reopening SQLite. Focused combined persistence batch: 13 pass. Broader worker checks are recorded separately.

Latest parent integration: canonical contracts/commands/middleware/repository/runtime/server-restart **120 pass**. Production and headless builds/typecheck pass; bundle budgets pass; discovery covers 1922 tests out of 1925 files with three explicit exclusions. Full npm test was run earlier and is not green; no blanket full-suite pass is claimed. Production build retains its existing large-chunk warning. Step 9's metadata-save/ACK slice is now implemented; full four-stream typing/compositor profiles and all presentation/subscriber budgets are not certified.

## Final verification status

The parent reran **all 819 `test/chat/*.test.mts` assertions successfully** after removing the two unsafe composition-error fallbacks and supplying deterministic config APIs in the renderer Stop/failure/run-turn fixtures. Stop/failure suites separately pass 31 assertions. All **233 state tests** and **13 product-wiki tests** pass. The session worker's earlier missing-config integration caveat is therefore resolved for those changed fixtures, not a remaining production fallback.

`npm test` was rerun on the final coherent implementation and still exits 1. Local report: `.minnow/chat-performance-full-tests-final.log`. Outstanding failures include native Windows `UV_HANDLE_CLOSING` process aborts (legacy-result-delivery, code cascade, Godot, model and remote fixtures), the confirmed baseline board-browser assertion mismatch, CRLF-sensitive Git discard expectations, missing symlink privilege (`EPERM`), inaccessible-skill/check-plan scope expectations, code selection drop, CLI-judge timeout, Reef recovery/UI phase assertions, tool-start remount and live-board reasoning assertions. No blanket pre-existing classification is made, and these unrelated failures were not silenced or deleted to force green. Focused security/recovery results and component measurements do not waive the full-suite/package rollout gates.

No commits or live provider/settings edits were made. Generated reliability JSON files changed only by tests were restored; generated product-wiki metadata tracks the intentional manual change. Ordinary promotion, safe cross-chat checkpoint overlap and native action admission/recovery are unfinished implementation work, not delivered features. Packaged cross-platform certification, real input/paint budgets and broad replay/worktree/skill parity remain outstanding. This task does not satisfy the plan's all-fourteen-steps acceptance checklist.

## Dedicated branch continuation

Continued on `codex/chat-performance-server-execution`, created from the existing checkout with all tracked and untracked edits preserved; nothing committed or pushed.

Server checkpoint coordination now uses additive `chat_workspace_checkpoints` rows in sessions.db, capturing a baseline concurrently with model work and recapturing pre/post state for each mutating/unknown tool under the canonical Git-checkout lock. Subdirectory chats share a lock; linked worktrees remain separate. Coordination/child-wait tools never hold this filesystem lock. Legacy builtin file/shell/Git dispatch participates in the same short boundary. Required post-effect capture is awaited before releasing the boundary; uncertainty persists across restart and blocks other checkout writes until authenticated explicit recovery. Review UI exposes checkpoint SHA evidence. No automatic whole-tree undo is claimed across interleaved segments/external user edits. Background-flag mutations are explicitly refused by this checkpoint host rather than claiming their later writes are captured.

New operation/ordering tests prove request-versus-baseline overlap, no premature mutation, two-chat/causal-wait serialization, Stop responsiveness while baseline is pending, interrupted/failed final capture uncertainty, human retirement, nested checkout identity and compatibility renderer dispatch. The current checkpoint suite has nine passing tests; the runtime/execution-host/workspace-preparation combined suite has 39 passing tests. Git restore and ordinary checkout-switch suites also pass. Required checkpoint failures are not labelled successful idle. Diagnostics-only timing events no longer trigger presentation/activity frames.

The server workspace-preparation adapter is now connected ahead of user-input prompt preparation and replaces the execution with its verified final checkout binding. Admission and Retry/Local transport wiring is being integrated with the ordinary-context worker; it is not yet an enabled end-to-end ordinary promotion claim. Native enforcement and new-root/idle routing workers are still active/queued. The branch runner suite retains the baseline board-browser assertion mismatch and Windows native auth-test abort; the latest Chats run passed all server assertions, with an older renderer unsupported-context expectation being updated for the new admission intent.

## Deferred workspace and archive integration follow-up

The deferred adapter is now wired through real admission, runtime, profile-scope rebind and authenticated `/workspace` Retry/Local transport. Its accepted intent commits atomically with the command. Production HTTP fixtures prove isolated file effects and prompt cwd on the first and next turn; failed dependency setup has zero inference; Retry prepares the retained checkout without replaying the failed command; Local retains files. Stop during asynchronous capture commits neither late input nor allocation. The setup panel follows server metadata on remount; 390×844 and 1440×1000 fixture inspections showed no horizontal overflow, explicit progress/error text and keyboard-accessible recovery controls, with no fixture API writes. The initial Vite module-load timeout was corrected by loading the actual fixture module; it was not interpreted as product success. Fixture tabs/server were closed.

Checkpoint journals are exported/imported with conversation archives. Older v1 archives without this additive table still import. Invalid ownership rejects the import before writes; imported executing checkpoints become uncertain. Real-index preservation now also has a deterministic scratch clean-filter test which moves HEAD during collection: capture refuses to claim stability and leaves index bytes untouched. Stop after an already durable effect no longer invents recovery uncertainty.

Latest full repository log `.minnow/chat-performance-branch-full.log` is non-green. Two relevant test failures were corrected: a real npm Retry HTTP fixture now has an explicit 30-second request allowance (normal requests remain five seconds), and the legacy admission assertion expects explicit promotion rather than the obsolete parity wording. A separate route-identity regression now evaluates disabled/unsupported eligibility before requiring the live session object, so a detached legacy failed setup still gives its actionable recovery error. Focused reruns pass. All chat tests pass in `.minnow/chat-performance-continued-all-chat.log`; typecheck, production/headless builds, budgets/discovery, backup, remote, Scheduler and packaged-boundary checks pass on the branch. Existing full-suite failures remain separately recorded; no blanket pre-existing classification is made.

Native installed evidence is now concrete: the four opt-in Windows enforcement tests were independently rerun and passed, no skips or paid inference. See `chat-performance-native-enforcement-evidence.md`: protocol readOnly alone allowed a write, scoped MXC controls enforce tested path/network limits, and an admitted patch can override workspace-read. A trusted host-derived per-execution native contract/approval/recovery bridge is still required, so native-on remains unavailable. Further implementation of that bridge is delegated; schema/OS probe success is not itself a permission grant.

## Default ordinary activation and native-bridge follow-up

The earlier disabled-gate notes are historical. Supported ordinary roots now promote by default; `MINNOW_ORDINARY_CHAT_EXECUTION=0` blocks new promotions without downgrading canonical histories. Parent independently verified the actual production HTTP promotion path, historical context, deferred-worktree cwd and next-turn binding, duplicate receipt recovery and continued server inference after rollback. A completed historical call/result group is now eligible as immutable observations; unmatched/duplicate/orphan groups remain blocked. Stop during promotion profile capture commits no profile/owner. Canonical first inputs receive a bounded fallback title without utility inference or overwriting human titles. Full-fidelity replay of pre-canonical messages without captured settings remains guarded.

Server execution returns a bounded payload-free timing report with its durable command result: 256 tail events, 64 stage totals and an explicit overlapping-intervals label. Shared managed/remote presentation uses the adaptive Markdown scheduler for growing prose, preserves final flush/disposal, and emits local first-received-to-DOM timings including queued observation time. These do not synchronize renderer/server clocks or certify hardware compositor/input budgets. A delayed observer test measures 45 ms with a fake monotonic clock, and queued disposed frames cannot repaint. First-paint diagnostics and stream deltas never become canonical messages.

Parent installed native adapter probes also ran: four opt-in Windows tests passed with real Codex0.166.0 and scripted loopback inference (no paid/account request), covering isolated read/edit/test, dynamic Minnow handoff, scoped denies, revocation and fail-closed missing private authority. The host contract is process-private, baseline/intent-fenced and distinguishes observational native records from executable calls. **It is not yet wired/enabled as a production preference.** Further integration must prove actual host-backed transcript continuity, synchronous live restriction invalidation and native/descendant-process quiescence. A fake permissive callback or an item/completed notification is not that proof. Native switch remains unavailable during this work.

Focused root routing/commands tests pass; actual production runtime suite has 12 passing tests. The latest Chats batch has 520 server tests and all 147 renderer tests passing with one Windows legacy-result-delivery process-teardown abort. Shared chat/activity bridge focused tests pass; all chat tests were rerun successfully after scheduler changes. Typecheck, production/headless builds, bundle budgets and coverage discovery pass; production retains its large-chunk warning. The latest build discovers 1933 test files, 1930 included and 3 excluded. The broad repository suite remains non-green as recorded earlier; no packaged macOS/Linux or measured four-stream input certification is claimed.

Dedicated detached command/server/local-workflow starts now fail explicitly on the checkpointed path instead of presenting an ongoing process as a settled effect. Foreground shell source can itself start descendants, and external programs/editors do not participate in these locks; checkpoint segments are not an OS process sandbox or proof of atomic whole-turn rollback. Native integration must not infer quiescence from analogous shell return/turn events alone.
