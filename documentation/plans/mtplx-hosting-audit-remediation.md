# MTPLX hosting audit remediation

## Status and scope

Repairs implemented and verified locally; see [closeout report](mtplx-hosting-audit-remediation-report.md) for evidence and remaining coverage limits. Unchecked mixed verification items retain their outstanding live/UI or cross-platform portion; local automated gates passed. Section 7 records explicit outcomes in that report, including scenarios not exercised. Based on the October 7, 2026 audit of revision `1e301406` on Apple Silicon, macOS 26.6, Node 24.18.0 and MTPLX 2.12.0.

The work covers all four confirmed integration defects, the nine failures reproduced in the broader test run, and the eager JavaScript budget breach. Untested hosting scenarios are listed separately as verification work. The normal inference path already passed 19 live scenarios; preserve those behaviors throughout.

Local audit evidence: `/Users/henri/.codex/visualizations/2026/10/08/01a11955-a630-7fc3-9359-59a1a826b10e/mtplx-audit/`. Start with `report.txt`; individual evidence files are named below. Capture sanitized payloads needed by tests in repository fixtures so regression coverage does not depend on that local directory. Exclude credentials, tokens, private prompts and machine-specific paths.

## Delivery order

| Order | Work package | Priority | Completion evidence |
| --- | --- | --- | --- |
| 1 | Crash classification and recovery | P1 | Healthy owned daemon restarts once after an unexpected kill |
| 2 | Native activity and idle TTL | P2 | Recent direct API traffic prevents premature unload |
| 3 | Descriptor normalization and cache upgrade | P2 | Real 2.12 controls survive normalization and reach existing installations |
| 4 | Headless library model binding | P2 | Synthetic library selection completes a real tool loop |
| 5 | Agent CLI persistence and path regressions | P2 | All nine reproduced failures pass with their original behavioral assertions |
| 6 | Eager bundle budget | Release gate | Build satisfies every existing budget |
| 7 | Mac hosting and packaged-app closeout | Release gate | Recorded integration matrix, cleanup and restored baseline |

Keep these as independently reviewable changes. Packages 1 and 2 share `serve.js` and should land sequentially. Complete descriptor work before final headless/live verification so tests use corrected capabilities. Bundle optimization follows functional changes to measure the final import graph.

## 1. Classify failures without mistaking successful startup for incompatibility

**Evidence:** `lifecycle.json` and `lifecycle.log`. A healthy daemon killed after more than 30 seconds was classified `model_incompatible`, because `Runtime contract verified` matched the bare word `contract`. No replacement started during 80 seconds of observation.

**Primary files:** `server/models/mtplx-memory.js`, `server/models/serve.js`; regression coverage in `test/models/mtplx.test.mjs` and `test/models/serve-crash.test.mjs`.

- [x] Replace broad positive-word matching with specific failure signatures. Prefer structured exit/error information where available; ordinary successful validation lines must not establish incompatibility.
- [x] Preserve distinct OOM, port conflict, confirmed incompatibility and unknown failure classifications. Unknown unexpected termination remains eligible for the existing bounded restart policy.
- [x] Check restart configuration preservation, including custom port, model/library identity and normalized MTPLX settings. The audit observed omitted fields in the restart call; establish their effect before changing them.
- [x] Test success-log-plus-signal, real validation failure, OOM, port conflict, short-lived startup failure, explicit stop and cancellation. Assert that an eligible owned daemon restarts once, a repeated crash cannot loop, and an external daemon is never restarted or killed.
- [x] Repeat the actual owned-process kill experiment on a scratch server. Verify a new PID, matching model/settings, successful generation and accurate status/logs.

**Acceptance:** The original reproduction recovers automatically within the configured restart/startup bounds; genuine incompatibility and OOM retain their intended policy.

## 2. Base MTPLX eviction on native activity as well as Minnow activity

**Evidence:** `idle-ttl-observation.json`. The owning Minnow server unloaded its daemon about 58 seconds after a successful request through another client, because only its own older `lastUsedAt` governed TTL.

**Primary files:** `server/models/serve.js`, `server/models/mtplx-serve.js`; coverage in `test/models/serve-heartbeat.test.mjs` and `test/models/serve-residency.test.mjs`.

- [x] Read one native health snapshot for the eviction decision. Normalize the installed runtime's `idle_seconds` / last-request timestamp semantics and units, including whether they represent request start or completion.
- [x] Combine native recent activity with owner-local activity. Active/queued requests remain protected; completed requests from another client renew the effective idle window. Bound invalid/future/stale values and handle clock skew explicitly.
- [x] Preserve the current conservative behavior when health is unavailable, disabled TTL semantics, and the rule that external serves cannot be evicted. Keep other engines' TTL behavior unchanged.
- [x] Use injected time and health responses to test recent completed traffic, active/queued work, expired idle time, malformed/absent fields, health failure, TTL disabled and external ownership. Assert that unchanged old native timestamps do not renew TTL forever.
- [x] With a short TTL on an isolated owned daemon, send repeated short requests directly to its endpoint across several heartbeat intervals; then stop traffic and verify eventual eviction exactly once.

**Acceptance:** A request through any client protects the hosted daemon for the configured idle window, and a genuinely idle owned daemon still unloads.

## 3. Normalize real descriptors and refresh existing caches

**Evidence:** `lifecycle.json` (`descriptorMismatch`). Actual controls live at `health.startup.model_controls`; current normalization misses them. Inspect uses `mtp_supported: "yes"`, and health supplies a profile object.

**Primary files:** `server/models/mtplx-descriptor.js`, `server/models/mtplx-settings.js`, `src/models/mtplx-settings.ts`, `src/ui/models/mtplx-load.ts`; tests in `test/models/mtplx*.test.*`.

- [x] Add sanitized real inspect/health fixtures from MTPLX 2.12.0, retaining coverage of supported older payload shapes.
- [x] Prefer `startup.model_controls` for health; retain legacy locations as fallbacks. Normalize the profile to its name and support flags through an explicit allowlist of accepted values, never generic JavaScript truthiness.
- [x] Preserve architecture, backend/support metadata, reasoning modes/effort, sampling defaults, draft bounds, context bounds and KV modes. Reject malformed fields conservatively.
- [x] Keep health authoritative over inspect for the same model. The health maximum of draft depth 3 is valid; do not restore the older contract maximum of 6 over it.
- [x] Version descriptor normalization in the cache. Treat old/unversioned entries as stale in every read path and in the health-precedence write guard; otherwise an old health entry can block replacement. Include the version in in-flight deduplication as appropriate.
- [x] Test upgrade from an existing broken cached health descriptor, concurrent inspect/health writes, model-file changes, and precedence within the current version. Refresh metadata without discarding user launch preferences.
- [ ] Verify the Load inspector against the actual daemon: reasoning/sampler controls, profile defaults, depth clamping, saved overrides, and MTPLX ↔ mlx-lm switching.

**Acceptance:** Normalized descriptors reflect actual runtime capabilities, contain the expected scalar/types, and correct themselves after upgrade without manual cache deletion.

## 4. Resolve headless library selections before ordinary provider fallback

**Evidence:** `headless.log` and `headless-tool-loop-enabled.json`. `minnow-library` + `mtplx:<repo>` fell back to LM Studio; the corresponding direct MTPLX binding completed a file-reading tool loop.

**Primary files:** `src/headless/runner.ts`, `src/agents/resolve-work-agent-binding.ts`, `src/models/library-request-binding.ts`, `src/models/model-select-library.ts`, `src/models/api-client.ts`. Reuse the behavior of `server/models/library-binding.js` and existing model load APIs.

- [x] Preserve the requested provider/model pair through work-agent selection. Recognize synthetic library IDs before a registry lookup can replace them with the active provider. Specify and test CLI, persisted chat, work-agent override and default precedence.
- [x] Resolve a live library selection to its actual serve provider/model through the shared client binding helpers. For a cold selection, use existing model load APIs and bounded, cancellable readiness waiting; honor saved engine choice and duplicate-load reuse.
- [x] Keep server-side store/process modules out of the headless client bundle. Avoid introducing a second engine mapping or an independent load policy.
- [x] Fail clearly for unavailable/invalid requested models and explicit unknown providers. Do not silently send the prompt to an unrelated provider. Preserve direct provider and router behavior.
- [x] Cover adopted, owned, starting and cold MTPLX serves; saved mlx-lm engine preference; unavailable/incomplete models; load timeout/cancellation; GGUF/MLX library regressions; and persisted follow-up turns.
- [x] Run the synthetic-binding CLI against the real scratch server and complete the opaque-marker `read_file` loop. Verify both source execution and `dist-headless/minnow-run.mjs`, including a Scheduler invocation.

**Acceptance:** A library model selected in the UI works with the same identity in the CLI and Scheduler, with observable load failures and no unintended provider fallback.

## 5. Resolve the nine broader Agent CLI failures

These failures were reproduced independently; they have not been established as MTPLX regressions. Evidence: `cli-recheck.log` and `scoped-tests.log`.

### Two Codex Windows-shim fixture failures on macOS

**Files:** `test/generations/agent-cli-resolve-bin.test.mjs`, `server/generations/agent-cli/resolve-bin.js`.

- [x] Confirm the resolver's canonical-path contract and compare expected nested/hoisted native payload paths using `fs.realpath`, consistent with existing canonical-path assertions.
- [ ] Preserve coverage for missing/custom wrappers, legacy layout, arguments and display path. Validate on macOS, Linux and Windows; do not alter production resolution solely to retain `/var` instead of `/private/var` in a fixture.

### Seven Claude persistence/resume failures

**Files:** `test/generations/agent-cli-persistence.test.mjs`, its native-session fixture, and `server/generations/agent-cli/{session,claude-state,claude-interactive,checkpoints}.js`.

- [x] Instrument test-only transcript discovery, child `cwd`, canonical workspace identity and checkpoint rejection reasons. The missing transcript path and macOS temp aliases are a concrete lead, not yet a proven explanation for all seven failures.
- [x] Reproduce with canonical and aliased scratch roots. Establish one consistent directory identity for native transcript creation/discovery. Determine whether the mismatch is in the fixture, production code, or both before applying the narrow fix.
- [x] Retain assertions for clean checkpoints, incremental resume after shutdown, complete-stream-before-handoff, resumed budget turns, tamper detection, exactly-once tool execution and interrupted handoff recovery. Do not relax integrity checks or turn expected resume into expected rebuild merely to pass tests.
- [x] Verify existing checkpoints across any production path-identity change: resume only verified matching history and rebuild explicitly when identity cannot be established safely.
- [ ] Run all Agent CLI tests, including Cursor and Codex paths, on macOS and the existing Windows/Linux CI matrix.

**Acceptance:** All nine original failures pass, with checkpoint integrity and exactly-once tool semantics preserved. Record which failures were fixture-only and which required production repairs.

## 6. Bring the final build within existing budgets

**Evidence:** `budgets.log` and `build.log`. Eager JS was 4,816.8 KB against 4,800 KB, 61.2 KB above the recorded baseline. Other budgets passed, but total assets were already 10,997.2 KB against 11,000 KB.

**Files:** `vite.config.ts`, affected import sites, `scripts/check-performance-budgets.mjs`, `scripts/bundle-size-baseline.json`.

- [x] Rebuild after functional changes and inspect the entry/modulepreload dependency graph. Trace mixed static/dynamic imports and the large shared chunk named for preview visibility; the chunk name alone does not identify the cause.
- [x] Remove accidental eager reachability or defer a genuinely optional feature at its existing boundary. Measure both eager bytes and total assets to avoid trading one breach for another through duplication.
- [x] Preserve necessary preloads and boot behavior. Do not hide required modules from accounting or raise ceilings merely to clear the audit failure.
- [ ] Verify cold boot, first editor/preview/model-inspector use and the boot budget harness. Update the baseline only after accepting the measured final graph.

**Acceptance:** All unchanged bundle ceilings and startup checks pass, with before/after sizes recorded and useful headroom where practical.

## 7. Close the remaining verification gaps

Use a scratch `MINNOW_HOME`, isolated ports and test-owned processes. Snapshot the user's current model/settings before tests that require temporarily freeing memory; restore and verify that baseline afterwards. Never remove user model weights or include `.key`/session tokens in test artifacts.

| Scenario | Required verification |
| --- | --- |
| Existing 19 live scenarios | Repeat discovery, adoption, reuse, plain/streamed text, reasoning, tools, vision, cancellation/recovery, concurrency, metrics, routing, preferences, incomplete-model rejection, logs and ownership checks |
| Crash and TTL | Run packages 1–2 together; ensure cancellation/intentional unload cannot race into auto-restart |
| Real download | Use an isolated MTPLX cache and the smallest available compatible target; verify completion/discovery, interruption, duplicate reuse and preservation of pre-existing files. Record bytes and cleanup; mocked cancellation alone is insufficient |
| Authenticated non-loopback hosting | Use an isolated profile and controlled interface; verify key propagation, authorized success, rejection of missing/wrong keys, and redaction in logs/diagnostics |
| Large-model admission | Test admission rejection deterministically; load large available models serially only when measured memory permits, and restore the original model. Record explicit hardware limits rather than treating unrun loads as passes |
| Long context and sustained load | Increase context/workload in bounded steps while measuring memory, errors and cancellation. Record the maximum actually exercised; a 262k configuration is not proof of 262k token saturation |
| Packaged Mac app | Build the Mac artifact with existing packaging commands; verify runtime detection, descriptors, owned/adopted serving, restart/TTL and bundled CLI/Scheduler without development-only dependencies |
| Unsupported hosts | Unit-test Intel/Rosetta/older-macOS gates; distinguish simulated coverage from actual hardware runs |

Promote repeatable live checks into an opt-in audit script that accepts model IDs, ports and a scratch home, validates ownership before signaling a PID, cleans up in `finally`, and emits a sanitized results manifest. Keep normal unit tests independent of a local MTPLX installation and large weight downloads.

## Final gates and documentation

- [x] Run relevant model, lifecycle, headless, Scheduler and library-binding tests using their registered runner profiles; ensure new regression files are discoverable.
- [ ] Run `npm run test:agent-cli`, `npm run test:runner`, `npm run test:scheduler`, `npm run test:check-coverage`, `npx tsc --noEmit`, and `npm test`. Run the existing cross-platform CI gates before release; investigate any additional full-suite failures rather than assuming the earlier scoped audit covered them.
- [x] Run `npm run build`, `npm run headless:build`, `npm run check:performance-budgets`, and the packaged-Mac checks above. Inspect generated-file changes and retain only intentional updates.
- [x] Update `documentation/context.md` with descriptor cache versioning, corrected activity semantics, headless binding behavior and the verified runtime baseline. Update affected manual/CLI documentation only to describe the shipped result.
- [x] Produce a closeout report mapping every finding to its fix, regression test and live result. Include final test totals, bundle sizes, remaining hardware-dependent coverage limits, and proof that original serving state was restored.

Done means all four defects are reproduced by regression coverage and fixed, all nine named test failures are resolved, existing performance budgets pass, and the live/package matrix has explicit outcomes. Any scenario that cannot be exercised remains an identified coverage limit, not a claimed pass.
