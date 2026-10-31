---
name: persistent-agent-chats
overview: Make subagents persistent conversations with captured model selections, durable chat commands, shared execution ownership, and integrated parent and child navigation inside Code.
planType: orchestrate
isProject: true
todos:
  - id: W1-A
    content: Shared conversation, execution, model, and provenance contracts
    status: completed
  - id: W1-B
    content: Inherited policy and workspace authority
    status: completed
  - id: W2-A
    content: Protected session records and durable command inbox and outbox
    status: completed
  - id: W2-B
    content: Canonical server transcript storage and shared event decoration
    status: completed
  - id: W2-C
    content: Agent model discovery and validated selection
    status: completed
  - id: W3-A
    content: Unified ownership and ordered command admission
    status: completed
  - id: W3-B
    content: Server execution host and durable human requests
    status: completed
  - id: W3-C
    content: Renderer, device, CLI, and scheduler dispatch adapters
    status: completed
  - id: W4-A
    content: Persistent spawn and multi-turn child continuation
    status: completed
  - id: W4-B
    content: Durable completion, waiting, cancellation, and recovery
    status: completed
  - id: W4-C
    content: Explicit shared checkout and isolated worktree ownership
    status: completed
  - id: W5-A
    content: Chat messaging APIs and agent tools
    status: completed
  - id: W5-B
    content: Causal limits, wait cycles, and behavioral evaluations
    status: completed
  - id: W6-A
    content: Relationship navigation and stable chat links
    status: completed
  - id: W6-B
    content: Grouped agent activity and shared child chat composer
    status: completed
  - id: W6-C
    content: Concurrent attention, notifications, and activity integration
    status: completed
  - id: W7-A
    content: Legacy coexistence, migration, backup, and rollback
    status: completed
  - id: W7-B
    content: Reliability, provider, performance, and packaged runtime gates
    status: completed
  - id: W7-C
    content: Documentation and release activation
    status: completed
---

# Persistent agent chats and chat coordination

**Status:** All 19 tasks across seven waves are implemented and verified. Persistent agent conversations are enabled by default on compatible SQLite servers. The final activated chat suite passes 513 tests; compiled desktop/CLI checks pass ten cases and the actual unpacked app passes all eight runtime/asset checks. Authorized live API, CLI and pool tests pass; the disabled local provider is explicitly skipped. Shipped documentation and inventories are updated. Remaining baseline suite failures and validation limits are recorded in the verification report.
**Date:** 2026-10-30  
**Register:** Product  
**Scope:** Persistent subagent chats, per-agent model selection, chat-to-chat messaging, and integrated chat UX in Code.

## Outcome and scope

A user can ask a Minnow chat to delegate work to specific configured models, follow those agents in a compact group, open any child as a normal conversation, and continue talking to it. Chats can discover, read, and message other authorized chats in the same project. Work, queued messages, result delivery, and pending human requests survive a renderer reload and server restart. A child remains the same conversation across turns; each assignment and execution retains its own identity and result.

Code remains the primary surface. The implementation uses the existing session database, subagent lifecycle journal, model providers and pools, and shared server/runner/run-turn.js. It does not introduce another chat engine, a separate agent app, or a second canonical transcript store.

The user request authorizes the feature previously deferred in [Unified model selection and routing](unified-model-selection-and-routing.md), specifically its prohibition on public per-spawn model arguments and agent-facing discovery. This plan supersedes that deferral only. Remembered composer selection, complete provider/model identity, captured task bindings, existing pool policies, and explicit unavailable states remain binding requirements. No persistent natural-language model preference is inferred from a casual request such as "be efficient."

Included in the first complete release:

- App-owned persistent child conversations and follow-ups, including background execution with the renderer closed.
- Explicit model/provider and supported reasoning overrides on delegation, plus bounded model discovery.
- Project-scoped chat listing, incremental reading, sending, waiting, and scoped stopping.
- Durable command admission, provenance, questions and approvals, and parent result delivery.
- Grouped parent activity, nested child navigation, shared child transcript/composer, and local child model controls.
- Shared-checkout default and explicit isolated worktree execution through existing workspace infrastructure.
- Legacy run inspection, migration compatibility, accessibility, packaging, and reliability gates.

Excluded from this release:

- Cross-machine delegation, cross-project agent messaging, multiplayer, automatic merges, and a new general chat archive system.
- Unrestricted recursive delegation. Child profiles keep spawn tools disabled by default; lineage rendering tolerates deeper or imported relationships.
- A provider-native subagent importer. The data and UI contracts represent inspect-only capabilities, but implementing every provider's native child protocol does not block app-owned children.
- A generic provider request-body override, automatic cheapest-model selection, or a new global model scheduler.
- A manual child-creation form or agent-facing target-chat model reconfiguration. Initial delegation is prompt-driven through the existing spawn tool.

## Current implementation and gaps

| Area | Existing implementation | Required change |
|---|---|---|
| Sessions | sessions.db stores chats, messages, runs, revisions, search, and detail; renderer saves use revision checks | Add protected lineage/profile and command records, precise append primitives, and server ownership protection |
| Subagents | Server journal and pure graph own lifecycle, caps, retries, and terminal results | Link each task to a persistent child; run future assignments in the same chat |
| Child transcript | Effector uses memory; attempt JSONL is lossy; parent snapshots retain at most 50 messages | Persist canonical full-fidelity conversation messages from the first child turn |
| Models | Internal spawn accepts providerId/modelId; type/default/parent inheritance and pools exist | Expose validated per-spawn targets and carry options through the production server runner |
| Chat commands | chat-sync broker delivers remote commands to a renderer and keeps an in-memory command map | Add a durable shared command service and server execution host |
| Ownership | Renderer turn lease and generation fencing protect one chat loop | Extend the same ownership contract to server, renderer, CLI, scheduler, and child execution |
| Steering | pendingSteerMessage accumulates corrections into one string without independent message identities | Admit ordered durable steering entries with individual receipts and source attribution |
| Policy | resolve-sub-agent-tool-mode.ts maps Plan to Build; modeId is not captured in the spawn POST/journal | Preserve effective parent policy and enforce it server-side |
| Human input | Subagent effector supplies ask:null; approvals depend on active UI state | Add durable per-chat requests and capability-aware pause/resume |
| Presentation | Individual cards, live activity, a run drawer, and normal shared chat mounts exist | Add relationships and writable child navigation without duplicating transcript rendering |

The existing model reasoning test is not sufficient proof of server propagation: the production TurnModel contract and bindTypeModel path need explicit option support and production-effector coverage.

## Product and interaction decisions

### Parent and child conversations

1. A child starts from the task brief plus its role/profile and ordinary workspace context. Parent conversation history is not copied implicitly. The sender can supply necessary excerpts in the brief; explicit context-transfer features remain separate.
2. Its saved provider/model pair is resolved once at creation. Parent selection changes, global defaults, type/general routing edits, and unrelated foreground navigation do not replace a queued command's captured pair. An explicitly selected pool retains its identity while live pool configuration governs eligible members, as specified below.
3. Follow-ups use the child's canonical history and compaction state. They create a new task/run in that child, preserving the original delegation's published result.
4. The original parent/root relationship is fixed. A message from another chat does not reparent the target, change its workspace, or redirect its original result delivery.
5. A child is protected from ephemeral-empty-chat pruning as soon as its shell is committed, before the first message or transcript hydration.
6. A normal child composer shares existing attachments, thoughts, tools, queue/steer actions, and changes review. Opening it never creates another execution owner or stops another chat.
7. App-owned children are writable when their capability/profile permits it. Native or historical records lacking sendable state remain inspect-only, with Open parent and honest capability text.

Initial delegation is prompt-driven: the user asks the parent for one or more agents, naming models, reasoning and checkout requirements when desired; the parent resolves capabilities and calls spawn_sub_agent. The UI shows requested/resolved selection and preflight errors. It does not add a new creation dialog or an inert Delegate control. Human child controls can narrow the inherited mode/tool ceiling through existing controls; that ceiling is visible and cannot be broadened in v1. Starting an independent user chat is the existing way to establish broader authority. Agent messages and ordinary model picker actions never change authority.

### Parent transcript

One child appears as a compact linked activity row. Two or more from the same parent turn appear in one expandable group, for example "3 agents · 2 working." Group membership uses parentTurnId, with parentToolCallId retaining exact spawn anchors. It does not depend on visual adjacency or merge unrelated turns.

Each row displays the assignment title, role, model, state, and one useful progress or result line. Pool-backed rows distinguish the selected pool from the actual model. Children update in place; a history rebuild does not append duplicate spawn rows, cards, or notifications. Existing Worked disclosures and the parent's final answer remain readable. Disclosure, scroll, focus, and drafts survive updates and navigation.

A historical parent row is pinned to its task identity and immutable published result. Resuming that child does not turn an old Complete row back into Working or replace its summary. The child rail/header shows current conversation activity; a new initiating turn gets a distinct task/command activity row. The parent is waiting only on its subscribed tasks, not every later turn in a related chat.

New peer messages appear as expandable "Message from [current chat title]" entries with a preview, source link, timestamp, and delivery state. Their provenance is typed metadata. They never masquerade as the human's own messages or disappear merely because their text matches an old hidden-message prefix. Automatic delegation results use a distinct result event linked to the task; they are not sent again as peer messages.

### Chat rail and navigation

Root chats remain the ordinary top-level items within existing manual/board groups. A root's disclosure reveals its children, with active/attention work first and a collapsed Previous agents group for settled work. Initial child lists are bounded and offer Show more; only root chats count toward the ordinary top-level list limit. Opening a child reveals its ancestor path.

Use a separate relationship projection rather than repurposing ChatGroup or board task membership. Preserve existing keyed DOM, root pinning, manual groups, ordering, selection, and drag/drop. Child reparenting, independent child pinning, and moving a child to another project are outside this release. Indentation is visually capped; deeper ancestry is readable in a breadcrumb. Use native disclosure buttons and groups rather than an incomplete ARIA tree implementation.

The child header says "Subagent of [parent title]" and offers Open parent. Stable links use #/app/code/chat?chatId=<encoded-id>, resolved through the existing launchCodeWithChat and workspace-switch guard. Links use IDs and resolve current titles. Missing/deleted targets show a reachable explanation; they do not select an unrelated chat. Parent/child links do not change the active workspace as a side effect of background messages.

### Models and composer behavior

| Operation | Selection behavior | Remembered independent-chat default |
|---|---|---|
| New child without target | Type override, general subagent override, then captured parent selection | Unchanged |
| New child with explicit target | Exact validated target takes precedence | Unchanged |
| Follow-up in child | Child's saved next-turn selection | Unchanged |
| Human changes child selection | Local child configuration for subsequent turns | Unchanged |
| Agent changes the model for new work | Only through an explicit spawn target; no arbitrary target-chat reconfiguration tool | Unchanged |
| Human changes independent root composer | Existing remembered-selection contract | Existing behavior |

The shared picker component is reused, but onActiveChatModelChange is not reused unmodified: it currently stops work and updates the remembered default. Extract an explicit local configuration operation. A child model change is marked "Applies to new messages"; show the captured model/effort on already queued items. Offer an explicit Stop and switch action when immediate interruption is wanted. It stops the active execution and changes future sends; it does not rewrite queued commands. To change an already admitted input's selection, cancel that input and send a new one with a new receipt. A new direct child send captures the new selection.

Binding precedence is explicit target, type override, general subagent routing, then captured parent. Provider/model identity remains a complete pair. Options inherit only when that effective pair matches; otherwise use the selected model/type defaults. An omitted options object permits inheritance; an explicit empty object clears inherited per-turn overrides. Validate reasoning effort, thinking mode, and thinking budget, including incompatible combinations. Do not transplant provider-specific options between models.

An explicit unavailable model or unsupported option fails preflight without creating a phantom chat. Explicit named selections do not silently use a fallback model; users wanting routing choose a pool. Existing non-explicit routing/failover policies remain available and their actual selections are visible. Pool identity remains stable; member selection/capacity uses the existing model-router scheduler. My Models retain their library identity rather than temporary local serve aliases.

Pool-backed commands capture the pool ID and explicit option constraints, not a frozen lineup. Current membership, routing strategy, capacity, availability and revocations apply at dispatch and retry; record the pool configuration revision and actual member for each attempt. Removing/disabling the selected pool yields an unavailable state rather than substituting another pool. Explicit effort/thinking overrides take precedence over evaluator defaults, including the current generation path that otherwise deletes evaluator reasoning overrides. Exclude members that cannot satisfy explicit options; if none is configured, fail preflight, and if compatible members are temporarily busy, wait without weakening the request. Test edits between queueing and dispatch explicitly.

### Attention and stop scope

Display states are derived from command, execution, request, and task truth: Queued for agent slot, Waiting for model capacity, Loading model, Working, Waiting for agents, Needs your answer, Needs approval, Waiting for host, Complete, Failed, Stopping, and Stopped. A finished model turn with pending delegated work is not a completed overall task. Waiting does not display a generating spinner.

Ancestor attention precedence is needs input/approval, failure, unread result, then working. Multiple pending requests are independent records; selecting a child clears its own unread baseline, not another child's request. Notifications link to the owning chat and request and are deduplicated by stable identity.

The parent's existing Stop ends its active turn. Stop agents ends that parent's currently delegated subtree. Stop conversation and agents is an explicit tree operation. Stopping an old run must not stop a newer run. Re-run original task starts fresh work; Continue conversation uses existing history. These actions have separate labels and receipt identities.

Deleting a parent with active descendant execution, queued work or unanswered blocking requests is rejected with a link to Stop agents. After settlement, deleting only the parent retains children, promotes them into reachable root listings, and preserves missing-parent provenance. Deleting an active child requires stopping/settling its work and requests first. Tombstones prevent a stale view or pending delivery from recreating deleted chats. Subtree deletion is a separate future action, not an implicit cascade.

## Identity and storage contract

| Identity | Meaning and lifetime |
|---|---|
| childChatId | Persistent conversation; stable across follow-ups and provider changes |
| runId | Existing delegated task identity; original result becomes immutable on terminal publication |
| attemptId | One recoverable execution attempt under a task |
| turnId / executionId | One canonical identifier for an admitted conversation execution, exposed as execution_id in chat tools; distinct from task runId and legacy ChatRun snapshots |
| commandId | Durable input/control operation and its idempotent receipt |
| requestId | One pending human question or approval |
| deliveryId | One task result notification/admission into a parent |
| causalRootId / replyToCommandId | Correlation across explicit messages, waits, and automatic work |

Each task also captures a completion policy and recipient independently of lineage and scheduling storage. Initial spawn uses wake_delegator with the live source chat, initiating execution and cancellation epoch. Direct human continuations in a child and ordinary peer chat_send use local_only: they do not automatically wake the lineage parent or reply to their sender. A caller can explicitly wait/read and decide whether to send another message. There is no implicit result subscription on chat_send in v1. Legacy records without this field retain their current parent-delivery behavior.

Keep the current SQLite table-layout user_version at 1. Use idempotent additive tables/columns and indexes. Add optional versioned wire fields without changing SESSION_SCHEMA_VERSION=6 unless implementation proves an incompatible wire change; all supported normalization/export/import paths must understand the added fields. New readers accept old records. Mixed old writers must be unable to erase protected server-owned fields.

Add these logical records under the existing sessions backup root; final SQL column spelling follows local conventions:

- chat_relations: child primary key, original parent/root IDs, origin, delegation ID, logical project/workspace identity, creation provenance, missing-parent state, and record version. Parent references do not cascade child deletion.
- chat_execution_profiles: versioned role/type, prompt identity/snapshot, tool restrictions, inherited authority ceiling, workspace strategy/checkout identity, and capability requirements. Queued work references a captured profile version.
- chat_commands: ordered durable inputs, caller-scoped request key, canonical payload hash, source/target IDs, command kind/mode, captured model/profile, causal IDs, linked message/task/turn IDs, state, result/error, and timestamps. A unique producer/request-key constraint returns the original receipt on replay and rejects changed payloads.
- chat_executions: per-turn execution record, task/attempt references where applicable, status, owner/fence, captured selection/policy, settlement, and recovery state. Keep existing chat_runs snapshots working; do not overload them with a second meaning.
- chat_execution_leases: per-chat owner, execution ID, fencing epoch, and lease state shared by every execution host.
- chat_tool_invocations: fenced mutation/unknown-tool intent committed before side effects, tool call identity and argument hash, resulting settled receipt/evidence, and indeterminate/recovery state. Do not duplicate credentials in auxiliary diagnostic records.
- chat_requests: durable questions/approvals with owning chat/turn/tool, respondable/expired state, answer receipt, presentation payload, and capability requirement. Runtime callbacks and auth credentials are not serialized.
- chat_outbox: recoverable requests for task-journal appends, completion acknowledgements, and other cross-store steps, with stable IDs, state, and retry outcome.
- chat_cancellation_scopes: durable stop boundary/epoch for causal work and automatic delivery subscriptions, independent of new explicit post-stop input.

Messages stay in sessions.db/messages. Add stable message identity and typed provenance to each relevant payload: actor human/agent/system, source/ingress, sourceChatId/sourceTurnId, commandId, causalRootId, and kind human_message/peer_message/delegation_result. The provider wire role may remain user; actor identity must survive normalization, compaction/recall, export/import, renderer saves, and display. API-bound messages omit application-only routing metadata and identify agent-origin content as source material, not a higher-priority human instruction.

Session repository primitives append settled messages with sequence/hash, history digest, count, preview, FTS, chat/session revisions, and execution receipts in one transaction. Enforce an ownership fence and deletion tombstone. Do not read the full session state and replace it per model round. Server-owned records cannot be overwritten by stale whole-chat PATCHes or legacy parent snapshots. Summaries carry lightweight relationships, status and selection, never full child transcripts/profile prompts/inbox payloads.

Canonical durable transcript state is settled model/tool events plus persisted compaction checkpoints and row identities. Streaming deltas remain transient and coalesced. A crash may lose the current unsettled text tail, which is marked interrupted; it must not lose committed rounds or fabricate a successful tool result. Preserve signed reasoning, reasoning blocks, attachments, tool pairing, changes metadata, timing and usage. Extract UI-neutral decoration from createChatTranscriptStore and keep renderer-specific painting separate.

The agents/<journalOwnerId>/journal.jsonl remains the task lifecycle authority. Capture journalOwnerId as the original scheduling-family ID and keep it stable even if that parent chat is deleted; existing parentChatId namespaces are the legacy mapping. Add childChatId, explicit completion policy/recipient, profile/version, policy, execution/command references and model snapshot fields to new-format event contracts. Storage owner, original lineage parent and current command sender are separate concepts; none grants authority by itself. Child continuations after parent deletion use the retained journal/profile and local_only completion rather than a fabricated live parent. Attempt JSONL and old parent subAgentRuns remain audit/compatibility records, not competing conversation histories. New parent summaries reference the child and task instead of copying its full messages.

## Execution and delivery architecture

One server ChatCommandService owns validation, durable acceptance, ordering, dispatch selection, observation, and result receipts. HTTP, built-in tools, CLI MCP bridges, renderer composer, remote devices, and task completion are ingress adapters. All execution hosts call the existing runTurn through UI-neutral preparation/persistence/policy adapters.

The existing subagent graph remains the only task capacity/retry scheduler. A child's initial assignment and later turns each become task work under its saved agent profile; a composer send cannot bypass caps by taking the ordinary-chat path. Preserve the current cap scope explicitly: globalMaxConcurrent means across types within one scheduling-family journal, not across all Minnow chats. Per-type caps use that same family; the UI calls these conversation agent limits. A true process-wide task quota is outside this release. The retained family ID continues to govern orphaned child conversations. Model capacity stays in the existing router/provider layer.

The command service requests work, the graph grants task admission, and one execution host runs it. Commands, graph, and UI never independently start the same task. A command waiting for its child chat's existing execution lease remains queued without starting an attempt, consuming a retry or bypassing FIFO. Ordinary root-chat turns use the shared per-chat admission contract without consuming subagent type slots. Test concurrent families so limits are neither falsely presented as application-wide nor independently double-enforced.

Host selection honors an existing valid owner. A renderer can own work needing a live browser surface. Server hosts execute persistent children and eligible ordinary-chat continuations with no renderer connected. Both hosts use the same prompt composition, mode policy, tool discovery, attachments, approvals, sampler/reasoning resolution, compaction and accounting. Extract browser-safe/pure modules or add injected capabilities; never import renderer DOM modules into Node. Boards retain their existing graph and outcome semantics.

If required browser/device/native UI capability is absent, persist a visible waiting_for_host state and its reason. Do not silently strip a requested tool, claim completion, or start a second loop. A phone remains a command submitter/observer and cannot claim a host lease, publish host execution, or start an unrestricted generation. A server can still receive and persist a durable human answer while the provider callback is paused; after a process restart, expired callbacks are marked expired/reissued with a new identity rather than treated as live approvals.

### Durable spawn and result protocol

SQLite chat creation and JSONL journal append are not one transaction. Use an outbox protocol:

1. Validate the trusted caller, profile, target model, workspace strategy, permission ceiling, and request key.
2. In one SQLite transaction allocate childChatId, stable runId/commandId, protected profile/relationship, initial input, and pending journal outbox step.
3. Append run.requested idempotently using that runId and payload hash, then mark the step applied. A matching retry returns its original child/task receipt; a conflicting retry fails.
4. Start only after task admission and execution ownership are durably established. Restart recovery replays unfinished steps without a second child or prompt.
5. Flush the settled child transcript and execution outcome to SQLite together with an outbox request for attempt.ended and any terminal task event. Append those journal events idempotently, referencing the durable execution/message boundary. Only a confirmed terminal journal fold authorizes publishing the immutable task result and creating its delivery outbox record. Recovery reconstructs a missing publication/delivery row from that terminal journal and persisted outcome if the process failed between stores.
6. For wake_delegator tasks with a still-valid completion subscription, admit/persist the recipient notification through ChatCommandService using deliveryId. Only then append result.delivered. A crash between stores replays the same receipt. local_only tasks have no pending delivery obligation; disposed/deleted/stopped subscriptions record their resolution without scheduling another turn.
7. Automatic completions arriving while a recipient works are coalesced into a durable queued continuation cohort. A completion never implicitly steers the recipient or interrupts human work. Later completions get their own cohort; no result is dropped because another cohort already started. Recheck the captured cancellation epoch before every spawn/delivery admission.

Persisted acceptance means work is recorded, not that the model finished. After a restart the runtime reconciles execution records, task journals, generations/native sessions, leases, and outbox state before admitting replacements. A fencing token prevents stale persistence, but cannot undo shell effects. Commit an invocation intent before mutating or unknown external tools execute, then commit the result receipt after settlement. An unresolved intent is indeterminate, even when the crash might have happened just before the side effect. The effector journals a recovery-required barrier that suppresses automatic crashed/timeout retries until explicit resolution; it does not alter the runner's six-way result union. Never automatically replay that tool merely to obtain exactly-once behavior. Keep its evidence and expose explicit recovery; verified continuations resume from committed tool boundaries. Test a file mutation and process launch followed by failure before result commit.

### Ownership, steering and cancellation

Extend existing lease renewal and native-generation fences rather than replace them with an unrelated lock. Every storage mutation and generation start carries chatId, executionId and ownership epoch. Lease expiry alone does not authorize a replacement while the previous native generation/tool is still live. Cancellation targets its original generation/attempt and waits for settlement before ownership transfers.

For v1, auto send starts an idle chat and otherwise queues a separate turn. This deliberately avoids surprising interruption by peer chats. Explicit steer inserts an ordered message at the next supported round boundary; providers with a native steering capability may apply it there through the same receipt contract. Unsupported explicit steer returns a typed error; do not disguise an interrupt/restart as steering. Restart mode is deferred. Replace the accumulated pending string with ordered persisted command references and migrate an existing pending string once, without duplication.

Preserve human queue edit, remove and Push now operations, including remote edit delivery. They are new control commands referencing a queued input and expected revision; they do not change an earlier request key's immutable hash. Edits before dispatch revise the effective displayed/provider input transactionally; editing already consumed input is rejected. Push now uses the explicit supported steering path, with the original source and receipt retained. Editing queue text does not silently change its captured model or authority.

Stop commands bypass normal admission queues. Turn stop is pinned to executionId, while cancel_sub_agent keeps its existing task run_id meaning. Tree stop commits a durable cancellation epoch, enumerates currently owned descendants, holds queued work, and disposes automatic wake subscriptions within its causal scope. Late automatic completions and in-flight spawn requests from that old epoch cannot recreate or wake the stopped tree, including after restart. An explicit new post-stop user/authorized command starts a new exchange; a late automatic callback does not. Task cancellation, parent-turn Stop, Stop agents, and global Stop all retain distinct scopes. A terminal task's result remains readable even after its child is stopped during a later follow-up.

## API and tool contracts

Public HTTP lives under /api/chats for commands/capabilities, while /api/agents retains compatible task endpoints. Both call the same service. Route names below are proposed application contracts, not current shipped endpoints. Use cursor pagination with bounded limits and typed error responses. GET/read operations do not start provider sessions.

| Operation | Input | Result and semantics |
|---|---|---|
| agent_capabilities | search?, cursor?, limit? | Current inherited pair/options, enabled types, bounded model/pool targets and supported semantic options, availability and required host reasons |
| spawn_sub_agent | Existing type/task/wait plus title?, target?, workspace_strategy?, client_request_id? | Existing task runId/status plus childChatId, commandId, executionId, link, captured selection/source, workState and pending request information |
| chat_list | query?, status?, include_subagents?, cursor?, limit? | Authorized project chat shells, current title, relationship/status/model, stable link and next cursor; default excludes children already reachable under parents |
| chat_read | chat_id, view messages/activity, after_sequence?, limit? | Bounded canonical messages/activity and current runtime/request state; next cursor and truncation flags |
| chat_send | chat_id, message, mode auto/queue/steer, client_request_id? | Durable receipt, messageId/commandId, executionId and optional taskRunId, disposition, and target link; never creates an unrelated top-level chat |
| chat_wait | chat_id, execution_id?, timeout_ms? | Pins a selected execution at call time; returns terminal, timed out, blocked request, or waiting-for-capability state; timeout never cancels |
| chat_stop | chat_id, execution_id?, scope turn/tree, client_request_id? | Explicit stop receipt and current state; no-active-work is harmless and stale execution stop never targets newer work |

The spawn target contains providerId, modelId, and an optional typed options object with reasoningEffort, thinkingMode, and thinkingBudgetTokens. Do not add arbitrary upstream JSON. Preserve legacy wait:true aggregate fields while adding child identity. Internal callers can retain the existing providerId/modelId seam during migration; conflicting target forms are rejected. Workspace strategy is shared by default, with explicit new_worktree or a validated existing worktree. Model-generated arbitrary filesystem roots are never accepted.

HTTP resources: GET /api/chats/capabilities, GET /api/chats, GET /api/chats/:id/messages, GET /api/chats/:id/activity, POST /api/chats/:id/commands, GET /api/chats/commands/:commandId, GET /api/chats/:id/events, and POST /api/chats/requests/:requestId/respond. Keep reads separate from request response and mutation. Preserve existing remote-device ingress/auth checks and config/sessions compatibility endpoints.

Reasoning must travel through the shared TurnModel/request preparation and provider sanitizer, not only the renderer request builder. The contract distinguishes requested versus applied reasoning, selected pool versus actual member, and inherited versus explicit options. Test production OpenAI-compatible, CLI and pool paths.

Native CLI providers receive the same service through existing authenticated tool bridges/discovery. Do not expose a general session token, new top-level creation tool, or a way to impersonate senderChatId. Built-in and bridge calls derive caller chat/turn/attempt/workspace/policy from trusted tool execution context.

### Authority and feedback controls

- Listing/reading/messaging is scoped to the current logical project and its registered authorized worktrees. Resolve project identity server-side; checkout path string equality is insufficient. Knowing another chat ID does not grant access. Cross-project and cross-machine operations return a clear unsupported/denied result.
- The inherited ceiling intersects parent effective mode, allowed tools, tool permissions, type restrictions and current revocations. It applies both to schemas and execution, including discovered MCP/plugin tools. Remove Plan-to-Build widening; preserve Minnow's exact Plan semantics, including permitted shell operations and plan-path writes.
- Compare effective capability sets, not an ordering of mode names: General, Build and Debug are not a privilege ladder. Include tool rights, dynamic tools, filesystem/checkout authority and approval requirements. A Plan caller cannot send work into a broader Build target to bypass restrictions; a same-mode target with broader rights is also rejected. Apply the caller ceiling to the target's authorized checkout mapping, so legitimate isolated project worktrees remain usable without granting unrelated filesystem access. Reject broader target execution in v1 rather than temporarily changing target settings. Child UI may narrow its recorded ceiling; broadening a persistent child's authority is deferred.
- Read-only explorer profiles do not gain peer mutation merely because chat_send exists. Tool availability remains profile-controlled. Do not introduce another confirmation for already authorized coordination.
- Never auto-reply to every peer message or forward result notifications. A response is a deliberate chat_send with correlation metadata; there is no implicit request/reply RPC.
- Reject self-send and self-wait. Maintain a durable wait graph and reject cycles. A wait on a running child releases any scarce model-generation admission before blocking; task-capacity starvation from an explicitly authorized nested graph must be detected, not left hanging.
- Bound outstanding commands and causal forwarding using explicit service limits with clear errors. Initial defaults are 100 pending non-control commands per target, 8 automatic forwarding hops per exchange, and 100 messages per bounded read; server caps are configuration, never silent truncation. Human input starts a new exchange; changing request IDs cannot reset the propagated causal budget.
- Child spawn remains disabled by its profile by default. Explicit future recursion must satisfy a recorded depth/budget capability and global/type caps; a task prompt alone cannot elevate it.

## Checkout and worktree behavior

Shared checkout is the compatibility default and is visible in child metadata. Parallel implementation can request an isolated worktree through the existing worktree middleware/operations. Allocate and prepare the checkout before generation; capture its branch and source commit, and state that uncommitted parent edits are excluded. Never tell the model to create a checkout in its shell and assume that changes the chat's bound workspace.

Worktrees are owned by the child conversation, not an attempt. Follow-ups/retries reuse that checkout unless the human explicitly requests replacement. Existing worktree selection is restricted to registered project worktrees. Reuse dependency preparation and file-change provenance. Parent/child navigation preserves checkout identity and the existing workspace-switch guard. Review/merge remains the normal Source Control workflow; this feature does not create an automatic merge queue.

Deleting a chat or finishing a task does not silently remove a dirty checkout. Explicit cleanup uses existing dirty-worktree safeguards. A failed allocation leaves a recoverable setup state without a model call; cancellation during setup settles its receipt and does not leak an unowned worktree.

## Compatibility, rollout and recovery

Use one internal server-authoritative feature capability, agentConversationsV1, shared by API advertisement and renderer. Define its server policy in plain-JS server/chats/feature.js and expose it through capabilities; any src/config facade reads that advertised state, and the packaged server never imports renderer TypeScript. It is not a new app registry entry or a permanent user setting. Enable only in development/test until the complete vertical slice is verified. Persist record versions/execution kind so existing new-format work can recover if new creation is disabled; hiding UI is never a recovery strategy.

Legacy in-flight runs drain on their current path, including existing completion receipts. Historical runs remain in the inspector with available transcript/summary and an explicit legacy identity. Do not automatically manufacture full chats from capped/lossy history. User-invoked Continue as chat creates a new child with clearly marked imported context and references to the original run. Old journal events and parent snapshots replay without new required fields.

Migration is additive and idempotent. Protect server-owned fields during older renderer saves and session summary/detail merging. Keep explicit delete/tombstone behavior. Existing JSON-store development/test mode needs an equivalent repository implementation or an explicit unsupported capability that leaves legacy paths functional; silently losing new records in that mode is unacceptable.

Keep data inside sessions and agents backup roots. Snapshot/export/import and backup/restore must include new durable records and references without duplicating messages, restoring stale execution ownership, or resurrecting deleted work. Restored leases and native callbacks are invalidated; pending commands are reconciled and shown before ambiguous side effects resume. Follow staged restore-at-boot rules and never add store imports to restore-apply.js.

Feature rollback on the new server disables new-format creation, drains/cancels work safely, and preserves additive records/readers. A minimum-reader capability lets that server reject incompatible connected renderers; it cannot make an already released old server honor a marker it never implemented. Offline downgrade to a pre-feature binary against the upgraded home is unsupported. Recover through a pre-upgrade backup or an explicit export/conversion procedure on an isolated home; do not claim arbitrary old binaries are fenced by the new database marker. Test old-client writes against the new server separately from old-server/home compatibility.

## Acceptance and validation matrix

| Scenario | Required evidence |
|---|---|
| Named mixed-model delegation | Two child targets use the exact configured pairs and applied reasoning; parent/default remain unchanged |
| Follow-up continuity | Child reads earlier committed tool results after reload/restart; original delegated result is unchanged |
| Follow-up delivery | Human child continuation and ordinary sibling send stay local; no unintended original-parent or sender wake; orphaned child continues using its retained scheduling family |
| Server-only execution | Renderer absent from initial spawn through child completion and parent continuation; no SSE listener needed for progress |
| Offline target capability | Missing browser host yields Waiting for host; reconnect resumes through the same command without a second user message |
| Concurrent send/steer | Three distinct accepted inputs survive in order; conflicting idempotency keys fail and no steer is overwritten |
| Ownership race | Opening child, two windows, server takeover, and device send produce one active execution and one transcript |
| Store boundary failure | Crashes before/after child transaction, journal append, input append, result persist, and delivery ack recover without duplicate children or admissions |
| Tool side-effect uncertainty | Mutation/process launch succeeds but result commit is lost; durable intent causes explicit recovery and no automatic repeat |
| Policy | Plan-to-Build bypass, forged sender, unrelated project/worktree, disabled dynamic tool, and paired-device execution are denied |
| Local capacity | Queued model/agent slots and model loading are accurate; no independent scheduler swaps an in-use parent model |
| Human requests | Two children can ask/await approval concurrently; answer-before-open, duplicate response, disconnect and expired callback are handled |
| Stop and waits | Timeout preserves work; wait pins an execution; cycles fail; subtree stop settles descendants; late spawn/completion cannot wake stopped work and stale stop cannot kill newer work |
| Agent limit scope | Separate families retain their documented per-family/type caps; same-child lease contention queues without attempts/retry exhaustion |
| Data fidelity | Signed reasoning, image references, code changes, compaction row IDs, usage and FTS survive restart and export/import |
| Legacy and deletion | Old runs remain inspectable; queued child is not pruned; deleted parent leaves reachable children; tombstones prevent resurrection |
| Integrated UX | Group count, nested rows, source links, drafts, scroll and focus remain stable under live updates, renames and rehydration |

Deterministic fake-host tests are required for failure/restart injection and do not count as live-provider evidence. Before release, exercise at least one OpenAI-compatible API provider, one available CLI provider, one pool, and one locally served model through production dispatch. Missing credentials/hardware are recorded as skipped, not passed. All destructive/data tests use isolated MINNOW_HOME/workspace fixtures.

Preserve existing performance budgets without preemptive increases: entry JS 1500 KB, entry CSS 950 KB, largest lazy JS 3900 KB, eager JS 4800 KB, assets 11735 KB, and boot harness 2500 ms at planning time. The authoritative values remain budgets.json. Add a fixture with 1000 root chats, 200 historical children under one root, and three active child streams. Boot and collapsed navigation fetch summaries only; opening one child hydrates that child's history. Use parent/activity subscriptions and per-frame painting, without a live connection or whole-history serialization per collapsed child. Count usage, activity, notifications and Stop targets once per execution even when represented as both chat and task.

Use existing --mn-* tokens, typography, icon vocabulary and themes. Essential state has text/icons, not color alone. Preserve visible keyboard focus, 44px coarse-pointer actions, reduced motion, meaningful polite announcements, responsive rail collapse, and native controls. Register all visible menus/panels with preview occlusion and release subscriptions/listeners on unmount. No new eager dependency is needed for relationships or grouping.

## Architecture and key files

| Boundary | Existing files | Proposed additions |
|---|---|---|
| Contracts and normalization | src/types.ts, src/state/session-schema.mjs, src/agents/types.ts, server/sub-agents/types.d.ts, server/runner/run-turn.d.ts | server/chats/contracts.js and .d.ts |
| Durable records | server/config/sessions-schema.js, sessions-repo.js, sessions-import.js, chat-detail.js | server/chats/repository.js, outbox.js |
| Command and execution | server/chat-turns/middleware.js, live.js, server/runner/*, server/runtime/middlewares.js | server/chats/service.js, admission.js, execution-host.js, requests.js, middleware.js, events.js |
| Delegation | server/sub-agents/*, src/agents/orchestrator.ts, src/state/sub-agent-session-sync.ts | Child/task link adapters in the same subsystems |
| Models | src/agents/sub-agent-binding.mjs, server/model-routers/*, server/models/*, src/ui/model-select-picker.ts | server/chats/model-selection.js, capabilities.js |
| Renderer bridge | src/chat/run-turn-chat.ts, messaging.ts, message-queue.ts, steer-message.ts, shared-chat-bridge.ts, remote-chat-client.ts | UI-neutral preparation/decoration modules in server/runner and service adapters |
| Tools | server/tools/builtin-catalog.js, src/tools/sub-agent-executor.ts, client.ts, src/headless/execute-tool.ts, existing CLI bridges | Shared chat tool executor/caller-context adapter |
| Navigation and UI | src/ui/sidebar.ts, sub-agent-cards.ts, sub-agent-drawer.ts, chat-work.ts, chat-mount.ts, src/os/chat-launch.ts, router.ts | Relationship projection, grouped agent rows and attributed-message rendering |
| Attention | src/ui/tool-approval-modal.ts, src/chat/ask-question-display.ts, src/notifications/*, src/state/agent-activity-registry.ts | Durable-request UI adapters and per-chat approval attention |

Names under server/chats are proposed. Keep pure contracts/policy separate from I/O, add matching declarations for renderer imports, and avoid provider-specific conditionals in the shared runner. Do not statically import server-only modules into the Vite graph.

## Wave Breakdown

### Wave 1 - Shared contracts and authority

#### Task W1-A: Conversation, execution, selection and provenance contracts

- **Build:** Define versioned child relationship/profile, turn/task/attempt/command identities, typed model options, message provenance, request/disposition/error states, and compatibility fields described above. Extend TurnModel through shared request preparation without introducing another loop. Register the internal feature capability disabled by default. Explicitly preserve existing ChatRun and six-way runner outcome meanings.
- **Test:** Add contract/normalization fixtures for old/new session rows and journal events, same-model option inheritance/clear, different-model reset, protected caller provenance, unknown-field handling, and feature advertisement. Type-check renderer/server declarations together.
- **Accept:** Both hosts and all planned tools can use one typed contract; old fixture histories and task journals load unchanged; no new public tool is advertised before its execution path is ready.
- **Touches:** src/types.ts, src/state/session-schema.mjs, src/state/session-schema.d.mts, src/agents/types.ts, server/sub-agents/types.d.ts, server/runner/run-turn.d.ts, server/runner/turn-runner.js, server/chats/contracts.js, server/chats/contracts.d.ts, server/chats/feature.js, src/config/agent-conversations-enabled.ts, test/chats/contracts.test.mjs, test/config/session-shape-parity.test.js

#### Task W1-B: Inherited execution policy and project authority

- **Build:** Implement trusted execution caller context, capability-set policy snapshot/intersection, project/worktree scope resolution and execution-time checks for built-in, MCP and plugin tools. Retire Plan-to-Build widening for new-format children. Capture the actual spawning mode/tool permissions; forbid forged sender IDs and peer execution into broader targets without treating mode names as a privilege ladder. Keep Plan's current shell and plan-path semantics. Preserve current revocation at dispatch even when a queued profile was captured earlier.
- **Test:** Verify Plan child writes only where existing Plan permits, broader-target and same-mode-more-rights send rejection, explorer mutation denial, disabled dynamic-tool denial, symlink/alias/worktree scope checks, and forged/unrelated caller rejection. Include server-direct and CLI bridge calls so renderer filtering cannot be the sole gate.
- **Accept:** A restricted agent cannot use a child, another chat, or a dynamic tool to exceed its effective authority; authorized same-project worktree coordination remains usable.
- **Touches:** src/agents/resolve-sub-agent-tool-mode.ts, src/chat/modes/tool-policy.ts, src/chat/modes/plan-write-guard.ts, server/chats/policy.js, server/chats/caller.js, server/sub-agents/events.js, server/sub-agents/effector-runner.js, server/runtime/path-access.js, test/chats/policy.test.mjs, test/agents/resolve-sub-agent-tool-mode.test.mts
- **Depends on:** W1-A

### Wave 2 - Durable state and model discovery

#### Task W2-A: Protected records and transactional commands

- **Build:** Add the session tables/indexes above and repository primitives for child/profile creation, immutable command hash/receipts, execution/lease/request records, tool intents/results, cancellation epochs, outbox steps, and guarded message append. Protect server-owned records from generic session writes and preserve deletion tombstones. Implement schema initialization, wire summaries/detail, JSON-mode capability behavior and revision/FTS bookkeeping. Keep all new persistence inside existing backed-up roots.
- **Test:** Extend sessions schema, roundtrip, patch, summaries/detail, history-loss, search, multi-window and snapshot suites. Exercise matching/conflicting retry keys, stale renderer save, deleted target, transaction failure, and two simultaneous producers. Verify summaries never contain message/inbox bodies or prompt snapshots.
- **Accept:** Restart-safe input admission and child creation are idempotent; an older/stale view cannot erase lineage, commands, committed messages or a deletion.
- **Touches:** server/config/sessions-schema.js, server/config/sessions-repo.js, server/config/sessions-import.js, server/config/chat-detail.js, server/config/middleware.js, server/chats/repository.js, server/chats/outbox.js, test/config/sessions-db-schema.test.js, test/config/sessions-patch.test.js, test/config/sessions-roundtrip.test.js, test/chats/repository.test.mjs
- **Depends on:** W1-A, W1-B

#### Task W2-B: Canonical transcript adapter and event fidelity

- **Build:** Extract pure transcript decoration/accounting from createChatTranscriptStore; retain its renderer wrapper and implement a plain-JS session-backed TranscriptStore for server execution. Persist settled round/tool rows, exact reasoning/signatures, attachments/changes, usage and compaction checkpoint metadata with row identities and fence validation. Add fenced durable mutating/unknown-tool invocation intent before execution and settled result afterward, plus crash-tail settlement and incremental append paths; no whole-session write per round.
- **Test:** Run renderer/server parity fixtures for reasoning, signed provider blocks, images, tool pairing, code-change provenance, compaction/replay/recall, usage, interrupted tool boundaries, and revision conflicts. Restart between committed rounds and verify subsequent context uses canonical records. Crash after a real scratch-file mutation and process launch but before result commit, and assert the intent remains indeterminate rather than inferred successful or safe to repeat.
- **Accept:** The same conversation continues through either host with complete committed context and one accounting record; no canonical child history depends on capped parent snapshots or lossy attempt JSONL.
- **Touches:** src/chat/chat-transcript-store.ts, src/agents/session-transcript-store.ts, server/runner/transcript-store.js, server/runner/transcript-store.d.ts, server/runner/transcript-decoration.js, server/chats/transcript-store.js, test/chat/chat-transcript-store.test.mts, test/chats/transcript-store.test.mjs, test/config/sessions-restart-context-fidelity.test.mts
- **Depends on:** W2-A

#### Task W2-C: Validated model targets and bounded capabilities

- **Build:** Implement the shared selection resolver and bounded searchable agent capability catalog. Extend the spawn schema/executor with target/title/request-key fields behind the capability. Carry effort/thinking through production runner/generation preparation and sanitizer. Include configured pools/library bindings, source labels and actual applied selection. Capture pool identity/explicit constraints while recording live configuration revisions; give explicit reasoning priority over evaluator defaults and exclude incompatible members. Retain captured routing and remembered-default invariants.
- **Test:** Use the production server effector/generation adapter for explicit provider/model plus effort, unavailable model, unsupported options, empty override clear, type/default/parent precedence, provider switch, pool member selection, local loading/capacity and retry snapshots. Edit a pool while a command waits, verify recorded live revision/member, evaluator versus explicit-effort precedence, and no compatible/busy-compatible member outcomes. Assert catalog bounds and no global preference writes.
- **Accept:** A request for a specific configured model and supported reasoning reaches the actual provider unchanged, or fails before creating work; discovery never injects an entire large catalog into context.
- **Touches:** server/tools/builtin-catalog.js, src/tools/sub-agent-executor.ts, src/agents/sub-agent-binding.mjs, server/chats/model-selection.js, server/chats/capabilities.js, server/sub-agents/effector-runner.js, server/runner/reasoning-effort.js, server/model-routers/generation.js, server/generations/**, test/sub-agents/model-routing.test.mjs, test/chats/model-selection.test.mjs, test/sub-agents/sub-agent-reasoning-effort.test.mts
- **Depends on:** W1-A, W1-B

### Wave 3 - Shared dispatch and execution hosts

#### Task W3-A: Ordered admission and unified ownership

- **Build:** Implement ChatCommandService admission and durable per-chat ownership/fencing. Integrate current lease renewal/native-generation checks, command ordering and stop bypass. Replace the pending steer string with ordered persisted command references and a one-time legacy adapter. Separate admission, running and settlement receipts; prohibit a replacement while an old native execution remains live.
- **Test:** Race server/renderer/CLI claims, duplicate browser windows, reload during setup, lost renew replies, expired owner with active native work, concurrent sends/steers and stop-during-setup. Check stale storage writes/generation starts are rejected and no accepted message disappears.
- **Accept:** At most one execution owns a chat, every accepted input has durable ordering, and stale generation cancellation cannot stop a newer turn.
- **Touches:** server/chats/service.js, server/chats/admission.js, server/chat-turns/middleware.js, server/chat-turns/live.js, src/chat/turn-lease.ts, src/chat/turn-ownership.ts, src/chat/steer-message.ts, src/chat/message-queue.ts, test/chat/turn-ownership.test.mts, test/chat/turn-lease.test.mts, test/chats/admission.test.mjs
- **Depends on:** W1-B, W2-A

#### Task W3-B: Server execution host and durable human requests

- **Build:** Extract host-neutral turn preparation and inject the shared policy, prompt, transcript, attachments, model, compaction and tool adapters into a plain Node execution host around runTurn. Implement durable AskCapability and approval/request lifecycle, capability waits, response receipts, expired callback recovery and startup reconciliation. Support eligible ordinary parent continuations without a renderer and coordinate child admission through the existing subagent graph. Honor indeterminate tool intents with a journaled recovery barrier so ordinary crash retry policy cannot replay them. Keep all provider side effects behind execution ownership.
- **Test:** Start/continue a chat with no renderer, ask two independent durable questions, pause for an unavailable browser host, restart with a pending request, duplicate an answer, expire a native callback, revoke a tool and cancel during approval. Verify an indeterminate mutation suppresses automatic attempt retry until explicit recovery. Compare renderer/server prompts, API bodies and final persisted messages. Verify board outcome behavior is unchanged.
- **Accept:** Renderer-free child and parent continuation use the same turn loop and policy; required human/host capabilities produce durable truthful waiting states rather than silent tool removal or false completion.
- **Touches:** server/chats/execution-host.js, server/chats/requests.js, server/runner/**, src/chat/run-turn-chat.ts, src/chat/prompts/prompt-composer.ts, server/sub-agents/effector-runner.js, server/runtime/middlewares.js, test/chats/server-host.test.mjs, test/chats/requests.test.mjs, test/headless/production-boundary.test.mjs
- **Depends on:** W2-B, W2-C, W3-A

#### Task W3-C: Composer, remote, CLI and scheduler adapters

- **Build:** Route existing host command handler/composer and remote broker through durable admission. Preserve queue edit/remove/Push now as revision-checked control commands, including the existing remote edit action. Preserve phone restrictions, renderer browser capabilities, CLI/scheduler launch behavior and user acceptance callbacks. Consolidate live execution publication on shared execution identity. Add service HTTP/events registration and bridge discovery with trusted caller context, retaining compatibility endpoints during migration.
- **Test:** Extend shared-chat-live and remote ownership suites; test device submit with server execution, forbidden device host registration/generation/lease, renderer reconnect, background send without navigation, CLI/scheduler contention, repeat remote receipt after process restart, remote queued edit, edit-versus-start race and Push now provenance without duplicate input.
- **Accept:** Existing composer and phone flows work through the shared boundary; observing or opening a child does not create a second owner, move another view's workspace, or change global defaults.
- **Touches:** src/chat/shared-chat-bridge.ts, src/chat/remote-chat-client.ts, src/chat/messaging.ts, src/headless/execute-tool.ts, src/headless/persist-chat.ts, server/chat-turns/live.js, server/chats/middleware.js, server/chats/events.js, server/scheduler/**, test/remote/chat-live.test.mjs, test/remote/chat-turn-ownership.test.mjs, test/chat/shared-chat-live.test.mts
- **Depends on:** W3-B

### Wave 4 - Persistent delegation lifecycle

#### Task W4-A: Persistent spawn and child continuation

- **Build:** Implement the child/profile/input transaction and idempotent journal outbox protocol. Add child IDs, stable journalOwnerId, explicit completion policy/recipient, and policy/model snapshots to new-format tasks. Wire the effector to canonical history and route later child sends into new tasks/turns under the retained family/profile/caps. Keep original task results immutable, local continuations free of implicit wake obligations, and queued shells protected from pruning. Lease contention remains pending without starting or failing an attempt. Preserve existing spawn arguments and wait aggregate results.
- **Test:** Fault-inject before/after child transaction, journal append and receipt update; retry identical/conflicting spawns; change parent/default while queued; continue after more than 50 child messages and server restart; open the child during background execution. Test human/sibling follow-ups without an original-parent/sender wake, orphan continuation after parent deletion, separate scheduling families and FIFO same-child lease contention without retry exhaustion. Verify no implicit parent-history copy and no duplicate initial prompt.
- **Accept:** The first complete lifecycle slice creates one child on the requested model, preserves its history across follow-ups/reload, and leaves the original task result stable.
- **Touches:** server/sub-agents/events.js, server/sub-agents/derive.js, server/sub-agents/graph.js, server/sub-agents/middleware.js, server/sub-agents/effector-runner.js, server/chats/outbox.js, src/agents/orchestrator.ts, src/state/sub-agent-session-sync.ts, src/state/session-workspace-scope.ts, test/sub-agents/api.test.mjs, test/chats/persistent-child.test.mjs
- **Depends on:** W2-C, W3-C

#### Task W4-B: Result delivery, waiting, stopping and recovery

- **Build:** Replace new-format listener-dependent completion injection with durable recipient command admission and journal acknowledgement. Publish results only after transcript flush and confirmed terminal journal fold; reconstruct missing publication/outbox state after restart. Implement completion cohorts only for wake_delegator tasks, local_only resolution, execution-pinned waits, task versus conversation terminal state, cancellation epochs/subscription disposal, startup recovery and missing-recipient handling. Preserve legacy delivery and acknowledge only after accepted/persisted state. Task wait releases provider/model admission while retaining correct task lifecycle.
- **Test:** Renderer absent throughout initial delegation completion and parent continuation; parent busy with multiple completions; crash after transcript/outcome commit, terminal journal append, publication/outbox insert and before delivery acknowledgement; cancellation during tools/setup/requests; local follow-up after original result; wait timeout/no-active-execution/stale-execution stop and deleted parent. Stop a tree then deliver late completion/spawn before and after restart, proving no resurrection. Assert one result admission and unchanged task summary.
- **Accept:** Children and parent coordination finish without SSE viewers, results cannot disappear or trigger duplicate parent turns, and stop/wait scope is stable across restart.
- **Touches:** server/sub-agents/delivery.js, server/sub-agents/runtime.js, server/sub-agents/policy.js, server/chats/service.js, server/chats/outbox.js, src/agents/sub-agent-completion-push.ts, src/agents/sub-agent-resume-message.ts, test/sub-agents/delivery.test.mjs, test/sub-agents/completion-delivery-integration.test.mts, test/chats/delivery-recovery.test.mjs
- **Depends on:** W4-A

#### Task W4-C: Child checkout binding and optional isolation

- **Build:** Add explicit workspace strategy validation/allocation through existing worktree middleware/operations. Bind the child to its checkout before generation, retain it across follow-ups/retries, and show shared versus isolated provenance. Record source commit/uncommitted-edit exclusions and recoverable setup/cancel/cleanup state. Do not create board integration/merge state for a child chat.
- **Test:** Shared default, new worktree from parent commit, validated existing worktree, dirty parent exclusion, dependency setup failure, cancel during allocation, reuse across follow-up, unrelated worktree denial, and deletion without implicit dirty-checkout removal.
- **Accept:** Parallel writers can explicitly isolate work while task and navigation use the recorded checkout; completion never silently merges or removes their code.
- **Touches:** server/worktree/middleware.js, server/worktree/worktree-ops.js, server/chats/workspace.js, src/state/chat-worktree.ts, src/ui/chat-worktree-setup.ts, server/sub-agents/middleware.js, test/server/worktree-middleware.test.mjs, test/chats/child-worktree.test.mjs
- **Depends on:** W4-A

### Wave 5 - Agent chat coordination

#### Task W5-A: Chat tools and attributed messaging

- **Build:** Expose bounded list/read/send/wait/stop tools and corresponding HTTP operations through ChatCommandService, using execution_id consistently for waits/stops and preserving task run_id only in subagent tools. Add tool discovery/permission grouping for General/Build/Plan/Debug as allowed, headless/CLI bridge parity and trusted caller context. Persist typed source attribution, stable links, command receipts and incremental read cursors. Keep auto=start-or-queue, explicit ordered steering and local_only follow-up results; no automatic top-level chat creation, implicit reply subscription or model reconfiguration.
- **Test:** Ordinary-to-ordinary, parent-to-child, child-to-parent and authorized sibling sends; same-project worktree scope; matching/conflicting retries; bounded incremental reads; unsupported steering; wrong-mode/project/forged caller; source rename/deletion and stable links. Assert app-only metadata is removed before provider request submission.
- **Accept:** An agent can reliably discover/read/message an authorized existing chat, with visible source attribution and one persisted input; the operation neither steals focus nor bypasses target policy.
- **Touches:** server/tools/builtin-catalog.js, src/tools/client.ts, src/tools/chat-executor.ts, src/chat/modes/tool-groups.ts, src/headless/execute-tool.ts, server/chats/middleware.js, server/chats/service.js, server/chats/caller.js, src/chat/build-api-messages.ts, test/chats/tools.test.mjs, test/chats/messaging.test.mjs
- **Depends on:** W4-B

#### Task W5-B: Causal limits and coordination evaluations

- **Build:** Implement causal root propagation, bounded inbox/hops, wait-graph cycle detection, self-target rejection and notification deduplication. Author behavioral evaluation cases using the existing eval infrastructure: exact model counts/options, unavailable target errors, no polling after async delegation, no accidental new top-level chats, explicit follow-up versus fresh review, and correct stop scope. Keep limits observable and user-authorized agent counts intact.
- **Test:** A-to-B-to-A wait cycle; duplicate automatic acknowledgements; forwarded message budget that cannot reset by changing request key; target queue overflow while Stop still works; nested-capacity starvation; and prompt cases that must not invoke coordination tools. Run deterministic tool contracts separately from real-model evaluations and record cost/skips honestly.
- **Accept:** Coordination cannot create an unbounded hidden exchange, silently lose accepted inputs, or block forever on a detectable wait cycle; ordinary tasks do not acquire needless delegation.
- **Touches:** server/chats/causality.js, server/chats/service.js, src/chat/prompts/tool-usage/sub-agent-delegation.md, src/chat/prompts/tool-usage/sub-agent-delegation.lite.md, src/chat/prompts/tool-usage/chat-coordination.md, src/benchmark/**, test/chats/causality.test.mjs, test/evals/**
- **Depends on:** W5-A

### Wave 6 - Integrated Code chat UX

#### Task W6-A: Relationships, child navigation and links

- **Build:** Add a lightweight relationship projection and root/child sidebar rendering with active and Previous agents groups, bounded expansion, ancestor reveal, missing-parent promotion and stable direct links. Preserve manual/board grouping, keyed rows, draft/scroll/focus state, workspace guards and normal chat mounts. Add feature-aware native/legacy inspect-only navigation without manufacturing editable history.
- **Test:** Sidebar keyed reuse/order/pinning/DnD regressions, root list counts, nested children shown once, deep ancestor cap, direct/missing/deleted link, rename, parent deletion, workspace switching and embedded Issues/Home/board chat mounts. Opening a child while siblings stream must preserve unrelated controls/drafts.
- **Accept:** Every child is reachable from its parent and a stable link without polluting the top-level chat list or introducing another conversation renderer.
- **Touches:** src/ui/sidebar.ts, src/state/session-workspace-scope.ts, src/state/chat-relationships.ts, src/os/chat-launch.ts, src/os/router.ts, src/ui/chat-mount.ts, src/markdown/**, test/ui/sidebar-keyed-reuse.test.mts, test/ui/sidebar-chat-dnd.test.mts, test/chats/navigation.test.mts
- **Depends on:** W4-A

#### Task W6-B: Grouped activity, attributed messages and local child controls

- **Build:** Group parent agent rows by parent turn, preserve per-call anchors/disclosure state and render task/model/progress metadata. Keep historical task rows pinned while rail/header show latest child activity. Open persistent children in the common transcript/composer with parent breadcrumb and visible authority ceiling. Add child-local model configuration using the shared picker, Applies to new messages feedback, captured queue model/effort and explicit Stop and switch. Render typed peer/result entries and preserve compact/full Worked grouping; keep legacy drawer inspection. Initial launches remain prompt-driven with requested/resolved selection and inline failures, without a separate creation form.
- **Test:** One versus many agents, mixed status/model sources, retries/history rebuild, no duplicate cards, live updates without forced scrolling, peer text matching old hidden prefixes, result grouping, local child model change during/after a turn, invalid option error, unchanged parent/global defaults and queued binding snapshots. Resume a completed child and verify its old parent row stays Complete; verify local continuations do not imply parent waiting or auto-wake. Cover prompt-driven initial delegation, narrowing-only authority controls, narrow/touch/keyboard layouts and preview occlusion.
- **Accept:** The parent stays readable while users inspect and continue children; model controls accurately distinguish new from queued inputs, historical results stay stable, and agent messages remain visibly distinct from human instructions.
- **Touches:** src/ui/sub-agent-cards.ts, src/ui/sub-agent-drawer.ts, src/ui/sub-agent-conversation.ts, src/ui/chat-work.ts, src/ui/chat-model-ui.ts, src/ui/model-select-picker.ts, src/ui/launch-model-picker.ts, src/chat/transcript-turns.ts, src/chat/hidden-transcript-user-messages.ts, src/styles/sub-agent-drawer.css, test/ui/sub-agent-cards.test.mts, test/ui/remembered-model-selection.test.mts, test/chats/child-composer.test.mts
- **Depends on:** W5-A, W6-A

#### Task W6-C: Concurrent requests, ancestor attention and activity

- **Build:** Bind questions and approvals to durable owning chat/request records, replacing singleton approval attention assumptions. Aggregate ancestor attention, notifications/unread and activity through one execution identity. Wire scoped stop controls, request navigation and expired-request rendering. Deduplicate chat/task usage, spinners, Stop targets and completion notifications; release observers on unmount.
- **Test:** Two simultaneous child approvals/questions, answered-before-open, duplicate response, stale callback after restart, parent collapsed while child needs input, source/parent deletion, per-child unread acknowledgement, one activity entry per execution and distinct Stop scopes. Respect reduced motion and announce only meaningful transitions.
- **Accept:** Background children can request input without being watched, every request opens the right conversation, and activity/usage remain accurate across chat and task projections.
- **Touches:** src/ui/tool-approval-modal.ts, src/ui/chat-item-dot.ts, src/chat/ask-question-display.ts, src/tools/ask-question-queue.ts, src/notifications/**, src/state/agent-activity-registry.ts, src/state/activity-feed.ts, src/ui/agent-activity-panel.ts, test/notifications/**, test/chats/request-attention.test.mts, test/state/agent-activity-registry.test.mts
- **Depends on:** W3-B, W4-B, W6-B

### Wave 7 - Compatibility and release proof

#### Task W7-A: Legacy migration, restore and rollback behavior

- **Build:** Finish additive legacy coexistence, captured execution-kind routing, user-invoked legacy Continue as chat with marked partial context, protected old-writer handling and missing-parent/delete behavior. Extend export/import/snapshot/backup to new records; invalidate restored leases/callbacks and reconcile outbox before work. Implement new-creation disable/drain and minimum-reader protection for clients connected to the new server. Document offline pre-feature binary downgrade as unsupported without pre-upgrade backup/conversion; do not pretend old server code honors new markers.
- **Test:** Upgrade with active legacy child and pending result, old capped transcript import, old session PATCH over new fields, JSON-store capability fallback, backup/restore mid-queue, repeated migrations, disabled creation with new-format in-flight work, incompatible older client execution and deleted-chat resurrection attempts. Separately verify a pre-upgrade backup/export recovery procedure on an isolated old-server fixture. Use scratch homes only.
- **Accept:** Existing homes remain readable, in-flight work is neither orphaned nor duplicated during activation/disable/restore, and users retain both historical evidence and new conversations.
- **Touches:** src/state/session-schema.mjs, server/config/sessions-schema.js, server/config/sessions-repo.js, server/config/sessions-snapshot.js, server/backup/catalog.js, server/chats/recovery.js, src/state/sub-agent-session-sync.ts, src/ui/sub-agent-drawer.ts, test/chats/migration.test.mjs, test/backup/**, test/config/sessions-snapshot.test.js
- **Depends on:** W4-C, W5-B, W6-C

#### Task W7-B: End-to-end reliability, providers and budgets

- **Build:** Add a deterministic production-path fault-injection harness for the acceptance matrix and a read-only real-provider smoke script. Exercise packaged Node imports/assets, summary-only boot, history/stream subscription bounds and activity de-duplication. Record baseline known suite failures separately; do not turn an unavailable real provider into a fake pass. Fix regressions in the owning modules before release.
- **Test:** Run targeted chats/subagents/runner/remote/session/notifications/backup suites, coverage discovery, typecheck, full suite, board scenario contract, build/performance budgets, headless bundle/production/packaged boundaries and runtime-file validation. Run renderer-free restart/completion scenarios and real configured API/CLI/pool/local smoke paths. Capture keyboard/touch/theme/occlusion evidence for parent and child UX.
- **Accept:** All new deterministic scenarios pass, no new regression is hidden by existing main failures, production imports package successfully, current performance ceilings hold or a measured justified budget change is explicitly reviewed, and real-provider gaps are listed accurately.
- **Touches:** test/chats/**, test/sub-agents/**, test/headless/**, test/boot/**, scripts/verify-agent-conversations.mjs, scripts/validate-packaged-runtime-files.mjs, test/test-config.mjs, package.json, documentation/plans/verification/agent-conversations.md
- **Depends on:** W7-A

#### Task W7-C: Shipped documentation and activation

- **Build:** Update architecture/storage/API context and shipped manual only when the feature passes W7-B, including model precedence, exact auto/queue/steer behavior, task versus conversation results, requests, stop scopes, local capacity, legacy history and checkout lifetime. Refresh tool/architecture inventories and generated wiki. Enable the shared release capability and remove superseded new-format renderer-only ownership/delivery shims while retaining legacy readers. Keep README claims limited to verified behavior.
- **Test:** Run product-wiki and architecture checks, validate links/tool inventories and the plan parser, repeat the focused activation/legacy compatibility smoke, and verify app routes expose no new released/hidden app accidentally. Confirm disabling new creation still permits recovery.
- **Accept:** The released UI, tool contracts and manual agree; no documentation claims unimplemented cross-machine, cross-project or native-child capabilities, and no duplicate execution/delivery implementation remains active for new records.
- **Touches:** documentation/context.md, documentation/manual/orchestrate/agents.md, documentation/manual/**, documentation/ROADMAP.md, documentation/contributor/architecture-inventory.md, README.md, server/chats/feature.js, src/config/agent-conversations-enabled.ts, src/chat/prompts/tool-usage/**, scripts/generate-architecture-inventory.mjs
- **Depends on:** W7-B

## Delivery checkpoints

1. **Durable foundations:** W1 and W2 complete. Contracts, policy, model resolution, protected storage and full-fidelity transcripts are proven before writable child UI is advertised.
2. **Execution slice:** W3 and W4-A/B complete. Delegate to an explicit model, open the canonical child through a test harness, send a follow-up, restart, and receive one parent result with no renderer. Required host capabilities can pause truthfully.
3. **Coordination slice:** W4-C and W5 complete. Explicit checkout isolation and authorized chat messaging work with receipts, waits, scope and feedback controls.
4. **Product slice:** W6 complete. Users can perform the full flow through Code's normal chat surfaces, with reliable attention and no duplicated activity.
5. **Release:** W7 complete. Migration, failure injection, real-provider validation, packaging, budgets and shipped documentation pass before capability activation.

The dependency graph permits W2-C alongside storage and W6-A after persistent identity exists. Tasks touching the same runtime/session/sidebar files must serialize or integrate on current main; wave numbers do not override explicit dependencies. Do not begin implementation by exposing writable UI over legacy lossy runs.

## Verification Checklist

- [ ] The complete plan parses into 19 tasks with matching front-matter IDs, valid dependencies, Build/Test/Accept/Touches fields, and no cycle.
- [ ] An explicit model/effort selection works through the production server path without changing parent or remembered composer selection.
- [ ] Child conversation context remains complete after more than 50 messages, reload and server restart.
- [ ] Server-only child completion and parent continuation need no connected SSE viewer or renderer.
- [ ] Concurrent peer sends and steers remain ordered and idempotent; policy, workspace and device boundaries hold.
- [ ] Questions and approvals from multiple children remain independent, reachable and correct after reconnect/restart.
- [ ] Stop/wait scope, late automatic delivery/spawn disposal, causal budgets, family cap scope, worktree ownership and orphan-child behavior match the contract.
- [ ] Crash between tool mutation and result commit requires explicit recovery rather than automatically repeating side effects.
- [ ] Legacy homes, journals and snapshots remain inspectable; migration/restore and creation-disable recovery pass.
- [ ] Parent/child navigation, grouped activity, model controls, attribution, accessibility and performance have recorded evidence.
- [ ] Build, typecheck, coverage, relevant/full tests, board contract, packaged runtime and current performance budgets have recorded outcomes.

No implementation or validation checkbox above is marked complete by this planning change. Parser validation of the planning artifact is reported separately from feature verification.

## Reference material

- [Unified model selection and routing](unified-model-selection-and-routing.md), especially remembered selection, captured bindings and the now-superseded per-spawn deferral.
- [Minnow architecture context](../context.md), [product direction](../../PRODUCT.md), [design system](../../DESIGN.md), and [board testing contract](../contributor/orchestrate-board-testing.md).
- T3 Code source inspected at fa4e4677c0ecc437aece2dcea39f76ef31414152 and compared against v0.1.5: [delegation and messaging architecture](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/orchestration-v2/orchestrator-mcp-server.md), [contracts](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/contracts/src/orchestratorMcp.ts), [grouped activity](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/apps/web/src/components/chat/TimelineV2EventRow.tsx), [relationships](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/apps/web/src/components/chat/ThreadRelationshipsControl.tsx), and [tool-use evaluations](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/evals/mcp-tool-use/README.md).
