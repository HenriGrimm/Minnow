# Your first chat

You start at the **workspaces picker** — open a project folder. Minnow opens **Code** with the chat rail beside your repo. Your existing project conversation stays selected. An empty chat shows the hub, where you can describe what to build, browse files, or open a terminal.

To start from a remote repository, choose **Create From Remote**, paste its HTTPS or SSH clone link, and review the suggested folder name and location. **Clone and open** downloads the repository and opens it as your workspace. New folders use the location in **Settings → General → New projects**; **Change location** overrides it for this project. Existing folders are never overwritten. Git must be installed, and private repositories use your Git credentials or SSH keys already configured on the device. Install the project's dependencies using its setup instructions after opening it.

This page walks through one real turn: send a message, watch it stream, approve a tool, and understand what you just saw.

## Code with chat open

| Area | What it is |
|------|------------|
| **App rail** (left edge) | Switch between Code, Dashboard, Source Control, Models, Brain, Issues, Scheduler; open the workspaces picker from the workspace control in the menubar |
| **Menubar** (top) | Workspace control, Activity, Models, update pill, Settings, help (**?**) |
| **Chat rail** (inside Code, left) | Your conversations. Search and start new chats from here. |
| **Composer** (centre) | Where you type. Permission level, run target, reasoning, settings, model, attachments, microphone, send. |
| **Project panel** (right) | File tree, editor, preview — everything scoped to the folder you opened |

The folder you pick at the workspaces screen becomes the **workspace root**. File and git tools in chat resolve inside that folder. Change workspace anytime from the menubar — you return to the picker (`#/workspaces`) and can open a different project.

## Send something

Type into the composer and press **Enter**. **Shift+Enter** makes a new line instead.

Try a question that forces Minnow to actually look at something rather than recite a plausible answer from memory:

> What can you do on this machine? Check what tools you have.

While the reply streams you will see a live token/second readout and a growing response. Press **Enter** again — or the stop button — to cut it short. Nothing is lost; the partial reply stays in the transcript.

## Approving an action

Most interesting requests make the model call a tool. Under the default **Auto** permission level, routine work inside your project just runs; when something is risky, destructive, or outside the project, a card appears above the composer:

| Key | Action |
|-----|--------|
| **1** or **Enter** | Allow once |
| **2** | Allow this kind of action for the rest of this chat |
| **3** or **Escape** | Deny |

Digits work whenever the card is open and you are not typing in a field. Type in the card's field and press **Enter** to deny and tell the agent what to do instead.

The permission pill in the composer switches between **Manual**, **Auto** and **Full access** (or press **Shift+Tab**). It is one setting for every chat. Read [Tools and permissions](../concepts/tools-and-permissions.md) before choosing Full access.

## Asking, planning and debugging

There is one agent, and it can do everything you allow. To shape a single turn, start your message with a workflow command:

| Command | Use it for |
|---------|------------|
| **/ask** | Questions about the code or the project. The turn is read-only: nothing is edited or run that changes anything. |
| **/plan** | Designing before building. The turn can only write plan documents under `documentation/plans/`. |
| **/debug** | Investigating a failure: reproduce, find the cause, then fix it. |

See [Skills and slash commands](../chat/skills-and-commands.md).

## The context ring

The ring beside the model name shows how much of the model's context window this conversation is using: system prompt, tools, history, attachments and all. Click it for a breakdown.

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
