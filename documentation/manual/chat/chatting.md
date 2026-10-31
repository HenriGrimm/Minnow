# Working in chat

The basics of chat take one minute. The controls on this page are the ones that make a long agent session survivable: correcting a run without killing it, queueing your next instruction, undoing a turn that touched files, and going back to an answer you liked better.

## The composer

The composer is a card at the bottom of the chat column: the message field on top, one row of controls underneath.

| Control | What it does |
|---------|--------------|
| **Mode** | The tinted pill on the left: General / Build / Plan / Debug — see [Modes](../concepts/modes.md) |
| **Worktree** | Click the branch icon to enable an isolated checkout on send; click its name to change branch, switch worktrees, or go back to Local |
| **Settings** (cog) | Context documents, code map, brain notes, and Off/Ask/Full for every tool. |
| **Context ring** | Window usage; click for capacity, context breakdown, request/session totals, prompt profile, and compaction |
| **Model · reasoning** | Per-chat model and reasoning level. Open the menu to change either. **Ctrl+M** / **Cmd+M** opens it with search focused. |
| **Microphone** | Dictation — see [Voice](../extend/voice.md) |
| **Send / Stop** | Enter sends or steers a running turn; the Stop button ends the reply |

**Enter** sends, **Shift+Enter** adds a line. While a turn is running, **Enter** steers it and **Cmd+Enter** (Mac) or **Ctrl+Enter** (Windows/Linux) queues a follow-up for later. Empty Enter does nothing. **↑** with the caret at the start of the composer walks back through your previous prompts, shell-style; **↓** walks forward.

Drafts survive switching chats.

Selecting a model in the composer remembers it for new chats across all projects and restarts. Existing chats keep their own models. Opening an old chat, running background work, or a pool choosing a model does not change the remembered choice. Changing the model during an ordinary chat response stops that generation; the next turn uses the new selection. [Agent conversations](persistent-agent-chats.md) use **Stop and switch** and keep each queued message's captured model. A child model change does not change the remembered model for new ordinary chats.

Clicking the **branch icon** enables Worktree for this chat without creating a
checkout. Send your message to create a named branch from the current commit and
prepare project dependencies. A **Setting up your worktree** panel appears in chat;
your message runs in that checkout when setup finishes. Uncommitted edits stay in
the original checkout. The selection survives a reload.

If setup fails, the checkout is kept and your draft and attachments stay in the
composer. The setup panel shows the error with **Retry setup** and **Back to Local**
actions. Send again to retry setup and run your message, or choose **Retry worktree
setup** from the worktree menu to prepare it before sending. Minnow waits for setup
to succeed before running the chat in the worktree.

Click the **worktree name** to open its menu. Choose **Switch branch** for a different branch in that checkout, **Change worktree…** for an existing checkout, or **New worktree** for a custom name and start branch. **Back to Local** preserves the worktree and its files; enabling it again reuses that chat's managed checkout. Use Source Control or issue delivery controls for cleanup.

Drag files onto the composer to attach them for the next message, up to 10 MB each. Pasting images also adds an attachment.

The model label includes the current reasoning level, such as **GPT · Medium**. Its menu offers only the levels the model supports, including **Off** where available. Changes apply to this chat; **Default** restores the model's saved or inherited setting. Auto model pools continue to select reasoning through their task evaluator.

**Link a tab to this chat.** Drag a Code editor tab or an in-app browser tab onto the transcript or composer. Minnow pins a link chip on that chat — the file or URL, not a one-turn attachment. The chip stays after reload; click it to open the file or page. Dragging from the file tree still attaches for the next message only.

## While the model is working

In the desktop app, Minnow automatically prevents idle system sleep while a chat turn is running, including model loading and tool calls. Protection stays active across chats and workspace windows, even when Minnow is minimized or kept in the tray, and ends when the last turn finishes, fails, or stops. Your screen can still turn off. This does not override closing a laptop lid or putting the computer to sleep yourself. Browser and headless CLI runs do not provide this protection.

**Compact view** draws a running turn as a timeline under your prompt. A round of reads and searches is one step — **Explored 5 files, 1 search** — with the files it touched as chips; open it for the individual calls. Thinking time rides on the step it led to. While the run is live, a line above the composer shows **Working**, the elapsed time, and how many actions the turn has taken.

When the turn finishes it folds into one line — **Worked 6m 55s · 20 reads · 16 searches** — with the final answer below it. Expand the line to see the timeline again. Recorded file changes appear in an **Edited files** card with per-file counts, **Review**, and — on the latest turn — **Commit** and **Create PR**. Copy, remake, and the reply's speed sit under the latest answer. Failed and stopped replies remain visible, with a notice that carries the recovery actions.

Choose **Settings → Appearance → Chat view → Full** to keep every step visible in the transcript. Tool calls and thoughts stay collapsed until you expand them. Switch back to **Compact** for the quieter view. The preference applies immediately and is saved across restarts; it changes only the display, not the conversation sent to the model.

Claude and Codex reasoning summaries appear under **Reasoning summary**. A separate **Working…** indicator shows elapsed time and stays visible when you expand the summary. Summaries can arrive intermittently while the model continues working; a pause between updates does not mean the turn has stopped.

You do not have to sit still and wait.

**Type a correction or more context and press Enter.** Minnow applies it at the next step between tool rounds, keeping the current turn intact. Until then, the strip above the composer shows **Steering at next step** and your text, with a cancel button. Successive corrections are kept in send order. Once applied, the correction appears in the transcript as **You steered**. If the reply finishes without another tool round, the correction starts a follow-up turn.

Press **Cmd+Enter** (Mac) or **Ctrl+Enter** (Windows/Linux) for a separate task that should wait until the current reply finishes. Queued messages stay in the composer strip until sent, with controls to edit, steer the current run, or delete. Editing happens in place and keeps your current draft. Attachments stay in the composer until the running reply finishes; mid-turn messages are text only. `/compact` also waits for the reply to finish.

On a local llama.cpp or MLX model the status line beside the assistant row shows a load percent while weights come up, a prefill percent while the prompt is ingested, then a live token count while it generates (including while it is calling a tool).

**Stop** stays available while you type. It stops the chat and all its sub-agents, including nested agents, and keeps the partial reply. Unapplied corrections return to the follow-up queue, where you can review, send, edit, or delete them. Repeated Enter never stops the run or sends queued work.

## When a turn fails

If a reply errors mid-stream, the partial stays on screen. In ordinary chats, **Continue** retries with the full conversation still in context and **Clear** removes the failed assistant output while keeping your prompt. Agent conversations retain their saved history: send a new message to continue, and resolve any request or recovery notice in that chat.

Very large replies can stop with a replay memory limit error. Minnow budgets about 32 MiB of retained stream data and chunk overhead per generation, and 128 MiB across generation requests and replay. The retained prefix ends with an explicit error; it is not treated as a completed reply. Ask for a smaller output or wait for other replies to finish before retrying.

A connection that accumulates more than 4 MiB of pending stream data or stalls for 30 seconds is disconnected so other replies can continue. Reconnecting replays the retained bytes in order with their completion or error status. A saved reply too large for the available replay budget reports an error instead of loading a partial replay.

## Watching what agents do

- **Inference metrics** — tokens, tok/s and totals for the turn. In Code, the strip at the bottom of the chat column.
- **Activity** — the menubar dropdown shows what needs your input, what is running, and recent outcomes across the current workspace. Expand a running item to inspect its sub-agents, model, and context usage.
- **Agent cards and chats** — delegated assignments are grouped in the parent transcript. Open a saved child chat for its own conversation, composer, model controls and requests. The original assignment result remains on its card. Older tasks retain their inspector and can offer **Continue as chat** from partial saved context. See [Agent conversations](persistent-agent-chats.md).

The initial assignment returns its result to the parent with a source-chat link. Follow-up messages sent directly to the child stay in that child and do not automatically wake the old parent. **Stop chat** stops the current reply and all its sub-agents. **Stop agents** stops only delegated work while the parent continues.

## Undoing a turn

The **undo** control on the latest **Edited files** card in the transcript rewinds the last settled agent turn back to your message. Where Minnow captured a git snapshot around that turn, it restores the working tree too — not just the conversation.

Details worth knowing:

- The file-restoring undo appears **only in a git repository** and **only when that turn actually changed files**. No repository means no snapshot, so there is nothing to restore.
- The message **⋮** menu always offers **Undo turn** for a conversation-only rewind.
- Undo does not auto-regenerate. You get your prompt back and decide what to do.
- The undone reply stays redoable through the branch picker.
- Orchestrate, board-linked and worktree-isolated chats do not support undo; the control is disabled with the reason. Agent conversations also keep immutable saved history, so undo, regeneration, past-message edits and branch rewinds are unavailable; continue with a new message.

Snapshots are made with dangling commits, so your index, HEAD and branch are never moved. If two chats share one repository, the last restore wins.

## Files from the assistant

An assistant can present saved project files and generated deliverables as compact cards beneath its response. Each card shows the title, path, file type and size, with **Open** and **Download** actions. Cards stay visible when the work transcript is collapsed and remain after reopening the chat.

**Open** uses Code's editor or document preview. **Download** saves the file's original bytes. These are links to saved files, so both actions use the current file on disk rather than a copy frozen in the conversation. The source workspace stays attached to the card, including files produced in a worktree or sandbox. If a file has been moved or deleted, it must be restored or presented again at its new path.

## Branches

In ordinary chats that support history changes, regenerating or forking a turn creates a **branch** — a separate continuation from the same point. The branch picker appears on that message and lets you move between them; the branch you leave keeps its follow-up messages, so switching back and forth does not destroy either side.

This is how you try "do it with X" and "do it with Y" without two chats and manual copy-paste.

## Managing conversations

- **New chat** from the rail, or the tray menu.
- **Search** from the rail — full-text over your message history, with **↑ ↓** to move and **Enter** to open.
- **Groups** organise related chats; orchestrate boards appear as folders with their member chats nested.
- Chats belong to a workspace folder, so the rail shows what is relevant to where you are.

There is no fixed limit on how many chats you can keep. Chat deletion is confirmed in-app. Agent conversations cannot be deleted while they or their descendants have active work, queued input or pending requests. Deleting a settled parent retains its child conversations and checkout files.

Chats with an active `/loop` show a rotating icon in the rail — spinning while a loop is live, still when every loop on that chat is paused.

## Notifications

The menubar **Activity** icon appears before Models and opens live work and notifications for the current workspace. While agents are running, a spinning wheel shows their count, including nested sub-agents. Paused agents and background title jobs are excluded from that count. When no agents are running, only the icon is shown. Inside the dropdown, running work counts each parent once and nests its sub-agents.

**Needs you** holds unanswered questions, tool approvals, failures, and review requests. Opening the dropdown or choosing **Mark seen** does not resolve them. **Reply / review** opens the owning chat. Failures can be inspected and dismissed into **Recent**; failed scheduled jobs also offer **Retry run**. **Running** shows current work, including timer waits and queued work. Background title tasks are collapsed. **Recent** retains completed, failed, and stopped outcomes for the session, including replies you watched finish.

**Mute alerts** silences sounds and desktop notifications while Activity keeps updating. **Settings → General → Notifications** controls delivery categories and sounds, including whether cues play while you are already watching the active chat. **Stop all…** cancels chats, their sub-agents, and title jobs in the current workspace after confirmation.

Desktop notifications appear when an agent asks a question or finishes its turn while Minnow is in the background. Use **Test desktop notification** in notification settings to check delivery without starting a chat. In a browser, the test requests notification permission if needed. If the test reports that it was sent but no banner appears, check your system's notification settings and Do not disturb. On Windows, development builds appear separately as **Minnow Dev**.

## Asking you questions

The model can ask *you* something mid-run with a question card rather than guessing and being wrong. Answer it and the run continues. Skills like `/ask-user` use this deliberately.

## Related

- [Agent conversations](persistent-agent-chats.md)
- [Skills and slash commands](skills-and-commands.md)
- [Modes](../concepts/modes.md)
- [Context, memory, and rules](../concepts/context-and-memory.md)
- [Keyboard shortcuts](../reference/keyboard-shortcuts.md)
