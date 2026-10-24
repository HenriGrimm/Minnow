# 12. Quality, performance, documentation and hidden surfaces

Date: 2026-10-23. Baseline: ba2068d1c5353f86287f9a02b665fb7ea0bbac3f. Source/contract review with primary-reviewer verification reused explicitly.

## Assessment

Minnow has substantial quality infrastructure: cross-platform test CI, automatic discovery, deterministic core invariants, production-boundary fixtures, generated inventories and enforced bundle ceilings. The review nevertheless found consequential defects in the seams between otherwise-tested components. The right next investment is a small set of durable user-journey invariants and fault-injection scenarios, not simply more helper assertions or a wholesale rewrite.

The user-confirmed direction is chat-driven building at the center. Some product text still leads with IDE/editor implementation and treats chat-led use as an optional alternative. That is a product alignment task. It should not be confused with an already-shipped feature, a reason to expose unfinished apps, or evidence that the current editor capability should be removed.

## Scope

Read/sampled CI workflow/branch-protection guidance; `test/{run-all,test-config,check-test-coverage}.mjs`; relevant product-wiki catalog/copy tests; budgets and budget analyzer/check wiring; boot-ready and lazy Code initialization; app registry/preferences/router/launch gate; entry points and representative dependencies for Compare, Benchmarking, Experts and Research; README, PRODUCT.md, architecture inventory, commands and selected manual pages.

Earlier section reviews supplied integration examples and independently runnable evidence. Root's verification ledger and artifacts were read and reused, not independently rerun here. No new build/full suite. This is not a complete audit of every test's assertions, generated-file reproducibility, every hidden feature's algorithm, every manual paragraph or native platform.

## Good

- **Tests are discoverable rather than manually registered one by one.** The harness batches by runner, provides the necessary mock/CSS/terminal loader profiles, caps parallelism and avoids Windows command-line limits (`test/run-all.mjs:53`; `test/test-config.mjs:11`). The coverage command correctly checks discovery registration, not line/branch coverage.
- **CI checks more than TypeScript.** Three OS lanes run typecheck/tests; separate jobs validate product wiki, architecture inventory, deterministic board scenarios, bundle budgets, the Tailscale helper and installed Codex protocol (`.github/workflows/ci.yml:16`, `:37`, `:94`).
- **Several tests cross real boundaries.** Local Git merge/checkpoint cases, disk journals across restart and actual headless CLI/shared-runtime fixture tests are stronger than source-string tests alone. Preserve them.
- **Critical orchestration decisions have pure cores.** Replay, policy totality and purity guards make failure behavior inspectable and limit accidental state divergence.
- **Architecture inventory is generated from actual registries.** It currently records 121 tools, nine released apps, four hidden apps and 22 bundled skills (`documentation/contributor/architecture-inventory.md:8`). This is a useful source of truth.
- **Hidden UI remains gated.** Registry/preferences/router/agent launch all filter availability; retained code/data/tests are compatible with hiding unfinished surfaces rather than deleting their history.
- **Performance budgets are executable.** Root's fresh scratch Vite graph passed its existing ceilings. Boot code separately gates CSS and chrome readiness, instead of dismissing the loader after a fixed arbitrary delay.

## Verified state from the primary reviewer

Source: `documentation/reviews/2026-10-23/evidence/root-verification-ledger.md` and `bundle-metrics.json`. These were performed by root, not by this section reviewer.

| Check | Observed result | What it establishes |
|---|---|---|
| `npx tsc --noEmit` | Exit 0 | Current frontend TypeScript graph typechecks |
| Test discovery | 1,773 files; 1,770 in npm test; three intentional exclusions | Runner registration, not behavioral/branch coverage |
| Architecture check | Pass | Generated registry inventory matches source |
| Fresh scratch Vite build | Exit 0 | Frontend bundles using existing generated inputs; npm prebuild not run |
| Fresh bundle budgets | No breaches | Static asset ceilings pass |
| Five boot/theme/a11y files | 83 passed | Their harness/token/structural assertions, not whole-product visual accessibility |
| Live UI evidence | Separate root observations | Only observed states/screens; inconclusive scans excluded |

Fresh asset metrics are uncompressed: entry JS **347.8 KB**, CSS **769.8 KB**, largest lazy JS **3,314.9 KB**, eager JS **4,372.3 KB** across **84 chunks**, total JS/CSS assets excluding data packs **11,707.2 KB**. Total ceiling is **11,725 KB**, leaving **17.8 KB**. This is headroom information, not a measured latency or user-perceived speed score.

## Findings

### 12-01 [P2] A failed Code initialization step is permanently marked initialized

**Cross-reference:** this is the same recovery limitation discussed under report 02 R4, independently traced here. Count it once in the comprehensive findings register.

**Evidence:** `src/boot/code-workspace-modules.ts:18` catches each surface initialization error and logs it, allowing later surfaces to initialize. After that, `:83` sets the whole module initialized; future calls return immediately at `:28`. The outer catch only resets the memoized promise when an uncaught failure escapes. The existing test explicitly expects no second attempt after a failing file-panel initialization (`test/boot/code-workspace-modules.test.mts:97`).

**Trigger:** a recoverable error is thrown by initFilePanel/initTerminalPanel or another independently wrapped step on first activation.

**Impact:** the rest of Code survives, which is good, but the affected surface cannot recover merely by returning to Code or retrying its initialization entry point. It remains broken until reload. The current test validates non-rejection, not successful recovery.

**Confidence:** high from source and test contract; no live transient module failure was induced in this section.

**Repair:** retain per-step success/failure and retry failed idempotent steps while keeping successful surfaces intact. Show an actionable recovery state. Keep the existing failure-isolation test and add first-call-fails/second-call-succeeds behavior.

### 12-02 [P2] Shipped manual instructions still describe removed orchestration behavior

**Evidence:** `documentation/manual/concepts/modes.md:37` says Orchestrate calls delegate_tasks. The current shipped tool catalog contains no such tool; V2 plans create journals through `src/ui/orchestrate-launch.ts:9` and `src/orchestrator/client.ts`. The current board-agent manual correctly says server scheduling drives Builder/Tester roles (`documentation/manual/orchestrate/agents.md:1`), so the manual itself presents competing models.

**Trigger:** a user or General-mode docs tool consults Modes to learn how to delegate a board.

**Impact:** the in-app assistant can cite a shipped official instruction for a path the app no longer provides. This is more material than wording polish because manual tools intentionally return these pages as authoritative help.

**Confidence:** high; local catalog/source and manual comparison.

**Repair:** rewrite Modes around the actual Plan→board handoff, manual/automatic board controls and server-owned attempts. Retain legacy schemas only in contributor/history notes. Add a generated-vocabulary check for named tools in authoritative usage examples.

### 12-03 [P2] Windows sandbox guidance contradicts the runtime's supported policy

**Evidence:** `documentation/manual/reference/privacy-and-security.md:60` describes Require on Windows executing sandboxed commands in WSL; `:62` then says Require is unavailable and stored values become Prefer. Runtime clamps require to prefer on Windows (`server/terminal/sandbox/mode.js:22`); Settings explicitly displays that limitation (`src/ui/settings-shell-sandbox.ts:81`).

**Trigger:** a Windows user follows the stronger paragraph to configure unattended execution.

**Impact:** the reader can believe they selected fail-closed Require behavior while the runtime supports a different mode. The adjacent accurate paragraph does not remove the contradiction.

**Confidence:** high from direct documentation/runtime comparison.

**Repair:** document exactly the current Windows behavior once, distinguish Prefer's approval fallback from fail-closed Require, and make the platform policy a shared source for Settings/manual capability statements. No request here to ship new native sandbox support.

### 12-04 [P2] Branch-protection instructions omit newer CI gates

**Evidence:** `.github/BRANCH_PROTECTION.md:10` lists typecheck/tests, product wiki and board scenario contract as required checks. It omits the workflow's performance budgets, tailnet sidecar and installed protocol jobs (`.github/workflows/ci.yml:16`, `:37`, `:94`).

**Trigger:** a maintainer configures repository protection by following the committed guide.

**Impact:** those jobs run and can fail visibly, but the documented required-check set does not ensure their failures block merging. Actual repository protection configuration was not queried, so this finding concerns guidance, not a claim about the current GitHub settings.

**Confidence:** high for the documented gap.

**Repair:** define the intended required-check set centrally, update the guide and verify branch protection administratively. State whether release-only/platform jobs are advisory or required.

### 12-05 [P3] Static counts and surface descriptions drift despite the generated inventory

**Evidence:** README says 110 tools (`README.md:144`) and nineteen bundled skills (`:154`); first-chat says nineteen (`documentation/manual/get-started/first-chat.md:78`), while generated inventory says 121/22. Apps overview describes Scheduler as a side panel (`documentation/manual/apps/overview.md:41`), while the current app entry mounts the Scheduler stage (`src/ui/scheduler-page.ts:132`; `index.html:2096`). Released Reef is absent from several fixed rail/manual rosters, although its final product placement is still explicitly undecided by the user.

**Trigger:** installation/onboarding/help, or a General chat answering from shipped docs.

**Impact:** low-level inconsistencies reduce trust and make help harder to follow. Reef omission should be resolved with the placement decision, not by claiming it is hidden when the current registry marks it released.

**Confidence:** high for counts and current code shape; Reef placement remains a product decision.

**Repair:** reference the generated inventory instead of duplicating counts; audit pages against the current navigation and remove abandoned surface descriptions. Maintain a small release checklist for help examples, screenshots and first-run vocabulary.

## Integration-test priorities supported by observed defects

Missing tests alone are not a bug. The following recommendations are grounded in failures reproduced in other section reports even while selected existing suites passed.

| Product invariant | Evidence from this review | Test should cross |
|---|---|---|
| A delegated task keeps its owner and reaches the originating issue | Shift+A overwrite and untracked V2 handoff (03) | Actual keyboard/action→admission→board terminal journal→issue refresh |
| Approval lands the contents shown | Dashboard/PR identity contracts (04) | Inspect→branch mutation→approve→server rejection |
| One profile has one encryption key | 32 success/31 decrypt failures (08) | Concurrent first encryption in same and separate processes |
| Revocation stops remote control | Existing terminal socket still accepts input (08) | Real authenticated WS→revoke→input refusal |
| Restore chooses one coherent timeline | Forced exit leaves mixed roots (08) | Child process death at each rename boundary→boot recovery |
| A bad job does not stop healthy work | Corrupt row aborts dispatch list (09) | Persisted malformed prompt→real tick loop→healthy admission |
| Timeout/output caps preserve observable results | Stuck slot/missing chat link (09) | Child lifecycle/result protocol→history→UI outcome |
| Workspace changes preserve draft scope | Root/Code reviewer races | UI selection/request completion ordering→file/terminal/save behavior |

Do not replace these with tests that only assert helper output or source strings. Keep small pure tests for edge cases, then add a few deterministic journey fixtures that assert the user's state across the seam. The existing production-boundary fixtures are a suitable pattern when isolated correctly.

## Performance and maintainability proposals

### Performance

- **Measure the real path separately from the loader harness.** `test/boot/boot-budget-ci.test.mts:54` supplies CSS/chrome readiness after 12 ms; it proves the gate waits correctly, not that the full Electron/Node/SPA initialization completes within 2.5 seconds. Add opt-in cold/warm installed-start measurements, first usable chat, project switch and large-history reopen, with host specs and p50/p95.
- **Treat bundle headroom as a decision point.** Budgets pass but total assets have only 17.8 KB left. The rationale contains many incremental ceiling increases. Prioritize measured import/route ownership and retained-memory work before automatically raising the next ceiling.
- **Inspect eager dependencies, including hidden surfaces.** Lazy app loaders exist, yet shared UI modules statically reference legacy feature dependencies and some lifecycle cleanup eagerly imports hidden modules, for example Experts when Settings opens (`src/ui/settings-page.ts:443`). This is an optimization hypothesis, not a claim that removing those imports will save a particular measured size.
- **Distinguish health metrics.** Static bundle sizes, loader correctness, main-thread long tasks, process memory and perceived responsiveness answer different questions. No overall speed score is justified by the current checks alone.

### Maintainability

Large modules are a coordination risk, not automatically defects. Sampled files include issues-page (3,168 lines), sessions (2,586), issues-store (2,489), boards-view (2,365), benchmark-page (2,263) and issues-detail (2,098). Split at stable contracts: task identity/admission, workspace-scoped operations, delivery receipts, state reconciliation and view lifecycle. Do this while fixing observed behavior, with cross-surface tests, rather than scheduling a broad cosmetic decomposition.

Several bugs show a newer strong path alongside an older weaker one: Issues reviewed merge versus Dashboard merge, V2 board ownership versus legacy issue agent slots, generated inventory versus hardcoded docs. Consolidating contracts and retiring unused callers is a higher-value maintenance action than making every feature share one large controller.

Test harness timeouts/force-exit and mocks have practical value, but separate process-leak/cancellation tests should assert that resources close before forced test exit. A passing process forced closed by the runner is not itself proof of graceful application shutdown.

## Hidden surfaces: sampled architecture and release boundary

| Surface | Retained implementation sampled | Shared dependencies and release assessment |
|---|---|---|
| Compare | `src/ui/compare-page.ts`, compare persistence/stream/win-rates; `server/compare/routes.js` | Blind multi-model generations, votes/reveal/history, continuation into Code. Open path checks availability (`compare-page.ts:817`). Backend routes remain registered/authenticated. |
| Benchmarking | `src/ui/benchmark-page.ts`, campaign runner, matrix scheduler/model lifecycle entry points | Integration, standard/custom packs, provider/model loading and saved campaigns; open path checks gate (`benchmark-page.ts:2102`). Retained test/model utilities are not evidence it should ship. |
| Experts | `src/ui/experts/experts-hub.ts`, expert runtime/tool policy, settings integration | User personas/snapshots/chats depend on the shared session and tool catalog. Hub open is gated (`experts-hub.ts:673`); hidden legacy records can still need compatibility. |
| Research | `src/research/panel.ts`, server routes and representative engine/store interfaces | Research runs, sources, reports and model calls. Registry explicitly marks it hidden; normal app routes and launch tools reject it. Server routes still exist. Broken release status should remain hidden pending a separate decision. |

The app gate is a **product availability** mechanism, not deletion and not an API security policy. Hidden apps remain in backups, stores, types, tests and some shared dependency paths. Do not remove them opportunistically during chat-first polishing; first map persisted compatibility and reused capabilities. If the intended gate also means no hidden backend work may be started, define and test that separate runtime contract explicitly.

No hidden-app execution or real-provider campaign was run, and no full hidden feature correctness verdict is claimed.

## Documentation and product direction

**Proposal, not current shipped behavior:** introduce Minnow as “describe a result, supervise the work, try the result, ask for changes, approve delivery.” Explain the project/editor/terminal/git as tools available for inspecting and directing that work. Current README's “You can also never look at code and just chat” (`README.md:98`) makes the user-confirmed center sound optional.

Keep implementation truth separate from that repositioning. The manual should continue to explain actual permissions, failure recovery, verification limitations and costs. Claims such as Plan cannot edit code must be corrected alongside the underlying traversal defect documented by root; changing prose alone does not repair the policy.

Reef's placement is unresolved. Its current released implementation should be acknowledged accurately while the comprehensive report evaluates a separate app, an approachable build flow or deeper shared-workspace integration as alternatives. Do not present any one option as approved.

## Checks and limitations

- Reused root's typecheck, discovery, architecture, fresh scratch Vite/budget and 83 boot/theme/a11y results with attribution above; none rerun by this section.
- Read existing Code boot, app availability and product-wiki test assertions to assess their exact contracts. Those reads are not new passing runs.
- Earlier assigned sections ran scoped tests and synthetic reproductions; see reports 03/04/08/09 for exact batches.
- No full suite, current packaged rebuild, external GitHub state/branch-protection read or broad hidden-surface runtime execution.
- Root's live observation ledger explicitly excludes zero-check axe results, a hung Scheduler axe scan and a mislabeled mobile screenshot. Those cannot support broad accessibility/responsive conclusions.
- Runtime isolation exception from 08/09 remains: an already-running packaged-boundary failure fixture may have written synthetic diagnostics to the hardcoded real-home debug path. No live diagnostic or credential contents were inspected.
- Final synthesis update from report 10: one existing Reef UI picker expectation failed and repeated, while 63 native and 21 UI assertions passed. The current grouped provider browser differs from the test's immediate flat-option expectation. This needs a test/interaction-contract correction with CLI selection coverage retained; the selected suite results are therefore not uniformly green.

## Recommended quality work order

1. Repair reproduced loss/authority/scope failures with invariant tests.
2. Close the task ownership and reviewed-revision seams.
3. Make failed initialization, malformed records and interrupted processes recoverable.
4. Refresh shipped usage/security docs and required-check guidance from current contracts.
5. Establish real-user performance baselines and trim verified eager costs.
6. Then consider larger module decomposition and hidden-feature product decisions.

