# Cross-app Codex and Claude Code sessions

**Status:** proposed; implementation not started  
**Date:** 2026-11-08  
**Scope:** local Codex and Claude Code sessions in the Code workspace

## Outcome

Open a project in Minnow, see its existing Codex and Claude Code conversations, and continue a supported conversation under its original provider session ID. Finish a turn, continue in the provider's own app or CLI, then return to Minnow and see the added turns. Conversations started in Minnow with sharing enabled participate in the same round trip.

This is session interoperability on one machine and configured local session home. Signing into the same account on a different machine does not transport its files. Codex and Claude remain separate conversation families; switching between them creates an explicitly linked new conversation.

Sequential handoff is the initial supported workflow. Simultaneous turns against the same native session from independent apps are outside the concurrency contract. Discovery, viewing, and continuation are separate capabilities, so a visible session can explain why it cannot currently continue.

## Findings in the current implementation

| Area | Current behavior | Required change |
| --- | --- | --- |
| Chat storage | `server/config/sessions-paths.js` stores Minnow chats in `~/.minnow/sessions/sessions.db`. | Keep the existing store for Minnow identity, commands, presentation, and imported observations. Add native session bindings. |
| Codex lifecycle | `server/generations/codex-app-server/manager.js` sets `CODEX_HOME` to an owned private directory under `cli-sessions/<hash>/native`; thread cwd is ordinarily that private home. | Introduce an explicit shared storage lifecycle and use the verified project/checkout cwd. Keep owned-private cleanup separate. |
| Codex history | `server/models/agent-cli-native.js` rejects history beyond the ordinary Minnow item subset; manager verifies saved history digests and may rebuild ordinary private sessions. | Read historical native items as observations; reconcile legitimate external additions; never silently rebuild a shared session under a new ID. |
| Codex future actions | Native coding is a narrowly admitted Windows/CLI/model experiment, not a general cross-platform facility. | Prove a portable current-tool contract and enforce every newly available action before enabling continuation on a platform/version. |
| Claude lifecycle | `server/generations/agent-cli/session.js` uses `cli-sessions/<hash>/work` as cwd and resumes verified private transcript snapshots. `claude-state.js` reads native project logs under the configured Claude home. | Resume the exact native ID in the actual project, using native persistence rather than a snapshot copy as the shared history authority. |
| Canonical chat execution | `server/chats/*` owns command admission, profiles, execution fences, transcripts, recovery, and observer presentation. Generic renderer saves cannot replace managed history. | Import/reconcile through a server transaction and continue through managed admission; extend supported history contracts explicitly. |
| Backup | `sessions` is backed up; `cli-sessions` is currently excluded in `server/backup/catalog.js`. | Preserve an intelligible local history snapshot and distinguish it from an externally stored resumable session. |

The older Codex migration status document predates the current durable CLI checkpoints; current source and `documentation/context.md` take precedence.

T3's implementation provides useful reference points: a shared Codex home, provider session scanning, and idempotent import with native session IDs. Minnow also needs to preserve its shared command, tool, permission, and checkpoint contracts.

## Product decisions for this proposal

1. Add **Show chats from other apps** to the existing Models → CLIs connection controls. Enable independently for Codex and Claude Code. Enabling it scans configured local homes and shows matches for the current project automatically. No new app or composer mode.
2. Resolve the default source homes from the CLI environment and conventional homes (`CODEX_HOME` / `~/.codex`, `CLAUDE_CONFIG_DIR` / `~/.claude`). Allow an advanced local-home override. Do not discover arbitrary accounts or recursively scan the entire user home.
3. Keep a session's provider badge, title, last activity, and original project association in the ordinary Code chat rail. External discoveries use lightweight summaries; materialize full history when opened. Already linked chats appear once.
4. New ordinary foreground CLI chats use shared persistence when sharing is enabled and continuation is certified. Existing private chats retain their identities and behavior. Utility inference and board/sub-agent attempts do not become discoverable foreground chats by default.
5. Continue the exact linked session when supported. An unavailable provider, busy session, unknown format, or unsupported policy disables Send with an actionable reason. **Start a new chat with this context** is a distinct fork action, never an automatic fallback labeled Continue.
6. Add **Continue in terminal** with an explicit native ID and the correct cwd/environment. Any desktop deep link is optional and requires a documented, tested contract. Do not depend on undocumented Codex or Claude desktop URLs.
7. Renames, pinning, grouping, archive, and removal in Minnow are local presentation decisions in the first release. Removing a linked chat does not delete its external session. Persist a local dismissal so discovery does not immediately resurrect it; offer Show hidden external chats. External archive/delete states are reported rather than propagated destructively.
8. Turning sharing off stops discovery and new shared-session creation. Preserve linked history and bindings; continuation reports that the source is disconnected until re-enabled, or the user explicitly creates a private fork. Never rewrite an existing binding silently.
9. Align with [One agent, one permission level](unified-agent-and-permissions.md): Manual, Auto, and Full access come from the same system policy; `/plan` and `/ask` restrictions apply to future actions. Storage sharing adds no second permission system. Until that redesign lands, use the current policy adapter rather than duplicating its rules.

## Architecture and ownership

### One native identity, one Minnow binding

Use the provider's native session persistence as the authority for portable conversation context. Keep Minnow's existing SQLite store as the authority for its chat identity, commands, profiles, local annotations, execution receipts, and a revisioned display projection. External activity is imported evidence, not a fabricated Minnow execution.

Add server-owned tables to the existing sessions database; names below are proposed:

| Table | Purpose |
| --- | --- |
| `external_session_sources` | Provider kind, canonical configured home identity, enabled state, scan cursor and source generation. No credentials. |
| `external_session_index` | Lightweight native ID, source identity, cwd/checkout, title, timestamps, availability, archive/dismissal state, and source revision. |
| `chat_external_sessions` | Unique `(source_id, native_session_id)` binding to a Minnow chat, provider association, storage kind, and accepted reconciliation revision. |
| `external_session_items` | Native item/message identity, active branch/revision and projected row mapping for idempotency. Prefer existing message storage for bodies rather than a duplicate raw transcript archive. |

Treat source identity as provider plus the canonical storage root. The same ID in two different homes is not automatically one conversation. Resolve path aliases to deduplicate the same home; do not deduplicate by title or prompt text. A restored source gets revalidated before becoming executable.

Bindings and source revisions are server-owned. Renderer config writes cannot select arbitrary transcript paths, supply an executable native ID, or overwrite imported history. Thread/session identity and fork lineage stay separate; do not confuse Codex's session-tree root with the individual thread ID.

### Provider source adapters

Add a small provider-independent service under proposed `server/external-sessions/`:

- `sources.js`: configured roots, canonical identities and connection lifecycle.
- `indexer.js`: bounded discovery and summary refresh.
- `codex.js` / `claude.js`: provider metadata/history readers and capability checks.
- `projection.js`: native events to existing chat presentation/observations.
- `reconcile.js`: revision checks, item deduplication and import transactions.
- `service.js` / `middleware.js`: authenticated list, open/link, refresh, hide, and handoff operations.

Prefer Codex's documented `thread/list`, `thread/read`, and paginated history APIs where the installed version supports them. Include relevant source kinds explicitly: default listing filters can omit app-server conversations. Filter on verified project cwd, not provider login identity. Any read-only rollout fallback is bounded, version-tested, and cannot write provider records.

For Claude, evaluate its supported session-management library functions first. Prefer a compatible Node integration; do not introduce a Python runtime into the desktop package just for listing. If the installed integration lacks a supported reader, use a bounded, fixture-tested read-only JSONL adapter under the configured `projects` directory. Decode session metadata and active ancestry; do not treat the encoded project directory name alone as proof of cwd.

Scan only configured roots. Use lazy body reads, bounded concurrency, head/tail metadata reads where suitable, byte/record limits, timeouts, and cancellation. Partial final JSONL records are retryable. Corrupt or unsupported records affect one session, not the entire sidebar. Metadata access must not launch inference or run user hooks/plugins.

Match the current project and registered worktrees through existing canonical workspace/checkout identity helpers. A chat in a worktree stays bound to that checkout. Missing or replaced checkouts need explicit resolution; never silently run it in the repository root. Unknown-project sessions remain outside the current rail rather than gaining workspace access from transcript text.

### History projection and reconciliation

Opening an external summary imports through a dedicated server transaction: validate source/session identity, create or find the unique binding, persist stable projected rows, and publish existing managed presentation events. Opening or refreshing never creates a send command.

Project user/assistant text, attachments that can be resolved safely, supported reasoning summaries, native tool observations/results, failures, branch lineage, and compaction boundaries. Historical tools remain immutable observations with provenance and stable identities. They never enter an execution queue, approval request, current pending-tool set, or checkpoint intent. Do not invent successful results for interrupted calls or unavailable image bytes. Do not attempt to reconstruct hidden reasoning.

External user inputs carry source provenance but no Minnow command receipt. Never manufacture historical approvals, undo snapshots, usage charges, or elapsed durations. Native usage can appear as imported accounting where reliable, kept distinct from usage incurred by Minnow to avoid duplicate billing totals. File changes observed outside Minnow are not eligible for Minnow's earlier-turn rollback.

Reconcile on selection/focus, explicit refresh, watcher invalidation, and immediately before send. Watchers are hints; coalesced polling and send-time reads repair missed events. Keep scans out of boot's critical path and stop unnecessary work when the project closes.

For append-only changes, import only new stable items. For a native fork, bind a distinct native ID and retain lineage. For same-ID truncation, edits, or compaction, preserve the old local revision as non-executable evidence and rebuild only the display projection of the verified active revision. Never replace native files or merge divergent histories by concatenation. An unknown lineage or partial projection blocks continuation until understood; a lossy display is not a valid resumption checkpoint.

While Minnow runs a turn, stream through the existing presenter. Reconcile the native committed result against the streamed rows using provider turn/item IDs; do not append a second copy. User commands retain existing idempotent receipts. A source scan racing a turn cannot take over its execution fence or settle its activity.

### Continuing the real session

Before each send:

1. Resolve the binding server-side; validate the configured source, account/provider compatibility, exact native ID and actual checkout identity.
2. Refresh history and commit its accepted source revision before admitting the new command. Recheck at dispatch; stale history returns a retryable conflict rather than silently sending from old context.
3. Acquire Minnow's session-level lock across windows and provider aliases, then apply ordinary managed command admission, captured/current policy, checkpoints, and recovery barriers.
4. Resume through the provider with the same native ID, actual checkout cwd and an invocation-local tool/policy configuration. Send only the new input. Do not seed a text transcript, copy a private checkpoint into the native source, or replay historical effects.
5. Record new action/usage events through the shared host. Commit final state only after provider completion and any required tool/quiescence/checkpoint boundaries. Retain a recoverable receipt if the result or native commit is uncertain.
6. Before explicit handoff, wait for the turn to settle, drain pending tool results, close/park the owned process as supported, refresh native persistence, and release Minnow's lock. Launch the resume command using argument arrays and a validated local environment, not interpolated shell input.

Shared sessions cannot use the private-session fallback that discards a cache and starts another native conversation. Settings/account changes, Stop, timeout, invalid history, compaction and recovery must explicitly preserve the binding, resynchronize it, or report unavailable. A model/provider switch that requires a native fork is presented as a fork and records a new binding. Never route a linked native continuation through automatic cross-provider failover.

Native permissions, tool definitions, persisted instructions and global home configuration require a round-trip compatibility proof. Codex persists dynamic tools in thread metadata; an external client may restore tools it cannot execute. Claude's stored history can reference Minnow MCP tools that are not connected outside Minnow. A shared folder alone does not solve either case.

Preferred runtime contract: native portable coding tools where pre-execution policy enforcement is certified, with session-local Minnow integrations routed through the same permission classifier and host. Test whether the existing Minnow-mediated tool transport can also hand off cleanly. Choose the proven invocation for each supported provider/version; do not expose tools that require an absent client or persist a required localhost bridge into the user's global configuration. Continuing outside Minnow must work with Minnow closed for ordinary coding tasks. Minnow-only integrations can be unavailable there with an honest capability message.

Historical native actions do not authorize future native execution. Any native shell/edit path needs the same pre-effect enforcement, approval decisions, checkpoint boundaries, cancellation, policy revocation and recovery behavior as other actions. The existing limited Codex experiment is evidence to extend, not a blanket capability grant. Claude's current tool restrictions are also a boundary, not an obstacle to remove without replacement. A compatibility failure disables continuation; it does not select full access or weaken `/plan` restrictions.

### Cross-app activity and cleanup

Minnow's leases coordinate Minnow clients only. A timestamp, unchanged transcript, process listing, or local lock file does not prove that an independent Codex/Claude process is idle. Investigate each provider's actual cross-process locking/activity facilities in the first milestone.

Known external activity disables Send; never interrupt a process Minnow does not own. If a foreign writer is detected during a Minnow turn, stop the owned inference safely, preserve both sources of evidence and require reconciliation before another send. Do not report that this guarantees race prevention when the provider lacks a shared lock. Publish sequential-use limitations and record any remaining race explicitly in the release evidence.

Use distinct storage ownership types (`owned-private` and `shared-external`) throughout lifecycle, eviction and deletion. No shared path can reach `removePrivateHome`, cache pruning, recursive removal, auth copy-back, or a config rewrite intended for owned temporary state. Configure capabilities per invocation; leave the user's home config, hooks, MCP registrations, skills and credentials unchanged. Inherited hooks/plugins/settings that can execute before policy admission need explicit suppression or a certified policy path.

Discovery and source configuration are host-local operations using listener provenance and existing auth checks. A paired device can observe/continue an already authorized linked chat through the standard managed APIs and current device policy; it cannot provide arbitrary host paths to the scanner. Importing a path in a transcript grants no filesystem authority.

Backup preserves local projections, provenance and bindings inside `sessions.db`; it does not traverse `~/.codex` or `~/.claude` or include their credentials. Restore marks external bindings disconnected pending local source validation. The cached history remains readable if a native session disappears, but does not imply resumability. If complete external-session backup is later desired, make it a separate explicit provider-aware feature.

## Delivery sequence

### 0. Prove round-trip and policy compatibility

Build disposable probes using scratch Minnow/Codex/Claude homes and a scratch Git checkout. Pin tested CLI/protocol versions; no live profile writes or paid inference by default. Use existing fake inference fixtures where supported. An opt-in real provider/desktop smoke test establishes behavior that protocol mocks cannot prove.

For each provider, test external → Minnow → external → Minnow, and Minnow-created → external → Minnow. Include a real read, file edit, shell command, a Minnow-only tool, restart, interruption, native compaction, and a provider-native fork. Assert native IDs, actual cwd, transcript ordering and one-time side effects. Run the external CLI continuation with Minnow closed. Verify desktop discoverability separately, including Codex source-kind filtering; CLI success alone is not desktop certification.

Inspect inherited instructions, persisted dynamic tools/MCP requirements, auth behavior, home overlays, cancellation and foreign-writer handling. Prove Manual/Auto/Full access and enforced read-only intent with pre-effect checks on each proposed platform, including the always-denied secret-store floor in the permission redesign. Do not infer enforcement from a configuration label or an after-the-fact hook.

**Exit:** commit an evidence matrix identifying the working transport, read/continue capability by provider/platform/version, cleanup ownership rules, and remaining concurrency limits. Resolve whether the current transport is portable or native action integration is required before wiring production continuation. If no safe transport is proved, ship no Continue claim for that combination; discovery is an independent milestone, not completion of this feature.

### 1. Source registry, index and read-only discovery

Implement the additive schema, source validation, adapters, project/worktree filtering and paged summary endpoint. Add connection controls and ordinary-rail source badges. Keep scanning non-blocking and inference-free. Add dedicated feature capability flags independent of the existing Codex native experiment.

**Exit:** existing conversations appear once for their correct project; opening them displays history without changing native files or starting inference. Malformed sessions, missing homes and CLI outages remain isolated.

### 2. Managed bindings and reconciliation

Implement idempotent open/link transactions, external observation rows, revision mapping, FTS integration, watch/focus refresh, local dismissal, and restart/backup behavior. Extend canonical history/admission contracts specifically for linked sessions instead of relaxing the generic ordinary-root promotion guard. Preserve separate provider context and display history.

**Exit:** external changes refresh an open chat without losing drafts or duplicating rows; two Minnow windows bind the same native identity once; imported calls never execute.

### 3. Codex continuation and shared creation

Apply milestone 0's proven Codex invocation to the existing managed app-server adapter. Split private/shared lifecycle paths, use actual cwd, bind native thread identity, route policy and new action events through the existing host, and reconcile committed history. Add terminal handoff and explicit fork behavior. Keep historical private chats unchanged.

**Exit:** both round-trip directions pass on each enabled Codex platform/version with tools, restart, Stop and policy changes. Native-session IDs survive every successful handoff. External clients can continue ordinary coding without Minnow running.

### 4. Claude Code continuation and shared creation

Apply the proven exact-ID resume transport to the real project/config home. Keep interactive/stream-json policy differences explicit. Replace private-snapshot authority only for shared sessions, preserve native compaction/branch state, and verify tool/hook configuration does not leak into external runs. Prefer extending the current adapter; add an SDK dependency only if milestone 0 proves a necessary supported capability unavailable through the installed CLI.

**Exit:** the same round-trip contract passes for Claude, including native ID, project grouping, pre-effect permission enforcement and continuation with Minnow closed.

### 5. Existing-chat migration, packaging and release

Offer an explicit private-chat migration only where provider-native supported operations preserve the required identity and portable history. Otherwise offer a clearly labeled new shared fork, retain the original and record lineage. Do not manually rewrite/copy JSONL or fabricate provider metadata to make old chats appear native. Full migration of every historical private chat is not required for new shared sessions to ship.

Validate packaged Electron/Node dependencies on Windows, macOS and Linux, path alias/case behavior, startup/bundle budgets and existing CLI/private-chat regressions. Enable each provider/platform combination only after its evidence passes. Rollback disables discovery/new sharing/continuation admission while preserving cached history, recovery and bindings.

At release, update `documentation/context.md`, the Models/connect-a-model manual and storage/backup documentation to describe only delivered behavior. The existing roadmap is the product-facing location for unshipped direction; this file is an engineering proposal.

**Exit:** all acceptance cases below pass for every advertised combination; limitations and unsupported combinations are explicit. Discovery-only support is not described as cross-app continuation.

## Acceptance and regression matrix

| Scenario | Required result |
| --- | --- |
| Open a repo with existing Codex/Claude chats | Correct project conversations appear once; metadata scan starts no inference. |
| Continue externally started chat in Minnow | Same native ID, full provider context, new input sent once, current Minnow permissions enforced. |
| Start a shared chat in Minnow, close Minnow, continue externally | Discoverable by the supported provider surface; ordinary coding tools work without a Minnow process. |
| Return after an external turn | New turns appear in order; existing draft, local annotations and session identity survive. |
| Historical shell/edit/error/unfinished tool records | Faithful observations; zero historical side effects, approvals, current pending calls or invented results. |
| Fork, compaction, truncation, changed native ancestry | Correct active revision and lineage; native context retained; ambiguity blocks Send without erasing evidence. |
| Two Minnow windows / provider aliases | One binding and one admitted native turn; command retries do not duplicate input. |
| Another app starts writing | Known busy state blocks Send; detected race safely settles/requires reconciliation; no false global-lock guarantee. |
| Manual/Auto/Full access, `/plan`, live revocation | Every newly possible action obeys current policy before effects; imported policy never grants authority. |
| External hooks, plugins, skills and MCP config | No unadmitted startup execution; no permanent edits to user configuration; absent Minnow tools do not break external coding. |
| Stop/crash/timeout/lost receipt | Preserve ID/history and explicit uncertainty; no automatic replay, native cache deletion or provider failover. |
| Worktree removed, cwd renamed/replaced, symlink/junction escape | No silent project retargeting or filesystem authority from a transcript path. |
| Partial/malformed/oversized logs or unknown schema | Bounded failure per session; known history stays readable; unsupported continuation explains why. |
| Hide/archive/delete in Minnow | Local presentation change only; native history untouched; dismissed source does not immediately return. |
| Disable sharing/CLI; evict process; delete ordinary Minnow chat | Shared homes, credentials, configs and external session files remain untouched. |
| Backup/restore on another machine | Local history/provenance readable; disconnected binding must be validated before resume; no external secrets copied. |
| Historical usage and filesystem changes | Imported accounting distinct from Minnow charges; no fake checkpoint-based undo for external work. |

Extend the existing `test/generations/agent-cli-persistence.test.mjs`, Codex app-server suites, managed execution/ordinary-routing and session message-sync suites; add focused `test/external-sessions/` coverage for the new contracts. Include actual authenticated HTTP admission/presentation tests and installed-CLI probes, not just parser mocks. Run discovery coverage, typecheck, relevant suites, full CI suite with unrelated failures identified, production/headless builds and performance budgets as implementation changes require.

## Dependency and risk assessment

Discovery is a contained server/index/UI change. Correct round-trip continuation is an adapter and execution-host feature: native tools, persistent instructions, compaction, ownership and policy enforcement are the critical path. The permission redesign simplifies action classification but does not itself establish native pre-effect control or cross-process locking.

Start with milestone 0. Its result determines the size of the native runtime work and supports a credible estimate. Avoid promising a delivery date or treating support on one CLI/platform as certification of both providers across all desktop apps.

## References checked

- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server): stored thread listing/read/resume/fork, source filters, pagination, provider compatibility, and persisted dynamic tools.
- [Claude session management](https://code.claude.com/docs/en/agent-sdk/sessions): exact-session resume, continuation versus forks, and native persistence.
- [Claude session browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser): project-scoped discovery and supported metadata/history functions. Verify equivalent functions against the Node integration before selecting a dependency.
- [T3 Codex home layout](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/CodexHomeLayout.ts), [session scanner](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/project/AgentSessionScanner.ts), and [session importer](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/project/AgentSessionImporter.ts): reference implementation, not a contract Minnow can assume unchanged.
- Local architecture: `documentation/context.md`, `documentation/contributor/chat-server-execution-rollout.md`, `documentation/plans/chat-performance-native-host-contract.md`, and `documentation/plans/chat-performance-native-enforcement-evidence.md`.
