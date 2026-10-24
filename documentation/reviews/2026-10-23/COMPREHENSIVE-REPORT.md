# Minnow comprehensive review

Review date: **2026-10-23**, America/Los_Angeles. Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`.

Twelve section reports were produced by three specialist review agents. The primary reviewer read all twelve, cross-checked major source contracts, independently reran the principal synthetic reproductions, and synthesized the findings below. The delivery/security reviewer also checked this synthesis for evidence overclaims.

## Product standard

The user confirmed this direction during the review:

> Chat-driven building should be the center. Code is the central workspace and mainly a chat. People increasingly care about the result rather than the actual code.

Minnow serves an individual builder who describes a goal, collaborates with agents, tries the result, asks for changes, and decides what to keep or ship. The editor, terminals, model hosting, Git, issues, boards and knowledge make that journey possible. Direct coding remains valuable, but editor feature parity alone is not the measure of success.

The practical acceptance question is: **Can someone get from a described goal to a working, understandable, reviewable result while trusting the conversation, working location, progress and recovery controls?**

Reef's placement remains undecided. The user finds it useful inside Minnow but feels it is out of place. This review treats implementation quality and product placement as separate questions; a separate distribution is not an approved requirement.

## Main conclusion

Minnow has a substantial shared foundation worth preserving: one runner, persistent conversations, recoverable context, scoped worktrees, model transport abstraction, isolated previews, and deterministic orchestration. It already contains many of the mechanisms needed for chat-driven building.

The most serious weaknesses occur **when ownership or lifecycle crosses a boundary**: between concurrent chats, checkouts, issues and boards, reviewed and subsequently changed revisions, encrypted records and their key, scheduled admission and completion, or a partially applied restore and normal startup. These are concrete trust problems, rather than evidence that the entire architecture needs replacement.

The product opportunity is to make Code the stable conversation through which users understand and supervise their work. Supporting surfaces should add evidence, context and control without requiring users to reconstruct the state of the build themselves.

## How to use this review

- Read this synthesis for the decisions and order of work.
- Use the section reports for detailed triggers, source lines, confidence, strengths, repairs, and boundaries not reviewed.
- Use `evidence/` for reproducible synthetic cases, raw checks and screenshots. Some reproduction scripts intentionally fail an invariant; others assert the current undesirable behavior and exit successfully. Neither is a production regression test until repaired and inverted appropriately.
- Separate **confirmed behavior**, **source-traced defects**, **risks requiring another reproduction**, and **product proposals**. A product proposal is not a claim that a feature is shipped or a commitment to implement it.

This is a broad, bounded review, not an assertion that every line, supported operating system, provider, real model or installed workflow was tested.

## What is good and should be preserved

| Foundation | Why it matters for chat-driven building |
|---|---|
| Shared turn runner with injected capabilities | Foreground chat, background agents and headless work can evolve around common execution rules. |
| Incremental transcript persistence, paired tool results and recallable originals | Failure or compaction need not erase the investigation or the evidence of what happened. |
| Deterministic board core, journals, checkpoints and commit-aware verification | Multi-agent work has a real recovery/control model rather than only an attractive board UI. |
| Session revision checks and editor save preconditions | The application anticipates agents and humans changing the same project concurrently. |
| Worktree isolation and retained failed work | Delegation can preserve the user's main checkout and leave useful progress available for review. |
| Separate-origin preview and element-to-chat feedback | Users can inspect what they built and point to a requested change without navigating implementation files. |
| Provider/model bindings, shared pool scheduling and local runtime admission | Different intelligence sources participate in the same workspace rather than creating separate chat products. |
| Listener-aware host/device authentication, cataloged backups and trusted Electron IPC | There is deliberate boundary engineering to extend, subject to the specific failures in this report. |
| Extensive scoped tests, multi-OS CI and bundle gates | Existing regressions can be guarded while repairing the seams that helper-level checks miss. |

Preserve these strengths while changing the contracts around identity, acceptance, outcomes and recovery. A wholesale rewrite is not justified by the sampled evidence.

## Section-by-section assessment

| Section | Good | Main weakness | Most useful improvement |
|---|---|---|---|
| [01. Chat and tools](01-chat-engine-and-tools.md) | Shared runner, retained transcripts, recoverable context and ordered tool results. | Global delegation context, lost/duplicated instruction states, incomplete Undo reporting. | Immutable per-call identity and durable acceptance distinct from execution outcome. |
| [02. Code and runtime tools](02-code-workspace-and-runtime-tools.md) | Concurrent-save safeguards, scoped previews and element-to-chat feedback. | Draft loss and stale terminal/edit continuations; language-service scope diverges from file IO. | One scoped document/run identity and recoverable supporting tools beside chat. |
| [03. Issues, Dashboard and planning](03-issues-dashboard-and-planning.md) | Goal capture, actual shared chats, retained worktrees and embedded conversation. | Older dispatch paths and board handoffs lose ownership/status continuity. | Consistent task admission and terminal-result reconciliation. |
| [04. Orchestration and delivery](04-orchestration-git-and-delivery.md) | Pure control core, checkpoints, commit-aware testing and strong Issues Work approval. | Other merge paths do not enforce the revision reviewed. | Reuse the stronger inspection/approval contract across every landing path. |
| [05. Models and providers](05-models-providers-and-routing.md) | Captured bindings, pools, native transports, replay limits and local resource admission. | Diagnostic privacy, configuration races, quota composition and artifact-repair gaps. | Simple usable defaults plus dependable waiting/failure/repair explanations. |
| [06. Knowledge and attachments](06-brain-memory-and-context.md) | Readable guarded pages, scoped retrieval, provenance and attachment lifecycle controls. | Synthesis and proposal review lose workspace ownership. | Scope every learning mutation and make corrections inspectable. |
| [07. Extensions and services](07-extensions-and-assistant-services.md) | Explicit plugin trust, pinned releases, disposable workers and narrow panel bridge. | MCP identifiers collide; some result/error/media meaning is discarded at the adapter. | Exact integration identity, preserved result semantics and a useful connection receipt. |
| [08. Security and storage](08-security-storage-and-devices.md) | Listener-based trust, hashed device credentials, canonical paths and cataloged backups. | First-key race, live revocation gap and non-durable restore recovery. | Test concurrency and abrupt death across durable security boundaries. |
| [09. Scheduler and desktop](09-scheduler-desktop-and-operations.md) | Real headless execution, captured workspace/model, installed-bundle awareness and lifecycle tests. | Corrupt-job isolation, unbounded timeout settlement and result/admission confusion. | Observable, cancellable background assignments with retained results. |
| [10. Reef](10-reef-and-product-placement.md) | Managed release lifecycle, real host checks, checkpoints and isolated previews. | Several repair/admission faults; separate app-shelf mental model and limited steering. | Repair recovery, clarify the utility contract and validate a distinct entry experience. |
| [11. UX and accessibility](11-onboarding-navigation-settings-and-ux.md) | Calm familiar styling, shared composer, searchable settings and purposeful phone UI. | Default attention split, setup complexity, focus leaks and rendered contrast/semantics failures. | Conversation/result dominance, shorter primary setup and workflow-level accessibility checks. |
| [12. Quality and hidden code](12-quality-performance-documentation-and-hidden-surfaces.md) | Cross-platform CI, generated inventory, test discovery and executable budgets. | Integration invariants escape helper coverage; authoritative help and protection guidance drift. | Seam-focused journey tests, accurate shipped documentation and measured performance work. |

The reports explicitly name unreviewed boundaries. Hidden Compare, Benchmarking, Experts and Research were sampled for retained dependencies and release gating, not treated as shipped user workflows or certified for correctness.

## Highest-priority repairs

Priorities reflect impact and reach. P1 means high-impact; it does not mean the defect happens on every launch. No P0 was established in this bounded review. Related findings appear once here even when multiple reports discuss them.

| Order | Problem | Evidence and actual observed boundary | Repair direction |
|---|---|---|---|
| 1 | First-use secret creation can produce incompatible keys | 08-01: 32 concurrent synthetic encryptions succeeded; only one later decrypted. Independently repeated by the primary reviewer. | Coalesce initialization, exclusively create the file across processes, and read the winning key. |
| 2 | An interrupted restore can leave a mixed profile | 08-03: forced exit after one root swap; retry failed on Windows, leaving restored Issues and old Brain. | Durable, idempotent restore journal; stop ordinary startup until profile coherence is established. |
| 3 | Device revocation leaves an existing terminal input channel active | 08-02: real local WebSocket, synthetic device and mocked PTY accepted input after authentication became invalid. | Bind live connections to credentials and close them on revocation. |
| 4 | Provider errors persist full request bodies outside the configured profile | MODEL-01 / 08-04: exact diagnostic function, source tracing and filesystem-spy reproduction; no debug opt-in. | Configured-home, bounded, redacted and explicit diagnostic capture. |
| 5 | Delegation context crosses concurrent chats | CHAT-01: real tool dispatcher returned B's sub-agent list to A; spawn targeting impact follows the same source path but was not executed. | Pass immutable per-call parent/turn/mode/workspace context; remove execution decisions based on a global mutable parent. |
| 6 | Normal checkout/chat navigation can discard unsaved editor drafts | W1: real file-tree root sync cleared a dirty tab with no dialog; reachable callers traced. | Preserve scoped drafts or perform Save/Discard/Cancel before every root transition. |
| 7 | Plan's scoped file-write guard accepts traversal | CHAT-02: both guards accepted it; primary reviewer also saved a synthetic Markdown file at scratch workspace root through the actual Plan HTTP path. | Validate normalized/canonical destination containment under the plans root. |
| 8 | Issue actions can lose or use the wrong work ownership | 03-01 / 03-04: keyboard dispatch overwrites run metadata before eligibility check; cross-workspace Git actions omit the issue's cwd. Source-traced. | Atomic admission and pinned issue/project/repository identity for the entire operation. |
| 9 | Board handoff does not reconcile results to originating issues | 03-03: board association is skipped by reconcilers or discarded; no terminal-result consumer found. Source-traced, no real-model board completion run. | Durable issue/board association with restart-safe terminal/review/landing reconciliation. |
| 10 | Approval can merge a revision different from the one reviewed | 04-01 / 04-03: Dashboard and reviewed-PR merge contracts lack expected reviewed heads; PR freshness lookup failure still proceeds. Source-traced; no external merge performed. | Carry and enforce source/target revision and inspection identity at the final mutation. |
| 11 | One corrupt scheduled prompt blocks healthy schedules | 09-01: one synthetic unreadable prompt prevented a healthy due job from reaching spawn. | Per-job decryption/failure isolation; retain inspectable damaged rows. |
| 12 | Scheduler timeout does not bound settlement | 09-03: non-closing fake child received a signal but retained admission capacity. Actual OS descendants were not tested. | Managed process-tree termination, escalation and explicit bounded settlement/quarantine. |
| 13 | Automatic learning can supersede another project's knowledge | B1: real retirement helper marked a project-B note stale and linked it to project A; automatic synthesis's unscoped input was source-traced. Independently repeated. | Scope deduplication, related links and retirement to explicit fact ownership. |

These repairs address privacy, data integrity, ownership and the reliability of delegated work. They deserve attention before adding further complexity to those boundaries.

## Important second-priority work

Several smaller defects combine into a conversation that is harder to trust than any one issue suggests:

- **Instruction integrity:** two Push now actions can silently lose the first instruction (CHAT-03). An accepted queued prompt can reappear in the queue after execution fails or stops (CHAT-04). Preserve accepted instruction identity and distinguish admission from successful completion.
- **Honest recovery:** Undo can truncate the conversation while hiding a failed file restoration (CHAT-05). Keep partial success, the error and the recovery reference explicit.
- **Async ownership:** stale terminal attachment can reconnect A after B was selected (W2); cancellation of Quick Edit A can enable acceptance of still-streaming B (W3). Use request/session identity after every asynchronous boundary.
- **Document consistency:** editor file IO honors worktree scope while LSP requests omit it (W4). One document should have the same canonical root throughout loading, editing, language services, preview and saving.
- **Actionable run failures:** dev-server actions discard application errors (W5); scheduled Run now reports Started only after completion (09-04); long valid scheduler results lose their chat link (09-02). Keep logs, control messages and final results separate.
- **Models state and privacy:** concurrent Models patches lose fields (MODEL-02); the HF token is plaintext despite the general encrypted-key promise (MODEL-03, with secret-tagged backup protection already present); cooldown scopes do not compose correctly (MODEL-04); existing nonempty model files bypass verification (MODEL-05).
- **Review identity:** PR staleness relies on the first listed abbreviated commit instead of an explicit full head OID (04-02); review keys omit the GitHub hostname (04-04).
- **Workflow state:** a legacy issue shortcut invokes nonexistent write_file (03-02), and planning/in-progress state can be committed before actual launch (03-05).
- **Accurate explanations:** General's approval description conflicts with the shared permission policy (CHAT-06); estimated cost rollups treat unpriced usage as zero without summary coverage (MODEL-06).
- **Knowledge ownership:** accepting a workspace memory proposal can use the reviewing window's project rather than its origin (B2). Persist origin scope with the proposal and make the destination visible.
- **Integration identity:** valid MCP server IDs containing the namespace delimiter cannot round-trip, and distinct hyphen/underscore tool names collide (E1/E2). Retain an exact reversible dispatch mapping. Cancellation-before-ready also leaves a speech-start promise pending (E3), with mitigation in the main read-aloud controller.
- **Recoverable startup and accurate help:** a failed Code initialization step is permanently treated as initialized until reload (12-01, same issue as 02 R4). The manual describes removed delegate_tasks behavior and contradicts itself about Windows sandbox Require support (12-02/03). Branch-protection setup omits newer CI gates (12-04; actual remote protection was not inspected). Update the contracts and their explanations together.
- **Reef recovery:** an incomplete dependency directory prevents repair on repeated launch, one malformed app record blocks the library listing, and independently valid setup fields can exceed the combined admission limit after an app is already saved (REEF-01/02/03). All three were independently reproduced. The full-history live-update growth pattern is a separate unbenchmarked scaling risk.
- **Keyboard and assistive access:** setup focus escapes its modal, phone reverse-Tab reaches the covered desktop rail, default-theme secondary text fails measured contrast, and phone chat lists have invalid list children (UX-1 through UX-4). These were independently observed by the UX reviewer; the theme token suite still passes.

Some reviewed APIs also have latent identity/formatter/startup risks. Those remain follow-up investigation items in their section reports, not additional confirmed incidents.

## The cross-product changes that matter most

### 1. Make the conversation the durable assignment

A user should be able to tell which request an agent is answering, what workspace it is using, which run or board owns the work, and what happens after stop/retry/reload. Keep implementation-specific execution engines where useful, but give their work a consistent human-facing identity.

A useful contract separates request submission, durable acceptance, execution progress, verification, review and landing. The current failures repeatedly conflate two of these states or infer identity from whichever chat/project happens to be active.

### 2. Make results easier to judge than implementation details

For ordinary chat, a completed model turn is a transport outcome; it is not proof that the requested software works. Boards have stronger verification machinery, but users should not have to understand the engine to interpret the word finished.

An outcome view should explain what changed in user terms, what was demonstrated, checks actually run and their revision, what remains unverified, and how to try the result or request another change. Diffs, logs and files remain available as supporting evidence. This is especially important for users who rarely read code.

### 3. Put recovery beside the work

Stop, retry, undo conversation, restore files, pause future schedules and delete a schedule have different consequences. Preserve progress and state the consequence at the action. A failure should retain enough scope and evidence for a fresh chat turn to investigate it.

Avoid silent success on partial restoration, disappearance of error details, or returning a task to queued after the user's instruction was already accepted.

### 4. Treat immutable scope as a shared contract

The code already has strong local examples: view-bound workspaces, save preconditions, commit-aware board verification and Issues Work inspection fingerprints. Apply the same discipline to the remaining boundaries instead of adding more global state or serializing unrelated work.

The essential identities include project, checkout, document, chat/turn/tool call, provider/model, remote host/repository and reviewed revision. Capture them at admission; validate them again before the side effect.

Knowledge ownership belongs in the same contract. Global personal knowledge is deliberately shared; workspace facts must retain their origin through proposal review, synthesis and retirement. Similar titles across projects are not permission to rewrite either project's knowledge.

### 5. Protect explicit requirements through long builds

Deterministic compaction preserves originals, which is good. Its short character summaries and phrase matching do not establish that later acceptance criteria or differently phrased constraints remain in active context. This is a design risk rather than a demonstrated wrong model answer.

Evaluate long real build conversations with changed requirements, corrections, small local context windows and model switches. Keep an inspectable task/constraints record with links to the actual user messages; do not let inferred memory silently override current instructions.

## UX direction: make the conversation and result dominant

The sampled visual language generally fits Minnow: calm, compact and familiar. The primary opportunity is workflow hierarchy and truthful state, rather than a new visual identity.

At the sampled 1,258px desktop width, the rail, chat list and expanded file tree leave about 560px for conversation; the file tree takes about 350px. That allocation can suit direct editing, but is a poor default for the agreed center of chat-driven building. Start with a dominant conversation, compact project/chat context and an easily opened working result. Preserve and remember full editing layouts for people who want them.

First use should reach a useful conversation with a runnable model, a project and an understandable permission boundary. Keep restore and explicit local/cloud choice. Defer appearance, role routing, optional search/integration keys and knowledge maintenance until relevant; keep advanced setup available. The current flow is skippable, so this is a prioritization proposal rather than a claim that all setup branches are compulsory or blocked.

Supporting views need predictable scope and a clear return to the conversation. A preview, failed check, pending approval or board task should say which assignment and checkout it belongs to. Full-screen views can remain where useful; the person should not lose the thread merely by inspecting a tool.

Repair the independently verified modal focus, covered desktop rail, text contrast and phone list-semantic defects. Preserve the purposeful four-tab phone interface. Validate actual screen-reader/keyboard/zoom/device behavior separately from token tests; this review is not a WCAG certification.

## Reef: useful integration, different product job

Reef is more than a different chat skin. It manages a personal app from idea through build, checks, a promoted release, repeated use and export. Its checkpoint and previous-release behavior is a good example for the broader Minnow result/recovery experience.

The strongest distinction is **managed personal utilities versus ongoing project development**. The distinction cannot be people who do not code versus developers, because Minnow's own center is chat-driven building.

| Placement | Benefit | Cost or unresolved question |
|---|---|---|
| Keep a focused Reef destination inside Minnow | Reuses models, profiles, runtime, chats and backups with minimal operational duplication. | Needs a clearer explanation and entry point so the personal app shelf feels intentional beside project work. |
| Give Reef a distinct launcher/window over the shared service | Tests a simpler app-shelf/create/preview experience while retaining the execution foundation. | Requires clear cross-window identity, ownership and authentication. |
| Ship an independent distribution using shared packages | Provides a fully separate product identity and install lifecycle. | Takes on independent setup, updates, secrets, model/runtime provisioning, backups and support. |

**Recommendation:** validate a distinct launcher/experience before committing to an independent distribution. Keep the runner, models, checkpoint logic and lifecycle protocols shared. Do not split the codebase merely because the current navigation feels awkward.

Code can borrow Reef's outcome-first preview and explicit promotion/verification. Reef can borrow Code's conversational correction flow; currently a running build cannot be steered through chat. Both need an honest distinction between generated checks passing and the requested behavior being demonstrated. Reef also needs its supported local utility boundaries explained before a long build begins.

The remaining placement questions concern repeat use of created apps, demand for external services/credentials, use of Open in Code, and the usefulness of a dedicated launcher. This review does not decide those answers or authorize telemetry, a product split or an implementation.

## Recommended work sequence and acceptance criteria

These are review recommendations, not implementation commitments or delivery dates.

### A. Protect the profile, private context and project work

Repair first-key creation, crash-safe restore, live revocation, diagnostic capture, scoped Plan writes and dirty-draft navigation. Include cross-project Brain retirement in the same ownership work.

Completion criteria:

- Concurrent first use and restart decrypt every successfully stored secret under one retained key.
- Forced exit at each restore boundary leads to a coherent old or restored profile, or an explicit recovery state before stores open.
- Revocation acknowledgement prevents further terminal input on an already-open credential-bound channel.
- A non-debug provider failure under a scratch home creates no private payload dump or write under the primary profile.
- Canonical Plan paths remain in the plans subtree; navigation retains drafts or requires a deliberate discard.
- Learning in one workspace cannot silently supersede another workspace's facts.

### B. Make delegation and delivery refer to the same work

Repair per-call chat context, keyboard admission, issue Git cwd, issue/board reconciliation, queued instruction acceptance and reviewed-revision enforcement. Preserve the strong board and Issues Work contracts while extending them to older entry points.

Completion criteria:

- Two interleaved chats keep their own parent, workspace, model and delegated results through permission waits and teardown.
- Every accepted human instruction remains inspectable exactly once; execution failure and Stop do not silently requeue it.
- A board's completion/failure survives restart and is reflected in its originating issue without claiming that unlanded work is already shipped.
- Changing source or target after review requires new review before landing; failed freshness checks cannot silently authorize a reviewed merge.
- Cross-workspace issue actions operate only in the captured repository and retain the association on errors.

### C. Make the chat result and recovery understandable

Develop one reusable outcome/attention presentation for ordinary chats, issues, boards and scheduled work. Keep differences in actual verification visible. Put Try/Open result, checks/evidence, Request changes and the next safe action ahead of raw implementation detail.

Address partial Undo, dev-server failures, async terminal/Quick Edit ownership, LSP roots and scheduled admission/cancel/result handling. Move optional setup and advanced model/integration maintenance behind contextual entry points.

Completion criteria:

- A builder can explain what was attempted, what works, what was checked and what remains uncertain without opening source files.
- Stop current run, pause future work, undo conversation and restore files have clear distinct effects and retained results.
- One malformed record or non-cooperative child cannot silently strand unrelated work.
- Result metadata and conversation links survive long outputs; failures stay attached to their initiating task.

### D. Validate release behavior and keep help accurate

Repair the repeated Reef picker-test mismatch, current manual/security contradictions and required-check guidance. Retain the generated inventories rather than duplicating fixed counts.

Then exercise a small, explicit real-workflow matrix: local model, hosted API and native CLI; existing repo and new project; local and worktree chats; stop/restart/retry; preview; review with intervening commits; board-to-issue reconciliation; scheduled result/cancel; profile restore. Native desktop, phone and physical GPU behavior need their own evidence. Synthetic conformance does not certify those environments.

Measure first usable chat, project switching and long-history reopen separately from the loader harness and static bundle ceilings. Inspect eager imports before raising budgets again. Refactor large controllers around the contracts being repaired rather than decomposing files for appearance alone.

## Verification performed

Primary-reviewer checks:

- Frontend TypeScript: pass.
- Test discovery registration: pass (1,773 discovered, 1,770 in npm test, 3 deliberately excluded). This is not line/branch coverage.
- Architecture inventory check: pass.
- Fresh Vite production build into scratch output: pass using existing generated inputs; npm prebuild and native packaging were not rerun.
- Existing bundle evaluator against that matching build: no breaches. Entry JS 347.8 KB; CSS 769.8 KB; largest lazy JS 3,314.9 KB; eager JS 4,372.3 KB across 84 chunks; budgeted assets 11,707.2 KB against 11,725 KB. Sizes are uncompressed. The 17.8 KB headroom is small; these figures do not measure interactive latency.
- Five boot/theme/accessibility test files: 83 tests passed.
- Independently repeated synthetic cases for chat identity, Plan traversal, steering/queue behavior, dirty drafts, terminal/Quick Edit races, Models config/cooldowns/download reuse, first-key creation, revocation, interrupted restore and scheduler failure handling.
- Independently repeated Brain cross-project retirement/proposal-destination and MCP namespace/speech-cancellation cases. Brain evidence intentionally retains synthetic temporary homes for inspection.
- Source cross-checks of major report findings, including workspace/Git scope and final review/merge contracts.
- Live browser walkthrough of setup, a stub conversation, Dashboard, issue capture/detail, Reef entry, Brain, settings and scheduler editor. No real generated build or model quality assessment.

The section reports list additional targeted checks and their invocation corrections. One existing Reef UI test failed and repeated: it expects flat model options immediately, while the current shared picker uses provider groups. This is a stale test contract requiring repair and retained CLI-selection coverage, not proof that CLI models are unavailable. Counts overlap between sections and are not summed into a misleading whole-suite total. The full npm test suite was not run. Real GPU serving, live paid-provider builds, real Reef generation/export, native updater/install flows, every desktop OS and real remote-phone behavior remain separate validation work.

The live Code accessibility scan recorded actual failures despite passing token/structure tests: unsupported aria-expanded on the message textarea, small metadata at 2.12:1 and throughput text at 2.82:1 contrast in sampled default-dark states, plus a landmark best-practice finding. An initial tagged scan ran zero checks and was excluded. A later scheduler-editor scan timed out in the browser tool and supports no accessibility conclusion.

## Review safety and limitations

Application source was not edited, committed or published. Reports and review evidence are the deliverable. Runtime checks used synthetic data and scratch profiles where controlled; no live chat, credential or diagnostic payload was inspected.

There is one important isolation exception: an already-running packaged-boundary fixture may have written synthetic generation-error request/response diagnostics under real ~/.minnow/debug because the reviewed logging function ignores MINNOW_HOME. The exact source/test path and uncertainty are recorded in reports 08/09 and the verification ledger. No existing live dump was read or deleted.

Automatic approval review rejected recursive deletion of a synthetic temporary Brain fixture directory with only blocked by policy as its reason. That folder remains in OS temp; the exact path is in the verification ledger. No permission request or further recursive delete was attempted.

See [review brief](00-review-brief.md), [primary verification ledger](evidence/root-verification-ledger.md), and [live observations](evidence/live-observations.md) for methodology and provenance.
