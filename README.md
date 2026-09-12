# Minnow

**A full agentic development workspace. Open source, and completely yours.**

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/HenriGrimm/Minnow?include_prereleases)](https://github.com/HenriGrimm/Minnow/releases)
[![Discord](https://img.shields.io/badge/discord-join-5865F2)](https://discord.gg/U4FPzv9K4X)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2)](https://github.com/sponsors/HenriGrimm)

Editor, agents, git, issues, planning, knowledge, and local model hosting — one app, designed from the ground up to work with each other.

Minnow exists because the tools are good but the seams between them were not.

So: one workspace, one tool set. Plan a feature, let it build in a worktree, watch the tests, review the diff, file what broke, commit, ship — without switching apps or re-explaining your project to anything.

**It runs on whatever you point it at.** A 27B model on your own GPU, a frontier model through an API key, or both at once with different models bound to different jobs. No accounts, no subscriptions, no usage limits, no telemetry.

![Minnow Code workspace](documentation/images/hero.png)

---

## What it replaces

Minnow is aimed squarely at the solo developer and the hobbyist. The tinkerer up at 2am building. That person does not need six subscriptions and an org chart. They need one thing, on their own machine, that does the whole loop.

| Instead of | You get |
|---|---|
| **Cursor, or VS Code plus a chat extension** | **Code** — CodeMirror with language-server intelligence, terminal tabs, inline completion, Ctrl+K quick edits, intent-based coding, a real Chromium preview, and chat beside the repo it edits |
| **Linear, Jira, Etc** | **Issues** — list, board, triage, and `issue_*` tools the agent files to itself | a fully intergrated issue |
| **GitHub Desktop or Tower** | **Source Control Center** — changes, history, branches, stashes, worktrees, pull requests, issues, and CI |
| **LM Studio, Ollama** | **Models** — Built in Llama.cpp & MLX LM. Multi GPU support, Model Router, and Hugging Face downloads |
| **Notion or Obsidian for project notes** | **Brain** — a markdown wiki with semantic recall and a code indexing | 
| **A drawer of shell scripts and cron** | **Scheduler**, plus `/loop` and `/goal` — Schedule agents to run tasks, check issues and more|
| **Multiple chats across a large project** | **Orchestrator boards** — a plan run as waves of Builder and Tester agents in isolated worktrees |

They share one chat engine, one tool set, one session store, and one workspace root. What the agent learns in one is available in all of them.

---

## Quick start

Download a packaged build from **[Releases](https://github.com/HenriGrimm/Minnow/releases)**.

| Platform | What you download |
|----------|-------------------|
| Windows | NSIS installer (`.exe`) |
| macOS | `.dmg` (or `.zip` into Applications) |
| Linux | AppImage — `chmod +x` and run it |

**[Install and first launch](documentation/manual/get-started/install.md)**. Then [point it at a model](documentation/manual/get-started/connect-a-model.md) and [send your first chat](documentation/manual/get-started/first-chat.md).

### Build from source

Clone and `npm start`.

```bash
git clone https://github.com/HenriGrimm/Minnow.git
cd Minnow
npm install && npm start
```

Full steps: [Setup from source](documentation/contributor/setup-from-source.md).

---

## Local models, cloud models, or both

Minnow ships no weights and has no built-in provider. It streams to any OpenAI, Anthropic or LMStudio API endpoint.

- **Local** — Minnow can host models itself, connect to LMStudio, Ollama or any other compatible endpoint.
- **Cloud** — any compatible API with your own key.
- **Both** — Model routing allows you to set models to specific roles. Model pools let you automatically route to an availible provider.

![Models app](documentation/images/app-models.png)

---

## The build loop

**Code is the workspace.** Everything else is a surface that serves it.

```
idea  →  Plan mode          →  a spec in documentation/plans/
      →  Orchestrator board →  Builder and Tester agents in isolated worktrees
      →  Source Control     →  review the diff, open the PR, watch CI
      →  Issues             →  what broke, filed by the agent that found it
      →  Brain              →  what you learned, still there next month
```

You can also just open a repo and start typing.

### Code

File tree, We use CodeMirror for our editor combinded with our language-server intelligence and inline completion, terminal tabs, source control, dev servers, and a full user and agent browser. **Intent mode** turns a line of plain English into code you accept with Tab. Chat sits beside the project rather than in another window, driving the same files, git, and terminals you are. You can also never look at code and just chat if you so desire. 

The dev-server screen registers the servers a project needs, and the model drives the same controls.

**Code map** indexes symbols and call relationships across the repo, for you and for the agent.

![Minnow Code app](documentation/images/app-code.png)

### Source Control Center

A full Git and GH interface. Designed from the ground up to work with your agents. 

Push, PRs, Issues, and CI run through your own `gh` CLI. Minnow stores no GitHub token: if `gh` isn't installed or authed. Additional git providers are on the road map.

![Source Control Center](documentation/images/app-source-control.png)

### Orchestrator boards

Turn a plan into waves of tasks, hand them to Builder and Tester agents in isolated git worktrees, and merge at the end. Drive it task by task, or let it run and discover what you actually specified.

![Orchestrator board](documentation/images/app-orchestrator.png)

### Brain

A markdown wiki in your Minnow home: graph view, page editing, an append-only log, AI proposals awaiting review, memories, ingest, lint, and a code-symbol index of your repositories. The assistant reads and writes it with tools, which is how a project's context survives the chat that produced it.

![Brain knowledge graph](documentation/images/app-brain.png)

Full tour: **[Apps guide](documentation/manual/apps/overview.md)**.

---

## Everything else in the box

| | |
|---|---|
| **Chat beside the repo** | Sessions in the Code rail: modes, attachments, voice, notifications. Same files, git, and terminals you're using. |
| **Planning** | Plan mode takes an idea to a buildable spec in `documentation/plans/` without touching your code. |
| **Intent-based coding** | Type what a line should do in plain English; Tab turns it into code. |
| **Autocomplete** | Inline ghost text, with language-server context behind it. |
| **Quick Edit** | Ctrl+K turns a description into a diff on your selection. |
| **Sub-agents** | Hand research, review, or a long grind to an agent with its own prompt, model, and context budget. |
| **Loops and goals** | `/loop` re-runs a prompt on a schedule; `/goal` keeps working until an evaluator agent says the condition is met. |
| **Voice** | Dictate into the composer and get spoken replies, on local speech models. |
| **Companion access** | Reach your workspace from another device on your LAN, once you opt in. |

Behind it, **105 built-in tools**: files, git, LSP, terminal, web, browser automation, sub-agents. Each one can be Full, Ask, or Off, on the principle that a program able to run shell commands should occasionally check in.

Three processes make it work: the Electron shell, the SPA it loads, and a Node server that runs the tools and owns everything persisted under `~/.minnow`. Details in [Architecture](documentation/contributor/architecture.md).

---

## Make it yours

The point of open source is not that you *could* read the source. It's that the seams are open where you actually want to reach in.

- **Skills**: drop a `SKILL.md` into `~/.minnow/skills/` and call it with `/` in the composer. Nineteen ship built in; install more from the Skills Library, or write your own.
- **Tools**: add local tools under `~/.minnow/tools/` with no MCP server required ([tool authoring](documentation/plugins/tool-authoring.md)), or connect any MCP server you like.
- **Agents**: define sub-agents and work agents with their own prompts, models, samplers, and context budgets.
- **Prompts and modes**: every system prompt in the app is a markdown file in the repo. Edit them.
- **Themes**: sixteen built in, which is fifteen more than strictly necessary; the whole UI is `--mn-*` tokens in one file.

![Minnow themes](documentation/images/themes.png)

- **The source**: it's AGPL. Fork it, strip it, rebuild it, ship it; derivatives stay AGPL.

---

## Yours, on your disk

- Chats, config, Brain, models, and secrets live under `~/.minnow` on your disk.
- Provider keys and passwords are encrypted at rest (AES-256-GCM).
- Network access is loopback-only until you opt in.
- File and git tools resolve under the folder you opened, not your whole drive.
- Web search uses the provider you pick. There is no telemetry and no phone-home. Nobody here knows you installed it.

No feature is ever withheld to make a paid tier. The reference point is Blender, not a SaaS product: one complete suite covering the whole loop, given away under copyleft, funded by the people who use it, and built to be taken apart by them.

---

## Status

One maintainer and a small community. It is a work in progress, meaning parts of it are unfinished and you will find the edges before I do. Bug reports are genuinely useful. If something is broken, confusing, or missing, say so.

- 💬 [Discord](https://discord.gg/U4FPzv9K4X)
- 🐛 [Issues](https://github.com/HenriGrimm/Minnow/issues)
- ❤️ [Sponsor](https://github.com/sponsors/HenriGrimm): development is funded by the people who use it.

Pull requests, docs fixes, skills, and themes are all welcome. Working in the codebase? Start with [AGENTS.md](AGENTS.md) and [documentation/context.md](documentation/context.md).

---

## Documentation

| Doc | What's in it |
|-----|--------------|
| [Install](documentation/manual/get-started/install.md) | Packaged desktop app from Releases |
| [Connect a model](documentation/manual/get-started/connect-a-model.md) | Local serving, LM Studio, Ollama, cloud keys, routing |
| [Setup from source](documentation/contributor/setup-from-source.md) | Clone and `npm start` for development |
| [Apps](documentation/manual/apps/overview.md) | Code and the surfaces around it |
| [Skills and commands](documentation/manual/chat/skills-and-commands.md) | `/` skills, the Skills Library, `/goal`, `/loop` |
| [Commands](documentation/contributor/commands.md) | Every script, flag, and environment variable |
| [Configuration](documentation/manual/reference/configuration.md) | `~/.minnow`, providers, secrets |
| [Architecture](documentation/contributor/architecture.md) | How the three processes fit together |
| [Troubleshooting](documentation/manual/reference/troubleshooting.md) | When something won't start |

Full index: [documentation/](documentation/README.md).

---

**License:** [GNU AGPL-3.0-or-later](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](documentation/THIRD_PARTY_NOTICES.md).
