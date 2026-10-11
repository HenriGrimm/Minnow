# MTPLX hosting repairs — closeout

Implemented against the October 7, 2026 audit of revision `1e301406`. Verified on Apple Silicon, macOS 26.6, Node 24.18.0 and MTPLX 2.12.0. Changes remain in the working tree; no release was published.

## Findings and repairs

| Finding | Repair | Regression and live evidence |
| --- | --- | --- |
| Successful startup text suppressed crash recovery | Match actual incompatibility/allocation failures; retain healthy stretches across heartbeats. Restart preserves port, hardware, weights, library identity and settings. | `mtplx.test.mjs`, `mtplx-crash.test.mjs`, `serve-heartbeat.test.mjs`; actual owned daemon SIGKILL recovered with a new PID, same port/settings and successful inference in source and packaged hosts. |
| Direct endpoint traffic did not renew idle TTL | Normalize native completion timestamps in epoch seconds, with idle-seconds fallback; combine with local activity and active/queued work. Unavailable health defers eviction. | Injected clock/health regressions; six direct requests across multiple 15-second idle windows kept the daemon alive. After traffic stopped, the final package evicted it after 18.8 seconds of native idle time. |
| MTPLX 2.12 controls/profile/support flags were misread | Prefer `startup.model_controls`; normalize profile name, accepted support flags, architecture, reasoning and sampler defaults. Version cache entries and refresh live persisted serves at boot. | Sanitized 2.12 fixtures, cache upgrade/precedence and malformed-field tests. Actual health depth maximum 3 stays authoritative over inspect maximum 6. Packaged UI showed `auto`, `xhigh`, `medium`, `low` effort choices. |
| Headless synthetic library binding fell back to LM Studio | Preserve explicit CLI binding through work-agent selection; resolve library models through authenticated `/api/models/library/bind` and the shared server loader. Strict provider validation and cancellable readiness avoid unrelated fallback. | Headless/HTTP regressions cover cold loads, saved mlx-lm engine choice, adopted reuse, invalid providers/models and cancellation. Source CLI completed an opaque-marker `read_file` loop. Actual packaged Scheduler cold-loaded MTPLX Bare Speed and completed the same tool loop with its bundled runner. |
| Two Codex shim assertions failed on macOS temp aliases | Compare canonical fixture paths with `fs.realpath`; production resolver stays unchanged. | Original path assertions pass; missing/custom/legacy wrapper coverage remains. |
| Seven Claude checkpoint/resume tests failed | Canonicalize the private native working directory before invocation and transcript discovery, aligning `/var` with `/private/var`. | All seven original failures pass; checkpoint integrity, tamper rejection, incremental resume and exactly-once tools retain their assertions. |
| Eager JavaScript exceeded its budget | Load spreadsheet import/export modules only when those actions run. | Build passes every unchanged ceiling; baseline refreshed. |
| Full-suite browser profile cleanup raced with helpers | Kill the owned detached browser group even when its parent exits first, and await inherited stdio closure before cleanup. | New helper regression and actual 20-cycle Chrome teardown test pass. |
| Full-suite editor fixture omitted a newly required export | Add the missing mocked descriptor fetch to that fixture. | Editor binding test passes; production behavior unchanged. |
| Live Load panel reset sections/scroll on status updates | Preserve each model's expanded groups and scroll position through remounts. | New UI regression passes; final Mac package retained expanded Reasoning and scroll while serving and polling. |

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 11,920 discovered tests: 11,884 passed, 36 skipped, zero failures |
| `test:agent-cli` | 253 passed, 5 skipped, zero failures |
| `test:runner` | 292 passed, 1 skipped, zero failures |
| `test:scheduler` | 63 passed, zero failures |
| Final descriptor/heartbeat and Load panel checks | 25 + 5 passed after the final metadata/UI refinements |
| Product wiki | 13 passed; shipped manual catalog regenerated |
| Compiled in-process host boundary | 5 passed |
| Test coverage gate | 1,618 files: 1,615 included, 3 intentionally excluded |
| TypeScript, SPA build, headless bundle, Electron compilation | Passed; headless bundle has only Node builtin external imports |
| Existing live integration scenarios | 19/19 passed: discovery, diagnostics, adoption/reuse, plain/streamed replies, reasoning, tools, vision, cancellation/recovery, concurrency, native metrics, routing, preferences, incomplete-model rejection, logs and ownership |
| Unsigned arm64 Mac package | Built and booted from `app.asar` with an isolated profile; verified runtime detection, controls, adoption, owned serving, restart, native idle handling and actual bundled Scheduler tool loop |
| Reusable lifecycle script | Passed against the final Mac package; restart PID 27530 → 29370, native traffic 37.8 seconds across idle windows, eventual eviction after 18.8 seconds idle |

The full suite preceded two final, narrow additions: conservative malformed descriptor fields and Load panel view-state retention. Their focused regressions, type check, build, budgets and final packaged/live checks passed afterwards.

### Final bundle measurements

| Measurement | Final KB | Existing limit KB |
| --- | ---: | ---: |
| Entry JavaScript | 287.8 | 1,500 |
| Entry CSS | 718.6 | 950 |
| Largest lazy JavaScript | 3,195.7 | 3,900 |
| Eager JavaScript | 4,329.3 | 4,800 |
| Total assets | 10,994.2 | 11,000 |

Eager JavaScript fell from 4,816.8 KB to 4,329.3 KB. Total assets retain only 5.8 KB of headroom, so later additions still need budget checks. No ceiling was raised.

## Repeatable verification and local evidence

[`scripts/audit-mtplx-lifecycle.mjs`](../../scripts/audit-mtplx-lifecycle.mjs) is an opt-in real-runtime audit. It accepts a scratch home, loopback host, installed library model, unused port and output manifest. It rejects the normal profile and existing serves, verifies ownership/model before signaling a PID, cleans up owned serves in `finally`, and excludes credentials from its output. Usage is in [contributor commands](../contributor/commands.md#opt-in-mtplx-lifecycle-audit).

Local logs and sanitized result manifests are under `/tmp/minnow-mtplx-repair/`: `full-tests-final.log`, `results.json`, `repair-lifecycle.json`, `packaged-verification.json`, `reusable-lifecycle.json`, `budgets-final.log` and `cleanup.json`. The unsigned app is `/tmp/minnow-mtplx-repair/package/mac-arm64/Minnow.app`. This temporary directory is local evidence, not a durable release artifact. Repository regression fixtures are under `test/fixtures/mtplx/`.

## Coverage limits

Real multi-gigabyte download/interruption/reuse, authenticated non-loopback hosting, long-context saturation, and serial loads of the 99/107 GB models were not exercised in this repair pass. Their existing unit coverage passed, but that does not establish live acceptance. Loads/inference exercised the available 27B models at 4K/8K configured context, with short prompts; a 262K descriptor/configuration is not saturation evidence.

The Mac package was deliberately unsigned and unnotarized. Signing, notarization, installer/update distribution, Windows/Linux CI and physical Intel/Rosetta/older macOS hosts were not run here. Unsupported-platform gates were tested with injected platform/architecture/release values.

## Cleanup

All model loads, settings edits, jobs and package checks used `/tmp/minnow-mtplx-repair/home`; the Electron profile and HOME were isolated too. Test jobs were deleted and owned model processes were stopped. The test-created external daemon was terminated after ownership checks. Ports 19473, 19488 and 8088 returned to their pre-repair inactive state. The original user server PID 12782 remained on port 9473. User weights and the live `~/.minnow` profile were not removed or rewritten. Unrelated generated fixture/reliability/registry changes were restored; the bundle baseline and manual catalog changes are intentional.
