# Minnow manual

Minnow is a local-first development workspace that runs on your own computer: editor, terminal, git, issues, planning, agents, research, and local model hosting in one app. It talks to models you host yourself — LM Studio, Ollama, `llama-server`, or any OpenAI-compatible endpoint — and it can also talk to cloud APIs if you give it a key. Either way, your chats, notes, files, and credentials stay in a folder on your disk. Nothing is uploaded to Minnow's authors, and there is no telemetry — an arrangement that was once unremarkable and is now, apparently, a feature.

You open a project folder and land in **Code**: your files and editor on one side, chat on the other, driving the same repo. Five surfaces support that work from the app rail — **Research**, **Models**, **Brain**, **Issues**, and **Scheduler** — plus **Settings** from the menubar. The same assistant and tool set back all of them.

This manual covers the packaged app you install from GitHub Releases. If you build from source, everything here still applies, plus the developer setup notes in the [GitHub Wiki](https://github.com/HenriGrimm/Minnow/wiki).

## Start here

If you have five minutes, do these three things in order:

1. [Install Minnow](get-started/install.md) and let it open.
2. [Connect a model](get-started/connect-a-model.md) — without one, the model picker stays empty and nothing can answer you.
3. [Send your first chat](get-started/first-chat.md) and approve your first tool call.

After that, [How Minnow works](concepts/how-minnow-works.md) is the page that makes the rest of the product make sense.

## Finding help while you work

The **?** button in the menubar opens this manual inside Minnow. Press **Ctrl+K** / **Cmd+K** while it is open to jump to search. Pages match the version you have installed.

Chat can also read this manual. In **General** mode (and during first-run onboarding) the assistant has three read-only tools — `minnow_docs_search`, `minnow_docs_read`, `minnow_docs_list` — so you can ask "how do I point Minnow at Ollama?" and get an answer with a page citation instead of a guess.

Press **?** anywhere outside a text field for the keyboard shortcut sheet.

**Brain is not this manual.** Brain is your own wiki, and you can edit it. This manual ships with the build and is read-only. See [Wiki and Brain](reference/wiki-and-brain.md) if the two get confused.

## Everything in this manual

### Get started

- [Install and first launch](get-started/install.md) — installers, SmartScreen, updates, the system tray
- [Connect a model](get-started/connect-a-model.md) — LM Studio, Ollama, local serve, cloud APIs, routing
- [Your first chat](get-started/first-chat.md) — workspace picker, Code chat, approving a tool

### Core concepts

- [How Minnow works](concepts/how-minnow-works.md) — the shell, the tool server, what is local, what is not
- [Modes](concepts/modes.md) — what General, Build, Plan and Debug actually change
- [Tools and permissions](concepts/tools-and-permissions.md) — the approval strip, Off/Ask/Full, the workspace boundary
- [Context, memory, and rules](concepts/context-and-memory.md) — the context ring, Brain memory, standing rules

### Chat

- [Working in chat](chat/chatting.md) — attachments, dictation, queueing, steering, stopping, undo, branches
- [Skills and slash commands](chat/skills-and-commands.md) — `/` skills, the Skills Library, `/goal`, `/loop`

### Apps

- [Code](apps/code.md) — editor, terminal, git, dev servers, preview: the surface you work in
- [Apps overview](apps/overview.md) — Code and the surfaces around it, and how each one opens
- [Models](apps/models.md) — downloads, local serving, providers, routing, sampler, usage
- [Issues](apps/issues.md) — list, board, agent triage
- [Brain](apps/brain.md) — your wiki, memories, ingest, and code index
- [Scheduler](apps/scheduler.md) — interval and cron jobs
- [Settings](apps/settings.md) — the full map of every settings section

### Orchestrate

- [Orchestrate boards](orchestrate/boards.md) — turn a plan into a kanban board that agents work through
- [Agents, sub-agents, and packs](orchestrate/agents.md) — work agents, delegation, autopilot, watchdog

### Extend Minnow

- [Integrations](extend/integrations.md) — MCP servers, language servers, browser automation, webhooks, search
- [Voice](extend/voice.md) — dictation and spoken replies
- [Use Minnow from another device](extend/companion.md) — the LAN companion

### Reference

- [Keyboard shortcuts](reference/keyboard-shortcuts.md)
- [Where your data lives](reference/configuration.md) — Minnow home, what to back up, `MINNOW_HOME`
- [Privacy and security](reference/privacy-and-security.md) — what leaves your machine, and what stops it
- [Troubleshooting](reference/troubleshooting.md)
- [Glossary](reference/glossary.md)
- [Wiki and Brain](reference/wiki-and-brain.md)
- [Roadmap](reference/roadmap.md)
