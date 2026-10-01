# Verified Todo implementation — 2026-10-01

Branch: `codex/verified-todo-fixes`. Issue workspace: `C:/Users/dukky/Documents/Development/Minnow`.

The verified findings were implemented with parallel subagents. Completed acceptance criteria are listed separately from remaining validation. No issue was dismissed merely because it originated from an LLM.

## Completed changes

- **MIN-63:** Replaced the independent CLI tool loop with the shared turn runner and a Node-safe transcript/tool adapter. Scheduler retains subprocess isolation while calling the same CLI core. Coverage includes tool history, no-tool results, provider failures, round/repeat/context/time limits, and production Stop.

- **MIN-64:** Added the normal runtime bootstrap/middleware fixture with isolated disk stores and real CLI execution. Source and compiled Electron host each pass five contracts: authentication/workspace scope, harmless tool round and persisted session reload, provider terminal error with partial output, Stop cancellation/exit 130, and live/offline disk-journal child delivery with durable acceptance before ACK and restart without redelivery. No test-only memory delivery adapter.

- **MIN-66:** Added byte admission budgets: 32 MiB request/replay per generation, 128 MiB retained aggregate, 1,024 generation states, 128 subscribers, 4 MiB queued/socket bytes per subscriber and a 30-second drain stall timeout. Checkpoint reads are bounded before allocation. Overflow terminates explicitly with retained prefix; replay views cannot retain oversized backing buffers. Nine memory-budget cases plus checkpoint/local/backpressure suites pass.

- **MIN-67:** Generated factual architecture inventory from the actual tools, apps, modes and skill manifest, added --check drift detection and a CI gate, and corrected architecture/product/context guidance. Inventory and product-wiki checks pass.

- **MIN-69:** Integrated a shared 8 MiB JSON byte parser into Git/LSP/terminal routes with real HTTP malformed 400, declared/chunked oversize 413 and aborted-upload cleanup. Admitted Git work inherits request cancellation and terminates its subprocess tree. LSP cancels only the request token and diagnostic waiter, detaches shared initialization waits, and keeps the server usable for later requests. Persistent terminal sessions are outside the cancellation scope. Parser, process output-cap and admitted-disconnect regressions pass.

- **MIN-71:** Captured previousPhase before mutating issue agent state. Terminal done/failed/canceled/review transitions record exactly one attributed activity; unchanged or absent phase records none. Issue workflow suite: 27 passing.

- **MIN-72:** Scheduler tick reserves admission synchronously and dispatches due jobs without awaiting each completion, oldest due first, with bounded capacity and running/enabled revalidation. Manual and scheduled jobs share slots; failures release capacity. Focused admission and scheduler tests pass.

- **MIN-74:** Filters Brain catalog metadata by workspace/expert/archive scope before reading bodies. Uses eight ordered concurrent readers and skips eligible corrupt bodies. Warm benchmark: 1k-page p95 546.24 -> 10.38 ms, 10k-page p95 4140.92 -> 104.26 ms, in a fixture with 90% foreign pages. Admission tests pass.

- **MIN-76:** Binds async Brain loads/saves to navigation and draft revisions plus value fingerprints. Retains dirty per-page drafts in session memory through navigation/New, and confirms explicit reload discard. Five deterministic editor race tests pass. Draft retention is session-local, documented.

- **MIN-81:** Canonical serialized onboarding ownership with 30-second leases/10-second renewal and guarded saves; stale owners cannot release successors or reset live setup. Save failures retain progress and expose Retry; setup closes only after canonical save. Ownership, persistence and real controller DOM cases pass; onboarding suite 29 passing.

- **MIN-85:** Corrected Brain manual for >=0.7 automatic synthesis saves, lower-confidence proposals, explicit review opt-in and first-turn snapshot/replay freshness. Behavior-backed documentation tests and product-wiki validation pass.

- **MIN-86:** Corrected Scheduler manual for foreground app/editor overlay and unattended permission semantics: Ask executes under unattended allowance, Off remains denied, interactive questions/browser tooling are unavailable. Docs, approval policy and actual child argv/environment tests pass.

- **MIN-90:** Uses Windows junctions for directory escape tests, precisely skips unavailable Windows file symlink capability, and replaces vector deletion sleeps with an explicit pending-delete drain barrier. A delayed-delete regression proves the barrier follows subsequent deletes. Focused tests pass.

## Remaining acceptance work

- **MIN-68:** Same five production boundary contracts now pass against source and emitted electron/dist/server-host.js via startInProcessServer. Explicit npm scripts build/run both profiles; ordinary tests clearly skip the compiled profile when no build is present. Remains open: supported packaged installer LAN/pairing and real language-server startup/process-tree termination across supported platforms. Compiled runtime parity does not establish installer acceptance.

- **MIN-83:** Removed ineffective eager Brain page edges and lazy-loaded browser/subagent/preview tool executors. Measured same-session eager JS 4778.3 -> 4751.4 KB (~27 KB reduction), largest lazy 3658.4 -> 3622.2 KB. Total assets 10778.7 KB exceeds existing 10600 KB budget by 178.7 KB; budget not raised. Remains open for uncontended production cold-start measurements, further cuts and budget ratchet.

- **MIN-88:** Added deterministic ENOSPC after committed bytes, Range retry, split-GGUF partial recovery, cancel/pause/resume race and active-generation eviction protection. Cases pass. Native inventory: Windows 11 x64, Intel UHD 770 + RTX 4090, managed llama.cpp CUDA 13 executable, no local GGUF. Real CPU/CUDA/Vulkan downloads/generation/residency NOT RUN; Linux/macOS unavailable. Remains open for representative native runtime and OS/backend coverage; no downloader failure claimed.

## Validation

Build and TypeScript checking pass. Test discovery covers 1,547 files with three documented exclusions. Generated architecture inventory and product wiki checks pass. Focused Brain, onboarding, Scheduler, MCP, issue workflow, generation memory/checkpoint/backpressure, model fault and browser tool suites pass. Shared runner/headless suite: 282 tests pass. Source and compiled host production boundaries: 10 tests pass. Request parsing, admitted-disconnect and process/LSP timeout regressions: 19 tests pass.

A broader generations/packaging run had two existing fixture mismatches: `upstream-failover.test.mjs` and `utility-output-budget.test.mjs` expect Responses reasoning without the shipped `summary: auto` field. Those fixtures and provider behavior are unchanged. Scoped LSP had 90/92 passing; HTML/CSS and GraphQL executable path assertions resolve through the shared node_modules junction to the main checkout instead of the worktree. The full repository suite is not claimed green.

The total-assets performance gate remains red: 10,778.7 KB against 10,600 KB. No ceiling was raised. MIN-83 remains open.

## Additional integrity fixes

MCP comments and synced-field edits now advance the local-change watermark monotonically, preventing GitHub synchronization from discarding MCP changes. Regression coverage includes a future timestamp and concurrent comment preservation.

Scheduler atomic file replacement now retries transient sharing locks with a bounded delay, following the canonical config-store pattern; persistent locks and unrelated failures remain visible. Headless preflight consumes response bodies, and HTTP test teardown lets aborted streams settle normally to avoid Windows shutdown races.
