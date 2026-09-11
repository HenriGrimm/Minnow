# Minnow product

## Register

product

## Users

**Developers. Developers. Developers.** People who write and ship software, working in a repo, using models they supply.

- **Solo builders and indie devs** shipping software with agents: plans, boards, code, and git in one workspace. **This is the primary audience.**
- **Power users** with serious local-AI stacks: multi-model routing, sub-agents, encrypted credentials, and privacy-sensitive workflows.

Local model hosting is a **capability of the workspace**, not a separate audience. The Models app exists so the agents have something to run on and so you can pick what runs where — not as a place to sit and chat with a model on your hardware. Design for the developer with a repo open; do not add paths that only serve model tinkering.

**Growth direction:** depth in the build loop. Pick a repo root, work in Code, grow into plans, boards, and Brain from there. Minnow Shell is the packaged Electron runtime, not a separate chat home. Primary references: the Code workspace (editor, terminal, git, chat rail), workspace picker (`#/workspaces`), and multi-agent delivery (Orchestrator boards), not a standalone chat box or cloud dashboard.

**Scope discipline:** the shipped surface is deliberately narrow: Code, Source Control, Models, Brain, Issues, Scheduler, Settings (released apps per `app-registry.ts`). Anything that is not finished stays behind a release gate rather than landing half-built on the app rail. Breadth is earned one surface at a time; depth in the build loop comes first.

**Claims discipline:** documentation describes what ships today. No competitor comparisons, no "replaces X", no capability written in the future tense outside `ROADMAP.md`. If a reader can't do it in the build they installed, it doesn't belong in the manual.

## Product purpose

**Minnow** is a free and open source, local-first development workspace: editor, terminal, git, issues, planning, agents, and local model hosting in one app. It runs on any model or provider you point it at (LM Studio, Ollama, llama.cpp, or any OpenAI-compatible API). Everything stays on your machine: keys, chats, files, Brain wiki, and encrypted secrets under `~/.minnow`.

**Mission:** put a complete development workspace in the hands of everyone who builds, as free and open source software.

The reference point is **Blender**, not a SaaS product: one complete suite covering the whole loop, given away under a copyleft license, funded by the people who use it, and built to be taken apart by them. Minnow is a tool anyone can pick up and make anything with. Because it is AGPL, nobody can take it away or put it behind a gate later.

### Shape of the product

**Code is the workspace.** Everything else is a surface that serves it. When a decision is ambiguous, the question is what makes the build loop better, not what makes the rail more complete.

| Surface | Role |
|----------|----------------|
| **Workspace picker** | Choose the folder root for tools, git, and Brain indexing before you build. |
| **Code** | The product. File tree, CodeMirror + LSP, terminal, git, dev servers, preview, chat rail beside the repo, inline completion and Quick Edit. Where sessions start and end. |
| **Source Control Center** | Dedicated Source Control app on the navigation rail: changes, history, branches, stashes, worktrees, plus pull requests and CI through the user's own `gh` CLI. No stored tokens. |
| **Orchestrator boards** | Plan → kanban → Builder/Tester work agents → worktree isolation → merge and ship. Manual through AFK autonomy. |
| **Issues** | Capture, triage, list and board, wired to `issue_*` tools and Debug mode. The agent files and tracks its own work. Single-player. |
| **Brain** | Local knowledge engine: markdown wiki, semantic recall, code index (`repo_map`, symbols), memory adapter, archive policy for long threads. |
| **Models** | What the agents run on: hardware-fit recommendations, downloads, local serve, per-role provider routing, sampler and thinking defaults, usage and cost. |
| **Scheduler** | Recurring agent jobs on an interval or cron, with run history. |

### Platform capabilities

- **Four composer modes**: General, Build, Plan, Debug (Issues workflows), plus Orchestrate from the Code sidebar. Each has tuned prompts and tool policy.
- **Agent layer**: 106 built-in tools, sub-agents, work agents, skills (`/commands`), tool permissions (Full / Ask / Off), MCP and local plugins.
- **Workspace tools**: memory synthesis, voice I/O, browser CDP automation (Electron), webhooks, semantic embeddings.

**Success looks like:** a developer opens Minnow, opens a repo, and stays there — planning, building, reviewing, committing and tracking in one app, on models they control, without cloud lock-in or subscription gates.

## Brand personality

**Warm, capable, matter-of-fact**: a tool built by and for people who make things, not enterprise cosplay.

- Copy is plain and unhurried. State what a thing does and stop. No hype ("autonomous AGI"), no growth-marketing cadence, no exclamation marks.
- Write like project documentation, not like a landing page: short declaratives, real nouns, second person. Assume the reader is capable and busy.
- Open source is the premise, not a badge. Say "free and open source" once, plainly, and let the license and the extension points do the arguing.
- Invite participation. The reader is a potential contributor and a potential builder-of-their-own. Mention the seams they can open (skills, tools, prompts, themes, the fork) rather than only the features they can consume.
- Technical credibility through capability (tools, boards, LSP), not neon chrome or dashboard theater.
- Privacy and local control are assumed defaults, stated plainly when relevant. Not fear-marketed.

## Anti-references

**Visual**

- Neon cyber HUD (scanlines, glowing dots, Rajdhani wordmarks)
- Generic ChatGPT clone (cream cards, purple gradients)
- Hero-metric dashboards (giant KPI cards with colored top stripes)
- Glassmorphism and gradient text
- Decorative motion that does not convey state

**Positioning and voice**

- Cloud-only AI tools and subscription gatekeeping as the default mental model
- Hype-y autonomous-agent marketing language
- Enterprise bloatware patterns (empty dashboards, vanity metrics, modal-first flows)
- Surface sprawl: an app rail full of demo-grade apps, or a feature list padded with things that half work

## Design principles

1. **One workspace for the whole build loop.** Code, chat, plans, boards, git and knowledge share one shell, not a bundle of disconnected apps.
   **Corollary:** fewer surfaces, each finished. A gated-off app beats a shipped half-app.
2. **Free forever, local-first, open source.** AGPL-3.0-or-later; state on disk; encrypted secrets; LAN access opt-in. Strategic constraint, not a footnote. No feature is ever withheld to create a paid tier. Funding comes from the people who use it, the way Blender's does.
3. **Open at the seams.** Anything the app can do, a user can extend or replace without permission: skills as `SKILL.md` files, tools as local plugins, prompts as editable markdown in the repo, themes as tokens, and the whole thing as a fork. A closed extension point is a bug.
4. **Agent-native.** Tools, sub-agents, skills, and boards are core product, not plugins bolted onto a chat box.
5. **Plain voice.** Documentation register, not marketing register. Approachable copy and real community presence; capable internals without intimidating chrome.
6. **Calm instrumentation.** Metrics and status read as bench gauges (TPS, TTFT, tokens), not marketing KPIs. Conversation stays readable where chat is the surface.
7. **Earned familiarity.** Consistent controls and navigation across apps; surprise reserved for moments, not every screen.

## Accessibility and inclusion

- **Target:** WCAG 2.1 AA for core text and control contrast across all 16 palette themes (`test/theme-contrast.test.mts`).
- **Motion:** Respect `prefers-reduced-motion`; disable decorative pulses, panel reveals, and spinner animations when reduced motion is requested.
- **Touch and pointer:** 44px minimum touch targets on session actions; hover-heavy styles behind `(hover: hover) and (pointer: fine)`.
- **Keyboard and focus:** Visible `:focus-visible` rings; composer and editor caret colors tuned for theme transitions.
- **Screen readers:** `aria-label` on icon-only controls; `role="status"` and `aria-live="polite"` on streaming and tool-call feedback; native `<select>` fallback for model picker.
- **Color:** Semantic success/warning/danger are never the only signal for state (tool calls pair color with text labels).
