# How Minnow Works: A Comprehensive Technical Report

## Executive Summary

**Minnow** is a free, open-source, full agentic development workspace — one shell built around **Code**, with supporting surfaces for source control, models, issues, brain/wiki, scheduler, and settings. It's designed for local-first AI-assisted development, with the assistant reading and writing your files directly through a unified tool set, all pointing at the same workspace folder.

The core architecture consists of three processes:
1. **Electron desktop shell** (SPA frontend)
2. **Node.js tool server** (local-first tool execution)
3. **Agent layer** (orchestration, modes, work agents)

---

## 1. Core Architecture

### 1.1 Three-Process Model

Minnow runs three distinct processes that communicate via IPC:

| Process | Role | Tech Stack |
|---------|------|------------|
| **Electron Shell** | SPA frontend, preview rendering, user interface | Vite + TypeScript + Electron |
| **Tool Server** | Local tool execution, file operations, git, LSP | Node.js + TypeScript |
| **Agent Layer** | Orchestration, mode management, work agents | Node.js + TypeScript |

All three share:
- One chat engine
- One tool set
- One session store
- One workspace folder at a time

### 1.2 Single-Shell Design

Minnow is **one shell built around Code**. Everything else (Source Control, Models, Brain, Issues, Scheduler) is a surface that supports the work you do in Code. There are no toggles to enable/disable features — what ships is installed and on.

> "The assistant that reads your files is the one that files the issue, makes the branch, writes the Brain page, and runs on the model you downloaded — all pointed at the same folder. Nothing has to be told about your project twice."

---

## 2. Application Structure

### 2.1 Apps (Launcher Tiles)

Minnow has 11 distinct apps, each accessible from the launcher rail:

| App | Purpose |
|-----|---------|
| **Code** | Primary workspace: chat, composer, files, editor, terminal, preview |
| **Source Control** | Full git app: changes, history, branches, PRs, CI |
| **Models** | Model downloads, local serving, providers, routing, voice |
| **Brain** | Personal wiki: pages, memories, code index, graph view |
| **Issues** | Issue list/board with agent triage |
| **Scheduler** | Recurring jobs (interval/cron) |
| **Research** | Web research with citations |
| **Experts** | Agent packs and custom agents |
| **Bench** | Benchmarking |
| **Compare** | Model comparison |
| **Settings** | Configuration (General, Apps, Appearance, Models, Agents, Integrations, Advanced) |

### 2.2 Code App Structure

The Code app is the primary workspace and contains:

- **Chat rail** (left): Sessions for different tasks
- **Composer** (center): Natural language interface
- **Project files & editor** (right)
- **Terminal**
- **Source control panel**
- **Dev servers**
- **Chromium preview** (embedded WebContentsView)

**Sub-routes** (view-bar destinations):
- `overview` — Workspace overview
- `chat` — Chat interface
- `dev-server` — Development servers
- `orchestrate` — Orchestrate boards
- `boards` — Task boards
- `map` — Project map

---

## 3. Chat & Agent System

### 3.1 Modes

Minnow uses **modes** to control tool access and behavior. There are 9 modes:

| Mode | Purpose | Tool Access |
|------|---------|-------------|
| **General** | Everyday Q&A, brainstorming | Broad access with approval before each run |
| **Build** | Default development mode | Broad tool access (no approval) |
| **Plan** | Analyze and plan | Limited file writes (plan doc only) + shell + read tools |
| **Super Plan** | Extended planning with sub-agents | Write plans + reference artifacts only (disabled for release) |
| **Orchestrate** | Multi-agent board interface | ParsePlan intake, board management |
| **Debug** | Investigate issues, root causes | File and triage via Issues + issue_* tools |
| **Onboarding** | First-run tour guide | Demos tools live |
| **Desktop** | Alias for General | Collapses to General |
| **Email** | Alias for General | Collapses to General |

**Mode Tool Policies:**
- `default`: Default action for tools not explicitly listed
- `tools`: Per-tool overrides (e.g., `execute_command: deny`)

Modes are persisted and can be switched per session.

### 3.2 Agents

Minnow has several agent types:

#### Built-in Agents
- **Builder**: Implements single, well-defined tasks
- **Orchestrator**: Manages multi-agent boards
- **Researcher**: Web research with citations
- **Explorer**: Read-only codebase mapping
- **Shell**: Isolated shell/script execution

#### Work Agents
Work agents are defined in `server/work-agents/` and manage:
- `paths.js`: Path resolution
- `registry.js`: Agent registration
- `routes.js`: Routing logic

#### Sub-agents
Sub-agents run in isolation for specific tasks:
- `generalPurpose`: Self-contained implementation chunks
- `researcher`: Multi-query research (repo + web)
- `explore`: Read-only codebase exploration
- `shell`: Isolated shell execution

### 3.3 Tool Execution Flow

1. **User** sends message to Composer
2. **Mode** determines tool policy and available tools
3. **Agent** (e.g., Builder) plans actions
4. **Tool Server** executes tools with approval gates (if needed)
5. **Results** streamed back to Composer
6. **Agent** continues or completes task

**Tool Categories:**
- `web`: Web navigation, screenshots
- `utility`: General utilities
- `files`: File operations
- `git`: Git operations
- `code`: Code analysis, LSP
- `agents`: Agent management
- `browser`: Browser automation
- `lsp`: Language server protocol

---

## 4. Orchestration System

### 4.1 Orchestrate Boards

Orchestrate boards are multi-agent task management systems. They:

1. **Parse plans** from natural language
2. **Create tasks** with dependencies
3. **Assign work agents** to tasks
4. **Track attempts**, retries, and outcomes
5. **Manage state** with snapshots

### 4.2 Board Engine Core

The orchestrator core (`server/orchestrator/core/`) manages:

| Module | Purpose |
|--------|---------|
| `derive.js` | Board state derivation (ready tasks, attempts) |
| `events.js` | Event schemas and validation |
| `evidence.js` | Abandonment evidence bundling |
| `policy.js` | Decision logic for task assignment |
| `plan.js` | Task planning, dependency resolution |
| `rewind.js` | Cascade rewind on failures |
| `snapshot.js` | State persistence and recovery |
| `parse-plan.js` | Natural language to task conversion |
| `overflow-report.js` | Handling large file sets |

### 4.3 Board State

Boards maintain:
- **Journal**: Append-only event log
- **Snapshot**: Periodic state checkpoints
- **Transcripts**: Message history
- **Attempts**: Retry tracking with budgets

---

## 5. Tool System

### 5.1 Tool Catalog

Tools are defined in `src/tools/definitions.ts` and implemented in `server/tools/builtin-catalog.js`. Each tool has:

- `id`: Unique identifier
- `label`: Display name
- `description`: Tool purpose
- `category`: Tool group
- `serverRequired`: Whether tool server is needed
- `previewRequired`: Requires Electron desktop shell
- `appId`: App-specific visibility
- `definition`: OpenAI-compatible function schema

### 5.2 Tool Approval

Tools can have approval gates:
- **Automatic**: No approval needed (Build mode)
- **Ask**: User approval before execution (General mode)
- **Deny**: Tool blocked entirely

### 5.3 Key Tools

- `ask_question`: Present structured choices to user
- `execute_command`: Run shell commands
- `read_file`: Read file contents
- `save_file`: Write file contents
- `grep`: Search file contents
- `browser_*`: Browser automation
- `issue_*`: Issue management
- `save_memory`: Write to Brain wiki

---

## 6. Data & Storage

### 6.1 Local-First Design

Minnow is **local-first**:
- All data stored locally
- No cloud sync required
- Works offline
- User owns their data

### 6.2 Storage Locations

| Data | Location |
|------|----------|
| **Workspaces** | User-specified folders |
| **Brain wiki** | `~/.minnow/brain/` |
| **Memories** | `~/.minnow/memory/` |
| **Models** | `~/.minnow/models/` |
| **Tool plugins** | `~/.minnow/tools/` |
| **Agent packs** | `server/agent-packs/` |

### 6.3 Session Store

Sessions are stored with:
- Chat history
- Tool execution logs
- Board state
- Mode preferences

---

## 7. Browser Integration

### 7.1 Agent Browser

Minnow includes an agent-controlled browser with:

- **Tab management**: Reserve, navigate, screenshot
- **Surface control**: Agent (`agent`) vs User (`user`) surfaces
- **Origin allowlist**: Secure navigation with approval
- **Preview integration**: Embedded in Code app

### 7.2 Browser Workflow

1. `browser_reserve_tab`: Create agent-owned tab
2. `browser_navigate`: Navigate to URL (with approval for new origins)
3. `browser_screenshot`: Capture tab content
4. `browser_list`: List owned tabs
5. `browser_release_tab`: Cleanup when done

---

## 8. Build & Development

### 8.1 Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Vite + TypeScript + Electron |
| **Backend** | Node.js + TypeScript |
| **Build** | Vite bundle + Electron packaging |
| **Testing** | Vitest + Playwright |

### 8.2 Key Scripts

- `npm start`: Start dev server
- `npm run build`: Build for production
- `npm run test`: Run tests
- `npm run electron`: Start Electron app

### 8.3 Worktree Model

Development uses git worktrees:
- **Worktree**: Isolated development branch
- **Integration**: Upstream work integrated
- **Ports**: Unique ports per worktree via `process.env.PORT`

---

## 9. Security & Permissions

### 9.1 Permission Model

- **Tool permissions**: Controlled by mode policy
- **File access**: Workspace-scoped
- **Browser access**: Origin allowlist required
- **Shell commands**: Approval gates (mode-dependent)

### 9.2 Security Practices

- No secrets in code
- No destructive commands without approval
- Worktree isolation prevents accidental changes
- Local-first design minimizes network exposure

---

## 10. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Switch apps |
| `Ctrl+K` / `Cmd+K` | Settings search |
| `?` (menubar) | Open manual |
| `Ctrl+Shift+P` | Command palette |

---

## 11. Roadmap & Future

### 11.1 Active Development

- **Phase 0**: Plan mode overhaul (sub-item of Plan segment)
- **Sub-agent delegation**: Multi-query research, isolated execution
- **Browser workflow**: Surface control, origin allowlist
- **Orchestration**: Multi-agent boards, task management

### 11.2 Design Principles

- **Local-first**: User owns data, works offline
- **One shell**: No feature toggles, everything on by default
- **Unified assistant**: Same assistant across all surfaces
- **Tool-centric**: Actions through typed tools, not magic

---

## 12. Files & Conventions

### 12.1 Documentation Structure

```
documentation/
├── manual/          # User manual (what ships)
├── contributor/     # Contributor docs (setup, architecture)
├── maintainer/      # Maintainer docs (releasing, wiki)
├── context.md       # Complete technical reference
└── ROADMAP.md       # Active direction
```

### 12.2 Source Structure

```
src/
├── tools/           # Tool definitions and implementations
├── chat/            # Chat system, modes, agents
├── os/              # OS types, app management
├── state/           # State management
└── ...

server/
├── tools/           # Tool server, builtin tools
├── orchestrator/    # Board orchestration
├── work-agents/     # Work agent definitions
├── agents/          # Agent types
└── ...
```

---

## 13. Key Design Decisions

### 13.1 Single Assistant, Multiple Surfaces

**Decision**: One assistant across all apps
**Rationale**: Eliminates context duplication, maintains consistent knowledge

### 13.2 Local-First Architecture

**Decision**: All data stored locally, no cloud sync
**Rationale**: Privacy, offline capability, user ownership

### 13.3 Mode-Based Tool Access

**Decision**: Modes control tool permissions
**Rationale**: Safety vs. automation trade-off, user control

### 13.4 Worktree Development Model

**Decision**: Git worktrees for development
**Rationale**: Isolation, parallel worktrees, clean integration

---

## 14. Conclusion

Minnow is a **local-first, agentic development workspace** that unifies chat, code, and tools into a single shell. Its architecture prioritizes:

1. **User ownership**: All data local, no cloud sync
2. **Unified assistant**: One assistant across all surfaces
3. **Tool-centric design**: Actions through typed, approved tools
4. **Local execution**: Everything runs locally, works offline
5. **Safety first**: Approval gates, mode policies, worktree isolation

The result is a development environment where the assistant can read your files, run commands, manage git, and write code — all while you maintain control through mode settings and approval gates.

---

*Generated from Minnow repository analysis. For complete technical reference, see `documentation/context.md`.*
