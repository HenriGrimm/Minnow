# Work in a thread

## Give the agent enough to start

Choose a model in the composer. Send the outcome, relevant path or error, and how to check the result. Use the attachment control or drop a file or screenshot onto the composer. For editor files, drag the file tab into the composer. For a second question about the same work without steering the main run, open **Side chat** in the surface launcher.

Start with **/ask** for read-only investigation, **/plan** for a saved plan, or **/debug** for a troubleshooting workflow. Send an ordinary prompt when you want the agent to implement a change. The [permission control](../concepts/tools-and-permissions.md) governs its actions.

## Intervene while a run is active

| You want to… | Do this |
| --- | --- |
| Change direction now | Enter a correction and press **Enter**. The agent receives it at its next step. |
| Run a separate follow-up after the reply | Use **Ctrl+Enter** / **Cmd+Enter** to queue it. Edit or delete it from the queued row. |
| Answer a question or approve an action | Open the card above the composer. **Activity → Needs you** can take you to the owning thread or agent. |
| Check a sub-agent | Open **Agents** in the surface launcher and pick the assignment. Use its conversation for a direct follow-up when supported. |
| Stop execution | Select **Stop** in the composer. Check **Diff** or the terminal before continuing. Work that already ran can leave files or other effects. |

## Recover after a failed turn

When a turn fails, a card at the end of the chat says what happened and how to recover. Your message and any finished work stay in the chat.

| Card | What to do |
| --- | --- |
| **Signed out** | Select **Sign in** to renew your Claude Code, Codex or Cursor login in place, then **Retry now**. |
| **Out of usage** | Select **Retry now** to try anyway, or **Retry automatically** to have Minnow retry when the allowance resets. Minnow must stay open for the automatic retry. You can also pick another model in the composer. |
| **Busy or unreachable provider** | Wait a moment, check the provider under **Models** if needed, then retry. |
| **Credentials, model or conversation length** | Fix the API key under **Models → Providers**, pick another model, or run `/compact`, then retry. |

**Try again** sends your message again. When the turn already did some work, **Continue** asks the agent to pick up where it stopped, and **Start over** replaces the turn. Open **Technical details** for the provider's own error. If a command failed, copy the command and its first useful error into your follow-up. If Minnow asks you to **Confirm stopped**, verify the command has stopped on the host first.

When the message menu offers retry, edit, undo, or fork actions, inspect what the action affects before using it. Review the checkout separately in **Diff** or **Source Control**, especially after a command with side effects.

## Return to earlier work

Use the thread list to reopen a conversation. Use **Ctrl+F** / **Cmd+F** outside the editor to search threads, messages, and issues, or open **Archive** for an archived thread. Open the thread card to confirm the branch, model, and permission level before continuing.
