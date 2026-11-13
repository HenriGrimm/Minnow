# Ordinary server execution: admission and rollout evidence

Status: managed admission, deferred setup, canonical replay/configuration and explicit promotion are implemented. Supported ordinary new/idle roots promote by default. `MINNOW_ORDINARY_CHAT_EXECUTION=0` blocks new promotions without downgrading canonical ownership or recovery. This is not complete historical-workflow or packaged cross-platform certification, nor all fourteen plan steps delivered.

## Implemented boundaries

- `/api/chats/capabilities` advertises ordinary execution independently of delegated-agent creation. JSON/mixed storage fails explicitly. An existing canonical chat never downgrades to a renderer writer, including rollback.
- Eligible raw roots are flushed with existing session reconciliation, then promotion pins the acknowledged saved revision. The authenticated protocol-v1 routing endpoint serializes promotion with configuration/sends; current scope, saved revision, live owner and gate are checked before and after asynchronous profile capture. Canonical profile/marker and immutable outbox receipt commit together. Promotion itself performs no inference. Devices observe but never promote.
- A lost promotion response retains its exact request/revision identity through reload. An incomplete acknowledgement cannot clear a draft or fall back to a renderer generation. Concurrent windows cannot establish two owners/profiles. Read-only observer streams do not promote. Stale raw frames/summaries cannot replace canonical history.
- Canonical send intent accepts bounded server-resolved slash/pinned skill references, UI Designer turn settings, attachment/reference metadata, issue/code-map snapshots, hidden echo and ephemeral/goal context. It does not accept an arbitrary trusted client system prompt. Accepted settings/selected model/options are captured for queued execution; live restrictions can narrow them. Plugin-local slash controls never become model sends. Malformed receipts preserve the original request and draft.
- Workspace preparation now persists the deferred intent in the same transaction as the command. The server verifies/creates the exact checkout and dependencies before composing the prompt or calling the provider, then binds the final scope and captured policy to that identity. Failure never runs against the wrong source checkout. Stop during asynchronous capture commits no command/allocation.
- `/api/chats/:id/workspace` Retry and Local are authenticated, serialized human recovery actions. Retry prepares the retained checkout but does not repeat failed inference; Local explicitly detaches without deleting files. Stop can cancel the setup owner. The existing UI panel consumes server progress/error projections across remounts.
- Human future-turn model/mode configuration revision-checks and atomically persists its profile and receipt. Accepted/active runs retain captured ceilings; narrower child profiles cannot widen silently.
- Ordinary canonical chats support same-chat edit, replay, and suffix deletion through a human-only command endpoint. Transcript digests fence concurrent edits. Replays queue a fresh input with saved turn settings when available. A rewind keeps the durable effect journals and usage records, and blocks unresolved work, native execution history, and compacted transcripts.
- Modern canonical roots support edited/replayed forks into a new canonical conversation. Prefix copying keeps completed atomic call/result groups, attachments, actual captured options, saved run/snapshot observations and immutable source lineage. No old effects, execution leases, provider sessions or task subscriptions are executed/copied as runnable work. Forks do not restore past filesystem state. Unsupported compacted/native/delegated/uncertain prefixes stay guarded. Historical promoted rows without captured command snapshots do not advertise an unusable Replay action.
- Server baseline/request overlap and exclusive per-effect pre/post checkpoint settlement are integrated. Causal waits release the checkout lock. Interrupted journal states survive archive restore. The runtime resolves interrupted attempts once it can verify that work has stopped, preserving checkout files and effect records.

## Parity and remaining scope

| Area | Evidence / status |
| --- | --- |
| Text, images, attachment-only and exact receipts | Existing attachment/preparation/managed-client tests; image fallback remains in shared runner |
| Slash/pinned/UI Designer and local plugin commands | Intent capture/compose/client tests; installed skill identity resolved server-side |
| Issue/code-map, hidden echo and ephemeral context | Contracts, command capture, execution-host and managed client tests |
| Deferred worktrees, final cwd, failed deps, Retry/Local | Actual production HTTP runtime scratch Git/npm fixtures; next-turn final binding verified |
| Plan/model configuration | Revision, concurrent receipt, active ceiling and child-policy tests |
| Fork/replay/edit branch | Modern canonical captured-message roots; compacted/native/delegated/legacy captured-context gaps remain guarded |
| Same-chat message actions | Ordinary canonical roots, including visible human prompts promoted from renderer history |
| New-root/idle promotion | Real save → revision-checked promotion → command → server host client test; concurrency/restart/lost-receipt/race tests |
| Renderer closure/server restart | Existing host/recovery/process-restart fixtures; full packaged per-phase matrix not certified |
| Legacy/controller/native workflows | Named exclusions before promotion; not complete historical parity |
| Four-stream input/paint and real packaged Windows/macOS/Linux | Outstanding release certification |

The initial conservative promotion scope is workspace-backed General/Build/Plan/Debug roots without live renderer/native recovery, active goal/loop/controller state, specialized/background preparation or unresolved legacy context. Current historical eligibility exclusions are defined by `server/chats/ordinary-routing.js`, shared with the client. Unsupported raw chats remain on their pre-admission compatibility path, never as a fallback after promotion.

## Verification

All integration checks use scratch homes and fake inference, not live settings or paid account calls. Parent focused runs pass for command/context/middleware/preparation, ordinary-routing service/client, real worktree HTTP setup/retry/local, Git/index/checkpoint/archive, setup UI, remote, backup, Scheduler and packaged-source boundary. Typecheck and production/headless builds pass; bundle budgets/discovery pass. See the [chronological evidence report](../plans/chat-performance-implementation-evidence.md) for counts, benchmark limits and full-suite failures. The full repository run is not green and no packaged cross-platform certification is claimed.

The server checkpoint journal and worktree preparation are real production wiring, not dormant replacement runners. Default promotion is verified through actual HTTP runtime worktree/history/rollback fixtures and renderer save → promote → managed send; unsupported scopes remain explicit pre-admission exclusions. Native action admission/approval/recovery integration is tracked in the [installed enforcement follow-up](../plans/chat-performance-native-enforcement-evidence.md).
