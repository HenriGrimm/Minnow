# Follow delegated work in agent conversations

Ask the parent thread to delegate a well-defined task, such as “Have a reviewer read the new CSV tests and report coverage gaps with file references.” The assignment returns a result to the parent. The child conversation keeps the transcript, tool results, and follow-up messages.

## Find and continue a child

1. Select the agent card in the parent transcript, expand the parent in the thread list, or open **Agents** in the thread's surface launcher to inspect the assignment.
2. Use **Previous agents** for finished assignments. Open the child to read its full conversation. **Open parent** returns to the originating thread.
3. For another question to that agent, send it from the child's composer. To get a new assignment result back in the parent, ask the parent to delegate again. A child marked **Inspect only** provides its transcript and identifies the host that can continue it.

## Change models or answer requests

Use the child's model picker for new messages. Work already running and messages already queued keep their captured model. New assignments use the explicit choice if supplied, then the agent type's model, the routing default, or the parent model. Inherited permission ceilings still apply.

Open **Activity → Needs you** to go to the thread or child that owns a question or approval. Read the workspace and arguments before answering it. Use **Enter** to steer ongoing work or **Ctrl+Enter** / **Cmd+Enter** to queue a follow-up.

## Recover and clean up

If the parent says **Waiting for agents**, open **Agents** to see which assignment is outstanding. Use **Stop** in a chat's composer to stop that chat's turn and its descendants. Check **Confirm stopped** on the host only after verifying the command has ended.

A stopped or deleted conversation can leave its worktree and files behind. Inspect and clean up the checkout explicitly in [Source Control](../apps/code.md#source-control-center). [Backups](../reference/backup-and-restore.md) carry conversation records. Copy checkout files separately if you need them.
