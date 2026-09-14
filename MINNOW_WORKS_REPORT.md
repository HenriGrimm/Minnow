# How Minnow Works: Full Technical Report

This document explains Minnow's architecture, components, and operational model based on the codebase and documentation.

---

## Executive Summary

Minnow is a **local-first AI development assistant** built around three core pillars:

1. **A workspace-first shell** with a workspaces picker, app rail, and menubar
2. **A local tool server** on port 9473 that handles file I/O, git, terminals, indexing, and persistence
3. **A user-supplied model** streaming to any OpenAI-compatible endpoint

Everything else (modes, tools, boards, memory) is arranged on top of these foundations.

---

## Core Architecture

### The Three Pillars

#### 1. Workspace-First Shell

- **Workspaces picker** (`#/workspaces`) - Choose a folder to work in
- **Left app rail** - Navigation to Code, Source Control, Models, Brain, Issues, Scheduler
- **Menubar** - Settings, help, workspace controls
- **Code surface** - Chat beside your project files and editor

The shell is deliberately minimal: no toggles, no marketplace, nothing to enable. What ships is installed and on.

#### 2. Local Tool Server

- **Port:** 9473
- **Location:** Local machine only (binds to loopback by default)
- **Capabilities:**
  - File reading and writing
  - Git operations
  - Terminal spawning
  - Code indexing
  - Chat persistence
  - Model downloads

The browser cannot do these things; the tool server handles everything the browser cannot.

#### 3. Model Abstraction

- **No built-in weights** - Minnow never ships model weights
- **OpenAI-compatible endpoint** - Streams to whatever you point it at
- **Indifferent to location** - Works with local models in your living room or cloud models in a datacenter
- **Configurable routing** - Different models for different roles (chat, research, review, agents)

---

## The Chat Loop

When you press Enter in chat, this happens:

1. **System prompt construction** - Combines:
   - Active mode instructions
   - Your standing rules
   - Work agent's role
   - Memory retrieved from Brain
   - Tool-use guidance for that mode

2. **Model invocation** - Sends:
   - Conversation history
   - Tool definitions allowed by the mode

3. **Model response** - Streams reply. If tools are requested:
   - Minnow checks each against permissions
   - Either runs it, asks you, or refuses

4. **Tool execution** - Results return to the model, which continues

5. **Persistence** - Finished turn written to disk

### Two Key Consequences

- **A model with no tool-calling ability can only talk** - Some models will do this at length and with great confidence. If tools never fire, the model is the likely cause, not the permission.

- **Every tool result costs context** - Reading a huge file is not free; it competes with your conversation for room in the window.

---

## Modes

A mode changes two things at once: the **system prompt** and the **tool list**. It is the most consequential control in the composer.

### Four Composer Modes

| Mode | Behavior | Key Characteristics |
|------|----------|---------------------|
| **General** | Balanced assistant | Broad tools, normal approval settings, only mode that can read Minnow manual |
| **Build** | Development default | Files/git/terminal/code intelligence/sub-agents/browser automation/task checklist |
| **Plan** | Read and analyse | Can run shell commands, write plan documents only to `documentation/plans/`, cannot rewrite code |
| **Debug** | Investigation and triage | Everything Build has, plus local diagnostics for Issues tracker |

### Plan Mode: What Actually Blocks

Plan mode is often misunderstood. Precisely removed:
- `append_file`, `insert_at_line`, `replace_text_in_file`, `move_file`, `copy_file`, `delete_path`
- All git writes
- Settings changes

Plan mode keeps:
- `save_file` and `make_directory` (restricted to `documentation/plans/`)
- Shell execution
- `issue_*` tools (tracker state, not repo edits)

**Plan can look anywhere and run things, but cannot rewrite your code.**

### Modes You Enter (Not on the Strip)

| Mode | Source | Notes |
|------|--------|-------|
| **Orchestrate** | Orchestrate hub | Coordinates a board, reads code, delegates tasks, cannot spawn free-form sub-agents |
| **Onboarding** | First-run setup | Deliberately safe demo: no shell, no writes |

### Modes are a Ceiling, Not a Grant

Tools must pass **two gates**:
1. Mode must allow the tool
2. Your permission must be **Ask** or **Full** (not **Off**)

Turning a tool to Full doesn't make it available in Plan mode. A mode allowing a tool doesn't skip your approval.

**Exception:** MCP and plugin tools bypass the mode matrix and are gated by permission settings only.

### Tool Access Matrix

| Capability | General | Build | Plan | Debug |
|------------|:-------:|:-----:|:----:|:-----:|
| Files read | ✓ | ✓ | ✓ | ✓ |
| Files write | ✓ | ✓ | plans only | ✓ |
| Git read | ✓ | ✓ | ✓ | ✓ |
| Git write | ✓ | ✓ | ✗ | ✓ |
| Shell / run code | ✓ | ✓ | ✓ | ✓ |
| Code intelligence, language servers | ✓ | ✓ | ✓ | ✓ |
| Web search and fetch | ✓ | ✓ | ✓ | ✓ |
| Browser automation | ✓ | ✓ | ✓ | ✓ |
| Brain (read/write) | ✓ | ✓ | ✓ | ✓ |
| Issues | ✓ | ✓ | ✓ | ✓ |
| Sub-agents | ✓ | ✓ | ✓ | ✓ |
| Settings (read/write) | ✓ | ✗ | ✗ | ✗ |
| Diagnostics | ✗ | ✗ | ✗ | ✓ |
| Minnow manual | ✓ | ✗ | ✗ | ✗ |
| Task checklist (`todo_write`) | ✗ | ✓ | ✗ | ✓ |

---

## Apps and Surfaces

### Core Principle

Minnow is **one shell built around Code**. Everything else is a surface that supports work done there. No toggles, no marketplace, nothing to enable.

### The App Rail

| Surface | Purpose | Opens |
|---------|---------|-------|
| **Code** | Chat, files, editor, terminal, preview | Default |
| **Source Control** | Changes, history, branches, worktrees, PRs, CI | Fullscreen |
| **Models** | Downloads, local serving, providers, routing, sampler, voice, usage | Fullscreen |
| **Issues** | Issue list/board, agent triage | Fullscreen |
| **Brain** | Knowledge wiki, memories, ingest, lint, code index | Fullscreen |
| **Scheduler** | Recurring jobs | Side panel |

### Code App

The primary work surface:
- Chat sessions in left rail
- Composer in center
- Project files and editor on right
- Terminal, source control, dev servers, Chromium preview alongside
- File/git tools resolve under workspace root

**Two things live inside Code:**
- Orchestrate boards (from Orchestrate button in sidebar)
- Source Control Center (full git app)

### Shared Infrastructure

All surfaces share:
- One chat engine
- One set of tools
- One session store
- One workspace folder at a time

Opening Brain does not start a different assistant — it gives the same assistant a different layout and workflow, still backed by the same sessions.

**This sharing is the whole design, not a packaging detail.** The assistant that reads your files is the one that files issues, makes branches, writes Brain pages, and runs on your downloaded model — all pointed at the same folder.

---

## Agents

### Agent Hierarchy

The assistant you talk to is **one agent**. It can spawn others:

- **Sub-agents** - For parallel investigation (researcher, explorer) that report back without cluttering your transcript
- **Board members** - For delivery (builders, testers, fixers) each working one task on a kanban board

Each has:
- Role prompt
- Own tool allowlist
- Own context budget

### Orchestrate Boards

The Orchestrate hub coordinates a board:
- Reads code
- Delegates tasks
- Cannot spawn free-form sub-agents
- Cannot write files itself

Delegation on a board goes through the board, so work is visible and recoverable, not hidden inside an unmanaged sub-agent.

---

## Data Storage

Everything lives **locally by default**:

| Data Type | Location |
|-----------|----------|
| Chats and history | SQLite in Minnow home |
| Brain wiki, memories, vectors | Minnow home |
| API keys, tokens, mail passwords | Encrypted with AES-256-GCM in Minnow home |
| Downloaded models | Minnow home |
| Diagnostics and crash logs | Minnow home |

### Traffic Leaves Your Machine Only When You Send It

- Cloud model provider (if configured)
- Web search
- Page fetch
- Hugging Face download
- Webhook (if set up)

There is **no analytics pipeline and no crash reporting service**.

### Network Boundaries

- Server binds to loopback by default
- Other devices cannot reach it until you explicitly enable LAN access and pair a device
- Full details in privacy and security documentation

---

## The Workspace Boundary

File, git, search, and terminal tools resolve **under one folder**, not across your whole disk. In normal use, this is the project you opened from the workspaces picker into Code.

| Surface | Working Folder |
|---------|----------------|
| Code (chat included) | The project you opened |
| Board task chat with isolation on | That task's own git worktree |

An attempt to read outside the boundary fails. This is a feature and the **single most important safety property** in Minnow.

You can lift it: **Settings → General → Filesystem access → full**, but then an agent can touch anything your user account can.

### Legacy Hashes

- `#/desktop` redirects to `#/workspaces`
- Old `#/app/chat` links land on Code chat

---

## Tools and Permissions

Tools are gated by two independent systems:

1. **Mode allowlists** - What the mode permits
2. **User permissions** - Ask, Full, or Off

### Tool Categories

- **File tools** - Read/write operations on workspace files
- **Git tools** - Repository operations
- **Shell tools** - Command execution
- **Code intelligence** - Language servers, symbol search
- **Web tools** - Search and fetch
- **Browser automation** - Tab control, screenshots
- **Brain tools** - Memory and wiki operations
- **Issue tools** - Issue tracking operations
- **Sub-agent tools** - Spawning and delegating
- **Settings tools** - Configuration changes
- **Diagnostics tools** - System diagnostics
- **Minnow manual tools** - Documentation lookup

### MCP and Plugin Tools

These bypass the mode matrix entirely and are gated by permission settings only.

---

## Browser Workflow

Minnow supports browser-only usage:

- **Chat, modes, and providers work** in a plain browser tab without the tool server
- **Files, git, terminal, persistence, and most tools do not work**
- If a tool reports "not implemented" or "server required", that's what happened
- In the packaged app, the server is always running

### Browser Tab Management

- Use `surface: "agent"` by default: first call `browser_reserve_tab`, retain `tab_id`, pass to every later call
- `browser_list` on that surface shows only your owned tabs
- Use `surface: "user"` only deliberately after `browser_list` or `browser_new_tab`
- Release or close the agent tab when finished
- For allowlisted origins, call `browser_navigate` directly (no ask_question)
- For new external origins: `ask_question` (once/persist/deny), then `request_browser_origin_access`

---

## GitHub Integration

When the workspace remote is on GitHub (typical `origin` → `github.com`), use the **GitHub CLI** through `execute_command` for forge operations.

### Use `gh` for

- **Pull requests** - `gh pr list`, `gh pr view`, `gh pr create`, `gh pr merge`, `gh pr diff`, `gh pr checkout`
- **Issues** - `gh issue list`, `gh issue view`, `gh issue create`, comments
- **CI / Actions** - `gh run list`, `gh run view`, `gh pr checks`, `gh run watch`
- **Repo metadata** - `gh repo view`, `gh release list`, compare links via `gh api`

Auth is the user's `gh auth login` session on the machine. Minnow does not store GitHub tokens.

### When `gh` is unavailable

If `gh --version` or the command fails (not installed/not logged in), suggest `gh auth login`. Do not treat scraping github.com as an acceptable substitute.

---

## Key Design Decisions

### 1. Single Assistant, Multiple Surfaces

All surfaces share one chat engine, tools, session store, and workspace folder. This eliminates redundancy and ensures consistency.

### 2. Mode-Based Tool Gating

Modes change both the system prompt and tool list together. This is the primary way to control what an agent can do.

### 3. Local-First by Default

No cloud dependencies, no telemetry, no analytics. Everything runs locally unless you explicitly choose otherwise.

### 4. Workspace Boundary as Safety

The single most important safety property is that file/git/search/terminal tools resolve under one folder. Attempts to read outside fail by default.

### 5. Model Agnosticism

Minnow never ships weights and is indifferent to where the model lives. This makes it work with local models, cloud models, or anything in between.

---

## Related Documentation

- [How Minnow works](documentation/manual/concepts/how-minnow-works.md) - Core architecture
- [Modes](documentation/manual/concepts/modes.md) - Mode behavior and tool access
- [Tools and permissions](documentation/manual/concepts/tools-and-permissions.md) - Tool gating
- [Context, memory, and rules](documentation/manual/concepts/context-and-memory.md) - Knowledge management
- [Apps overview](documentation/manual/apps/overview.md) - Surface descriptions
- [Privacy and security](documentation/manual/reference/privacy-and-security.md) - Data handling

---

## Conclusion

Minnow is a **local-first AI development assistant** built on three pillars: a workspace-first shell, a local tool server, and a user-supplied model. Its design emphasizes:

- **Safety** - Workspace boundaries, local-first, no telemetry
- **Simplicity** - No toggles, no marketplace, what ships is installed
- **Flexibility** - Model-agnostic, mode-based tool gating, configurable permissions
- **Integration** - All surfaces share one assistant, enabling seamless handoffs

The architecture is deliberately minimal and focused on the core developer workflow: choosing a workspace, working in Code, and using the assistant to help with tasks. Everything else supports that work.
