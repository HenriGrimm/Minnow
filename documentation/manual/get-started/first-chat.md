# Your first chat

You start at the **workspaces picker** — open a project folder. Minnow then opens **Code** with the chat rail on the left, beside the repo it will be working on.

This page walks through one real turn: send a message, watch it stream, approve a tool, and understand what you just saw.

## Code with chat open

| Area | What it is |
|------|------------|
| **App rail** (left edge) | Switch between Code, Models, Brain, Issues, Scheduler; open the workspaces picker from the workspace control in the menubar |
| **Menubar** (top) | Workspace chip, model chip, notification bell, update pill, Settings, help (**?**) |
| **Chat rail** (inside Code, left) | Your conversations. Search and start new chats from here. |
| **Composer** (centre) | Where you type. Mode strip, attachments, tools, microphone, model, send. |
| **Project panel** (right) | File tree, editor, preview — everything scoped to the folder you opened |

The folder you pick at the workspaces screen becomes the **workspace root**. File and git tools in chat resolve inside that folder. Change workspace anytime from the menubar — you return to the picker (`#/workspaces`) and can open a different project.

## Send something

Type into the composer and press **Enter**. **Shift+Enter** makes a new line instead.

Try a question that forces Minnow to actually look at something rather than recite a plausible answer from memory:

> What can you do on this machine? Check what tools you have.

While the reply streams you will see a live token/second readout and a growing response. Press **Enter** again — or the stop button — to cut it short. Nothing is lost; the partial reply stays in the transcript.

## Approving a tool

Most interesting requests make the model call a tool. When a tool's permission is **Ask**, a strip appears with three choices, and there are keyboard shortcuts for them:

| Key | Action |
|-----|--------|
| **1** | Allow once |
| **2** | Always allow this tool |
| **3** | Cancel |

Digits work whenever the strip is open and you are not typing in a field.

"Always allow" writes a real permission change to disk. It applies to every future chat, not just this one. If you want it back, **Settings → Integrations → Tools** — or the tools button in the composer, which opens the same Off/Ask/Full controls in a popover.

Read [Tools and permissions](../concepts/tools-and-permissions.md) before you turn a lot of things to Full. The short version: file and git tools are confined to the folder you have open, and that boundary is the main thing standing between an over-eager agent and the rest of your disk.

## The mode strip

Four modes sit under the composer. They change the system prompt *and* which tools exist at all.

| Mode | Use it for |
|------|------------|
| **General** | Everyday questions and mixed tasks. The only composer-strip mode that can read this manual (`minnow_docs_*`). |
| **Build** | Writing code. Files, git, terminal, code intelligence. |
| **Plan** | Designing and analysing. Reads anything; cannot edit your files except plan documents. |
| **Debug** | Investigating failures, with access to diagnostics and the Issues tracker. |

Pick the mode *before* you send. "Design this, do not touch my code" is a Plan-mode instruction that Plan mode actually enforces — the mutating tools are not merely discouraged, they are absent.

[Modes](../concepts/modes.md) explains what each one allows in detail.

## The context ring

The ring beside **Send** shows how much of the model's context window this conversation is using: system prompt, tools, history, attachments and all. Click it for a breakdown.

If no limit appears, the model did not report a context length — the ring cannot guess. If replies suddenly get vague or start forgetting things you said, that ring is the first place to look. See [Context, memory, and rules](../concepts/context-and-memory.md).

## Attachments

Drag files onto the composer, or use the attachment button. Up to 10 MB per file.

- **Images** are sent as image parts, which only works if the model has vision. A text-only model will ignore them.
- **PDF, Word, Excel and similar** are parsed to text by the local tool server before the model sees them.
- For code, you usually do not want an attachment at all — keep the project open in Code and let the model read files with tools. It can then read the parts it needs instead of you guessing.

## Slash skills

Type **/** at the start of an empty composer to open the picker. Skills are packaged instructions the model follows — code review, commit-message writing, a security pass, a UI critique. Nineteen ship built in and are on by default.

The same picker holds `/goal` and `/loop`, which are not skills but chat controls: one keeps working until a condition is met, the other re-runs a prompt on a schedule.

See [Skills and slash commands](../chat/skills-and-commands.md).

## Opening another app

**Models** and **Brain** open as full-stage apps; **Settings** opens from the menubar gear.

The assistant can also open apps itself when it decides that is what you want — that is the `launch_minnow_app` tool, and it can carry your message across as a seed.

## Where your conversations go

Chats are stored in SQLite in your Minnow home and grouped by workspace folder, so the rail shows the threads that belong to where you are working. There is no fixed cap on how many conversations you can keep; the rail sorts by recent activity. Empty chats you never used are pruned when you switch away (board-linked and planner chats are kept).

## Next steps

- [How Minnow works](../concepts/how-minnow-works.md) — the mental model for everything else
- [Working in chat](../chat/chatting.md) — queueing, steering, undo, branches, dictation
- [Apps overview](../apps/overview.md)
