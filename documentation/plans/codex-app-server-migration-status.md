# Codex app-server migration implementation

Implemented October 1, 2026. Codex uses app-server by default; `MINNOW_CODEX_LEGACY_EXEC=1` is the internal one-release rollback. Rollback is selected before a request starts and is never an automatic replay of partially streamed output or an executed tool.

The provider ID, `agent-cli-v1` profile, legacy `sessionMode: replay`, generation endpoints, transcripts, and shared runner remain unchanged. Claude and Cursor retain their existing adapters.

## Components

- `rpc.js`: bounded bidirectional stdio, correlation, pending request deduplication, deadlines, and process-tree termination.
- `manager.js`: one isolated home/process/thread per retained chat; safe credential synchronization; provider admission plus serialized account refresh ownership; eight idle connections, five-minute eviction, and an active-plus-retained cap of configured concurrency plus eight. In-flight tool handoffs are protected from idle eviction and have the existing tool-specific abandonment deadline.
- `conversation.js`: exact normalized accepted-prefix checks and fingerprints of instructions, tools, model, account, workspace, effort, output format, and tool selection. Reasoning and streaming indices are transport decoration; meaningful content edits invalidate reuse. Typed history seeding excludes the latest user input. Rebuilding after tools uses recorded results without executing tools again.
- `pump.js`: generation SSE/non-streaming adaptation, real dynamic-tool requests, native-turn reattachment, late-call buffering, tool-ID deduplication, required-tool validation, cancellation, bounded inference output, and queue/initialization/first-delta/forwarding measurements.
- `translate.js`: incremental message and reasoning summary translation and nonduplicating snapshots; cumulative usage allocation exactly once across rounds.

## Context ownership

Native `contextCompaction` is rejected at item start. The process is disposed and an explicit context-overflow error reaches the existing runner's compact-and-retry path. The replacement thread is seeded from Minnow's policy-approved transcript; the native compacted history is never reused. There is no undocumented native compaction-disable switch.

Native last-request context usage and the reported model window are transported separately from cumulative billable usage. The runner displays the observed context and records its existing estimate calibration and window narrowing. Estimates are not treated as native token counts. If the runner cannot reduce the accepted context, the request fails explicitly instead of silently accepting native replacement.

Usage is allocated once from native cumulative counters, including cached input and reasoning output. The CLI can defer reporting a tool-producing request's usage until its result is returned. If that pending connection is stopped, crashes, or is rebuilt before the report arrives, those unreported tokens are unavailable; Minnow does not fabricate them. Installed-CLI checks cover exact allocation across completed multi-request tool turns and subsequent reconstructed threads.

## Lifecycle and raw output

Chat deletion, final workspace closure, CLI disable/settings changes, failed processes, and development/packaged-host shutdown dispose retained connections. Source account changes invalidate reuse at the next safe request boundary. Temporary homes are deleted after subprocess exit. No native thread ID or rollout is stored across Minnow restarts.

The raw CLI view uses the shared authenticated stream transport. It appends bounded redacted deltas and receives a snapshot after reconnecting; no 700 ms polling or overlapping snapshot requests remain. The old snapshot endpoint stays compatible.

## Validation

Deterministic suites are discovered through `agent-cli-codex-app-server-*.test.mjs`. Installed-CLI checks use `MINNOW_CODEX_APP_SERVER_SMOKE=1` and a loopback fake Responses endpoint, with no subscription inference. CI installs CLI 0.153.4 for these checks on Windows, macOS, and Linux. See [initial protocol evidence](codex-app-server-spike.md) for the runtime observations that shaped the adapter, particularly serial native delivery of parallel calls.

Local Windows checks pass for ten warm follow-ups on one process, multi-request usage allocation, reconstruction after recorded tool results, duplicate and repeated call IDs, runner question/report interception, denied results, compaction recovery, crash recovery without transport replay, login changes, queued cancellation, unresponsive Stop, bounded retention, private-home cleanup, and output snapshot/delta/reconnect behavior. The CLI regression suite, relevant shared-runner suites, UI append test, product wiki gate, discovery coverage, TypeScript check, and production build pass. Browser inspection verifies the CLI pane layout and authenticated empty snapshot. Other operating systems are configured in CI and were not run locally.

The total-assets budget remains a pre-existing failure: 10,728.0 KB against 10,600 KB after this change, compared with 10,727.1 KB before the generation/UI migration. No budget was raised. Entry, eager, and lazy-chunk ceilings pass.

Cross-restart native persistence, process multiplexing, mid-turn steering, and new attachment modalities remain outside this migration.
