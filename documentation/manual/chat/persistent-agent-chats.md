# Agent conversations

Delegating a task creates a saved conversation for that agent. Open it to read the work, answer a question, choose a model, or send a follow-up. Switching chats or closing a chat view does not stop accepted work. Minnow's server must remain running for work to continue.

## Open an agent chat

Expand the parent in the chat list to see its agents. Active agents and those needing your attention stay easy to find; **Show more** reveals additional children. The parent transcript also groups delegated tasks into agent cards. Select a card to open the agent's normal chat, with its own composer, thoughts, tool calls and saved messages.

The header identifies the parent, links back with **Open parent**, and shows the agent's inherited permission ceiling. Deeper conversations show an ancestor path. A missing or deleted parent does not erase its retained children.

Some native provider agent conversations are **Inspect only**. Their header explains that they must be continued in their original host; a visible transcript does not imply Minnow can send to it.

## An assignment and its conversation

The original task has a saved result. Its card keeps that result even if the child chat later receives another message, changes model, or encounters an error.

The initial delegated assignment returns its result to the parent. Results appear with their source conversation, and several completing agents can be collected into one parent continuation. If the parent already received a result while waiting, it is not delivered again as an extra wake-up.

A later message sent directly to the child continues that child conversation. It does not reopen the old task or automatically wake the old parent. Ask the parent to delegate another assignment when you need another result returned there.

A parent can show **Waiting for agents** after its own reply ends. That is an outstanding assignment, not a model still generating. Usage reported by a child belongs to that child's chat; showing its result in the parent does not charge those model requests to the parent a second time.

## Choose each agent's model

Open the child chat's model controls to select the provider and model for new messages. Reasoning and thinking controls appear only where that model supports them. The saved selection also shows any captured thinking-token budget. Changing a child model does not change the remembered model for new ordinary chats.

Changing the model applies to new messages while an active reply keeps its captured model. Select **Stop and switch** to stop that chat and all its sub-agents. Already queued messages keep the model and options saved when they were accepted; changing the dropdown does not silently rebind them.

For a new delegation, model selection follows this order:

1. The explicit provider/model chosen for that spawn.
2. The agent type's configured provider/model.
3. The sub-agent model routing default.
4. The parent chat's selection.

Agent type and explicit option overrides apply to the selected model only when supported. Type defaults affect new delegations; an existing child keeps its captured instructions and its own model selection.

An unavailable explicit model or unsupported option produces an error instead of silently choosing another provider. A model pool chooses among its eligible members; the saved selection remains the pool and the actual model is shown when known. A local model may show **Loading model** or wait for model capacity before generating.

## Send, queue and steer

The child uses the familiar composer: **Enter** steers a running reply, and **Cmd+Enter** (Mac) or **Ctrl+Enter** (Windows/Linux) queues a separate follow-up. A correction is applied at the next tool-round boundary. If the reply finishes before another boundary, the correction becomes the next turn.

Queued rows show their saved model. Use **Edit queued message**, **Delete queued message**, or the send arrow. The arrow steers the current run while one is active and sends the queued message while idle. Editing the queued text preserves your current composer draft and the item's saved model.

An agent using `chat_send` has three choices: **auto** starts an idle chat or queues behind its current reply; **queue** preserves a separate ordered follow-up; **steer** requires a running reply that can accept steering. An explicit steering request reports an error when that capability is unavailable.

## Questions and approvals

**Needs you** in Activity opens the conversation that owns the request. Each agent has its own question and approval cards, so two waiting children can be answered independently without changing either chat's draft.

Use **Send answer** or **Skip question** on a question. For an approval, inspect **Review tool arguments** and the shown workspace, then choose **Allow once** or **Deny**. Allow once applies to that one tool call; it does not change the agent's saved tool permissions.

Opening Activity or marking an item seen does not answer it. Requests remain attached to their original chat after navigation and reload. A safely recoverable question can resume the same turn after a restart. Approvals whose execution callback has gone expire; an old approval cannot authorize a new action. Expired or otherwise unrecoverable requests retain their saved context, but cannot accept a late answer.

Some tools need a connected desktop host, browser or other capability. **Waiting for host** means the required executor is unavailable; it is not a generating spinner. Unknown tool effects show **Needs recovery** rather than being replayed automatically.

## Stop controls

| Control | Scope |
|---|---|
| **Stop chat** | Stops this chat's current reply and all its sub-agents, including nested agents, and prevents old results from waking it. Unapplied corrections and queued work are held for review. |
| **Stop agents** | Stops this conversation's child work and prevents old results from automatically waking it. The parent's own reply and queued human messages remain. |

Stopping retains saved messages and partial output. A stale stop or answer from an older turn cannot act on a replacement turn. Restarting Minnow does not grant permission to repeat an uncertain file or native-tool effect.

## Messages between chats

Agents can discover, read and contact conversations in the same project when their current permissions allow it. Different checkouts must belong to that registered project. A message cannot give the sending agent broader authority through another chat.

| Tool | Use |
|---|---|
| `agent_capabilities` | Discover available agent types, models, options and coordination limits. |
| `chat_list` | List permitted same-project chats with bounded results. |
| `chat_read` | Read a bounded message page or current activity. |
| `chat_send` | Submit an attributed auto, queue or steer message. |
| `chat_wait` | Observe a selected execution until it ends, blocks or reaches the wait timeout. |
| `chat_stop` | Stop a permitted turn, or its tree when allowed. |

Incoming messages identify the source chat; they are not presented as something you typed. Waiting observes one execution, not every future message in that chat. A wait timeout leaves accepted work running. Self-waits, circular waits and unbounded message exchanges are refused with a visible tool result.

## Saved history and older tasks

Agent conversations keep their saved history. Editing past messages, regenerating, undoing a turn, clearing failed output, truncating, forking and switching historical branches are unavailable in this version. Send a new message to continue. Transcript copy/export and file review remain available, and editing a message that is still queued is supported.

Older sub-agent tasks keep their original inspector. **Continue as chat**, where available, creates a fresh child conversation using the saved context. It is marked as partial archival context: old logs may be capped or incomplete. It does not resume the old execution, replay its tool calls or automatically wake the old parent. Review the context and send a new instruction.

## Checkouts, deletion and backups

Delegation can share the current checkout, use a registered checkout, or create an isolated Git worktree. New worktrees start at the captured parent commit; uncommitted parent edits stay in the original checkout. An inherited permission ceiling still applies, including any write authority limited to a verified child checkout.

Stopping, failing or deleting a conversation does not remove its worktree or uncommitted files. Deletion is blocked while the conversation or a descendant has active work, queued input or a pending request. Once deletion is allowed, retained children remain available even if their parent is missing. Use Source Control's explicit checkout cleanup controls when the files are no longer needed.

[Backups](../reference/backup-and-restore.md) retain conversation records and family history. They do not include checkout files. Restoring a conversation cannot manufacture permission to use an unavailable or replaced checkout.

## Continue from the CLI

`minnow run --chat-id <id> --prompt "Follow up"` uses the saved conversation's model, permissions, queue and ownership checks. Existing chats use the server's command path; the CLI does not start a competing local turn. Model overrides that conflict with the saved selection are rejected.

`--chat-action queue` queues a separate message; `--chat-action steer` requests steering. Reusing `--client-request-id` retries the same accepted message without creating another one. `--wait-timeout` stops waiting for the receipt's outcome while leaving accepted work running. See `minnow run --help` for current options. A fresh local CLI run without a saved chat has no authenticated conversation sender and does not offer chat-to-chat coordination.

## Related

- [Working in chat](chatting.md)
- [Board work agents](../orchestrate/agents.md)
- [Tools and permissions](../concepts/tools-and-permissions.md)
- [Backup and restore](../reference/backup-and-restore.md)
