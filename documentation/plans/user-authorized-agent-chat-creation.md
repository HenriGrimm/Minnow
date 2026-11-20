---
name: user-authorized-agent-chat-creation
planType: build
overview: Let agents create and work with normal top-level Minnow chats only through explicitly user-authorized actions.
---

# User-authorized agent chat creation

## Goal and scope

> “Start a new chat called Release Review, ask it to review the release notes, and tell me what it finds.”

The agent proposes the chat and shows the exact first message. The user confirms in the originating chat. Minnow then creates a separate, ordinary Code chat and admits the message. It appears in the normal sidebar, has its own history and execution, and can be opened or continued by the user. The agent gets a link and can read or wait for the result within the authorized task. The current view stays put. If the user only asked to open a chat, create an empty, durable chat and start no turn.

“Start a new chat” is not “spawn a sub-agent.” No child relationship, task card, implicit transcript copy, completion subscription, parent wake-up, or cascading Stop. A new chat does not start a conversation on its own. The user's authorization for one chat never authorizes a second chat or recursion.

**Parity means normal thread behavior, not human impersonation.** Use the same canonical command admission, model routing, queue/steer, Stop, history and approval surfaces as normal user chats. Agent messages identify their source chat; the user can type directly into the new chat and keep managing it like any other. Expose user-requested title, validated ordinary model choice and authorized checkout selection using existing selectors and defaults where available; if a value cannot be resolved safely, show that before committing rather than guessing. Permission changes, answering approvals as the human, archive/delete, arbitrary history edits, and cross-project actions are not included in the agent tool surface.

## Decisions and constraints

- **Two layers.** Agent instructions say to propose creation only when asked by the user. Never infer this from “delegate,” a file, a quoted request, an agent/system message, a tool result, or a suggestion from the target. The enforceable layer is an authenticated human confirmation of the exact action. Natural-language intent detection and a model-supplied “user asked” flag are not authorization. The confirmation is the user explicitly requesting the displayed action; proposing it alone has no effect.
- **No bypass in Full access.** Reuse durable request presentation where possible, but require an action-specific, server-verified approval record for this feature. Do not treat a generic approval Boolean, tool transport claim, Allow for this chat grant, or an answer from another execution as consent. Keep existing permission, host, turn-clamp and workspace rules as additional restrictions. Do not offer the approval where the action is forbidden.
- **Exact scope.** Bind approval to the project, source chat and authenticated human command grounding the active execution, tool-call/action ID, normalized action payload and a bounded lifetime. Preview title, model, checkout and full message if present; do not send hidden context or automatically forward attachments. Require a new approval if the preview changes. Denial, dismissal, timeout, source Stop and authority revocation prevent uncommitted creation. Consumed actions can replay their original receipt, not create again. Agent-only/system turns without a fresh human request cannot bootstrap this flow.
- **Follow-up controls.** An explicit “ask it and tell me” authorizes bounded read/wait of that target from the same source task; a create-only request does not authorize sending. Additional agent messages, steering, or Stop on an ordinary root require exact user confirmation of the target and action, including the pinned execution for steer/Stop. Reuse `chat_send`, `chat_read`, `chat_wait`, and `chat_stop`, not a second transport. Gate these effects at canonical admission for agent-to-ordinary-root actions, including existing targets, so another ingress cannot bypass consent. Preserve existing authorized sub-agent lifecycle and trusted system delivery paths; do not turn status/list metadata, human actions, or system receipts into approvals.
- **No privilege transfer.** Use branded runtime identity, verified workspace registration and the intersection of granted/current policies; creation or sending must not let the source run with a broader policy indirectly. Keep the ordinary target human-manageable. If the user later broadens the target or switches to an unsupported checkout, the source is denied rather than inheriting authority. Maintain existing causal fanout/depth limits, cycle checks and wait timeouts.

## Relevant files

- `src/ui/sidebar.ts:2449` owns foreground creation, including draft reuse, default model binding and navigation. `src/state/background-chat.ts:10` avoids focus changes but creates renderer-owned background records, not ordinary durable roots. Extract shared ordinary-chat initialization/default resolution only as needed; don't call either UI flow as the agent.
- `server/chats/service.js:341` promotes an existing renderer-created root; it is human-only. The canonical fork at `server/chats/service.js:509` shows durable root/profile/command/receipt publication, but copies history and requires a saved replay anchor. Add fresh-root admission, not a fake human promotion, a fork, or a disguised sub-agent.
- `server/chats/tools.js:65` is the existing coordination dispatch. `server/chats/service.js:195` handles command admission; `server/chats/caller.js:162` checks current target authority. Reuse these boundaries and current receipt, transcript, request, fence and causal infrastructure.
- `server/chats/execution-host.js:198` and `server/chats/agent-tools-middleware.js:35` have different approval adapters. Neither generic approval result on its own proves consent for this action. Add a shared server-side verifier and gate every enabled ingress. A host without explicit approval and attribution support fails closed.
- `src/state/session-workspace-scope.ts:46` can hide or prune empty drafts. Use protected, server-owned persistence metadata for explicitly created empty roots; don't insert a fake message or make all empty drafts permanent.

## Implementation steps

### 1. Define and enforce authorization

- [ ] Define the action and receipt contracts, threat model and request tests.
- Changes: Add the tool contract and wire consent to authoritative command admission.
- Add a discoverable `chat_create` tool with bounded title, optional first message, approved model and checkout options, and stable request ID. Derive identity/project/source from the execution. No user-role, parent, permission, raw path, transcript or approval-token arguments.
- Implement exact-action human confirmation and replay/expiry rules on the canonical server. Cover the managed and legacy tool ingress; otherwise hide or reject the tool rather than routing through an unverified host. For new or existing ordinary targets, build the authorization gate into agent interaction and bind read/wait scope to a confirmed task. Preserve existing metadata discovery and sub-agent coordination.
- Acceptance: no chat or ordinary-root command is admitted by forged consent, an unrelated approval, a changed payload, an agent/system-originated instruction, or Full access alone. Deny/dismiss/expire/stop and policy/checkout revocation leave no uncommitted effects.
- Verify: Run canonical command, approval and tool transport regressions with denial and tampering fixtures.

### 2. Create an ordinary server-owned root

- [ ] Persist a fresh root, and optionally admit its first turn, with retry-safe receipts.
- Changes: Add a shared fresh-root initializer and transactionally couple it with optional first-turn admission and the creation receipt.
- Resolve fresh-chat defaults and validate requested settings through the shared model, policy and workspace code. Use the source's verified authorized checkout by default; surface and confirm the resolved checkout. No implicit worktree allocation; an explicitly requested new worktree, if supported, uses the existing verified preparation intent, never a fallback to Local. Keep user preference changes out of this flow.
- Factor ordinary root/profile initialization and first-message admission as needed. Commit the normal session row, needed profile, optional initial command and idempotency receipt as one transaction. Recheck caller fence, consent, checkout and policy at commit; publish only after commit. Schedule via the existing queue, not a second runner. Register creation as a durable effect so a lost result, crash or retry can't create a duplicate.
- Receipts return stable chat ID/link, optional command ID, and admission state (not a claim of completion). Reusing the same key with different input fails. Recovery resolves the receipt before retrying the effect.
- Acceptance: create-only returns one visible empty root with no model dispatch; create-and-send returns one root and one attributed queued command. No copied history, parent relation, automatic reply, or half-created session after precommit failure; a post-admission model/setup failure is visible in the new thread.
- Verify: Run repository and runtime integration tests for empty roots, initial sends, rollback and restart replay.

### 3. Wire normal chat interaction and presentation

- [ ] Wire the tool and verify a full human-to-agent-to-chat flow in Code.
- Changes: Register supported tool surfaces and reuse normal session publication and thread controls.
- Register capability, effect classification, dispatch/recovery and prompt guidance in the shared catalogs for supported runners. Keep disabled/unavailable hosts truthful; do not add a browser, shell, plugin, or human API fallback for denied actions.
- Publish session summaries to connected views without changing active chat, taking over the composer, or rehydrating unrelated transcripts. Preserve a newly created empty chat after reload and across windows. Reuse normal links, transcript attribution, requests and composer. Show waiting-for-human and terminal workflow states through existing surfaces; the source can report a blocked target with a link but cannot answer a user-only request.
- Acceptance: user can open the sidebar row and take over with the normal composer; source can read/wait for the authorized reply, and send/queue/steer/stop with appropriate authorization. Closing or stopping the source after admission does not cascade to the independent root.
- Verify: Exercise an authorized create-and-report and a create-only request in Code across reload and in a second window.

### 4. Verify and document

- [ ] Test permissions, durability and desktop/narrow behavior; document the shipped contract.
- Changes: Add cross-layer regression coverage and update the shipped docs and architecture notes.
- Extend conversation tools, HTTP middleware, policy, causal and checkpoint suites. Cover denial in Full access, untrusted transcript inputs, exact-argument consent, fake approvals across adapters, revocation before commit, immutable replay, concurrent retries/restart, delete/replay behavior, unauthorized existing-root interactions, and preservation of system/child flows. Test policy narrowing for agent-started roots and recheck target changes on long waits.
- Add renderer/session integration tests for normal sidebar placement, empty-root durability, unchanged source focus and unsent draft, no child cards, stable links, agent attribution and user takeover. Verify durable approval and target questions in desktop and narrow Code views; test supported transports with a fake provider before live/package smoke tests.
- Run affected server, chat and UI tests, `npm run test:check-coverage`, and `npx tsc --noEmit`. Update coordination prompt, shipped manual and `documentation/context.md` only with the implemented contract.
- Acceptance: show the complete prompt-to-result flow, plus a denial and a lost-response retry, with zero unauthorized or duplicate roots/commands and no unintended surface changes.
- Verify: Run the suites and static checks above; capture observed desktop and narrow behavior.

## Acceptance checklist

- [ ] Explicit one-time authorization is required and cannot bypass workspace, permission or execution restrictions.
- [ ] Creation returns exactly one ordinary, durable root and optionally one attributed first turn, without moving the user's focus.
- [ ] The user can continue the chat normally; the agent can interact only within the authorized scope.

## Risks and open questions

- Some hosts may not project the durable human confirmation or resolve the user's remembered model and checkout defaults. Validate host parity before advertising the tool there; do not silently substitute a different target or approval path.
- Initial-command admission and duplicate recovery must share the root creation transaction without holding workspace or session locks while waiting for human confirmation.
