# One agent, one permission level

**Status:** implemented on branch `unified-agent-permissions` (2026-11-08), not yet merged. Deferred from this pass: the §7.1 catalog merges (tools such as `get_datetime`, `calculate` and `get_system_info` are deferred behind `search_tools` rather than removed), the §3.6 Auto reviewer, and wave 0 baseline evals.
**Register:** product
**Date:** 2026-11-08

## Goal

Replace Minnow's modes, work-agent types, sub-agent types and per-tool permissions with:

1. **One agent.** Every chat, sub-agent and board member runs the same agent with the same tools. There are no composer modes.
2. **One permission level** for the whole system: **Manual**, **Auto**, or **Full access**. It governs every action the same way, including built-in tools, shell, files, git, URLs, browser, MCP, plugins and sub-agents. Tools no longer carry their own Ask/Full/Off setting.
3. **Slash commands for intent.** `/ask`, `/plan` and `/debug` are skills. `/ask` and `/plan` limit their turn to reading (`/plan` can also write plan docs).
4. **A much smaller prompt and tool surface.** The agent gets the tools it needs up front, plus a one-line index of everything else that it can load on demand.
5. **A redesigned approval card, permission menu and `/` menu.**

## 1. What exists today

### Modes

- `ModeId` has 9 values. Six are live: General, Build, Plan, Debug, Orchestrate and Onboarding. `desktop`/`email` remap to General and `super-plan` remaps to Plan (`src/chat/modes/types.ts`).
- Each mode has a tool-group allowlist (`MODE_ALLOWED_GROUPS` in `src/chat/modes/tool-groups.ts`) plus deny and allow overrides. `filterToolsByMode` strips the tools a mode doesn't allow before sending.
- Each mode also has a full and a lite prompt (`src/chat/prompts/modes/*.md`). `plan.full.md` alone is about 15k characters.
- Mode handoff adds tools (`set_chat_mode`, `create_chat_with_mode`, `propose_mode_switch`) and a prompt fragment (`mode-handoff.md`).
- `modeId` is referenced in about **164** non-test source files, including persisted sessions, the scheduler store, managed chats, the server chat policy and headless runs.

### Agent types

- There are **7 work agents** (general, planner, builder, tester, reviewer, researcher, ui-designer). Each has its own full and lite prompts and a `defaultForModes`. When the active work agent is the mode's default, the composer suppresses the mode part of the prompt.
- **Sub-agent types** live in `src/agents/defaults/sub-agents.json` (`generalPurpose`, `explore`, …). Each type has its own `allowedTools`/`deniedTools`, model, sampler, context policy and prompt path. `spawn_sub_agent` requires a `type`.
- **Board roles** (build, test, fix) have their own headless tool lists (`server/runner/tool-set.js`, `headlessToolIdsForRole`).
- `workAgentId` appears in about 51 files and `subAgentType` in about 21.

### Permissions: eight overlapping mechanisms

| Mechanism | Where | Behavior |
|---|---|---|
| Per-tool `off`/`ask`/`full` | `tools.json` → `permissions.default`, `src/tools/config.ts` | Source of truth for built-in tools; "Always allow" writes `full` for that tool |
| Mode tool filtering | `tool-groups.ts`, `tool-policy.ts` | Hides tools from the model entirely |
| Plan write guard | `plan-write-guard.ts` (client and server) | Limits writes to `documentation/plans/**.md` |
| Filesystem access | `tool-security-meta` `workspace`/`full` | Outside-workspace paths are **blocked with an error**, not asked |
| Browser origin allowlist | `browser-navigation-gate.ts`, `browser-meta` | Its own once/persist/deny flow, run through `ask_question` |
| Shell sandbox escalation | `shell-sandbox-client.ts` | Separate require/prefer/off logic |
| Companion device | `COMPANION_MUTATING_TOOLS` in `permission-gate.ts` | Phones always prompt for mutations |
| Server chat policy | `server/chats/policy.js` | `toolPermissions` + `fileWriteScope` + `shellSandboxMode`, intersected for managed chats and delegation |

There are also special cases: goal loops auto-approve, headless runs need `--no-approval` plus an env var, and **MCP tools skip approval entirely** (`permission-gate.ts:121` returns early for `mcp__*`).

### Prompt and tool weight

- A Build turn composes base + mode + builder work agent + tool-usage + fragments. That is about **40k characters (~10k tokens)** before memory, the code map, context docs or tool schemas.
- The catalog has **127 built-in tools**. `lazyTools` is on by default. The lazy core (`server/runner/lazy-tools.js` `CORE_TOOL_NAMES`) sends about 32 schemas up front, including all 10 `issue_*` tools and 5 browser tools.
- `search_tools` loads schemas for the *next* request. The model is never told which tool families exist, and the lazy-tools file comments that this is why issue tools had to stay in the core set.

## 2. What the reference tools do

| | Codex | opencode (v2) | T3 Code | Claude Code |
|---|---|---|---|---|
| Agent "modes" | One agent; Plan is a *collaboration mode* (prompt template toggled by `/plan`) | One primary agent, **Build**; `general`/`explore` are subagents | Wraps provider harnesses; plan is the provider's | One agent; plan mode toggled by Shift+Tab |
| Permission levels | Presets: Read only / Default / Full access; desktop: Ask / **Approve for me** / Full access | Ordered `allow/ask/deny` rules on `(action, resource)` | Supervised / Auto-accept edits / Auto / Full access | Manual / Accept edits / Auto / Plan / Bypass |
| "Auto" decision | **Guardian**: reviewer model with a written risk policy (exfiltration, credential probing, security weakening, destructive actions) | n/a | Delegates to provider | Classifier |
| Prompt size | Codex model prompt ~7.5k chars | Base prompt **~750 chars**; per-model add-ons of 300–8k | Adds only a `<runtime_info>` line and PR-linking rules | Medium; most guidance lives in tool descriptions |
| Subagents | `spawn_agent` gets the **same tools**; the prompt tells the parent to say whether children may spawn | `general` subagent (no questions, no spawning) and `explore` (read, search, shell) | Provider-native | Same agent; type is optional |
| Permission prompt text | One short template per policy (`approval_policy/never.md` is 120 chars) | n/a | n/a | Short |

Takeaways:

- The industry has converged on **one agent plus a global level**, with plan as a lightweight overlay rather than a separate tool universe.
- **Auto** works by classifying each action's risk, not by listing tools. Codex's guardian policy is a good template for the risk categories.
- Strong models need very little system prompt. Guidance about a tool belongs in that tool's description, and permission guidance is a single sentence per level.
- **Minnow-specific caveat:** many users run 7–30B local models through LM Studio. The minimal-prompt finding comes from frontier models. We keep a small, opt-in "local model guidance" appendix and gate the prompt cut on evals (§8).

## 3. Permission system

### 3.1 Levels

| Level | Icon | Menu copy | Behavior |
|---|---|---|---|
| **Manual** | hand (`hand`) | "Ask before edits, commands, and anything outside this project" | Reads and searches inside the workspace run freely. Everything else asks. |
| **Auto** | sparkle-shield (`shield-sparkle`) | "Minnow approves routine work and asks before risky actions" | Low-risk actions run. Elevated or high-risk actions ask. |
| **Full access** | shield-alert (`shield-alert`), warning color | "No prompts. Unrestricted files, commands, and internet" | Nothing asks. Shown in the warning token everywhere, as Codex does. |

- **Scope:** there is **one system-wide level**. The composer pill and **Settings → Permissions** are two controls for the same value, so changing it in the composer changes the default for every chat. Chats have no per-chat override.
- Sub-agents, board members, `/loop`, `/goal` and follow-up chats **inherit** their launcher's level at launch. They can never exceed it; the existing `intersectChatPolicies` rule becomes `min(level)`.
- Scheduler and headless jobs store their own level. Headless "ask" resolves to **deny with a message**. `--no-approval` + env opt-in maps to Full access.
- **Shortcut:** Shift+Tab cycles Manual → Auto → Full while the composer is focused. Because the level is global, cycling *into* Full access asks for confirmation the first time only.

### 3.2 One classifier for every action

Add an isomorphic module at `server/permissions/classify.js`. It is plain JS, imported by both the renderer gate and the server dispatcher so the two can't drift. It turns any tool call into an **action**:

```ts
type ActionKind = 'read' | 'edit' | 'shell' | 'git' | 'network' | 'browser'
                | 'integration' /* MCP + plugin */ | 'settings' | 'agent' | 'interact';
interface ClassifiedAction {
  kind: ActionKind;
  resources: string[];            // paths, command, origin, mcp server, setting key
  risk: 'low' | 'elevated' | 'high';
  reasons: RiskReason[];          // 'outside-workspace' | 'destructive' | 'secrets' | 'egress' | 'unknown-effect' | ...
  summary: string;                // "Run `npm install` in minnow/"
}
```

Each tool declares its classification in **one place**, the catalog entry (`server/tools/builtin-catalog.js`), for example `effect: 'edit'` with `paths: ['path']`. This replaces `COMPANION_MUTATING_TOOLS`, `FILE_WRITES`/`GIT_WRITES`/`SHELL_TOOLS` in `policy.js`, `ACTION_WRITE_TOOLS`, `tool-groups` and the `parallel-tool-policy` read set.

Risk rules (deterministic first; the categories follow Codex's guardian policy):

- **Shell:** parse the command with the existing scanner. Known read-only commands such as `ls`, `rg`, `git status|diff|log` and `cat` are `low`. Destructive patterns are `high`: `rm -r` outside the workspace, `git reset --hard`, `git push --force`, `git clean`, writes to `~`/system paths, `curl … | sh`, shadowed `$HOME`. Everything else is `elevated` in Manual and `low` in Auto when the command stays inside the workspace.
- **Paths:** anything outside the workspace or a registered worktree is `elevated`. Secrets (`.env*`, `~/.ssh`, `~/.minnow/.key`, keychains) are `high` for reads and writes alike.
- **Network and browser:** search, `web_fetch`, and browser navigation to **any origin** are `low`. Browser origins have no allowlist and no separate permission, so in Auto and Full access the agent can open any site without a prompt. Posting or uploading data, form fills and `browser_eval` on authenticated origins are `elevated`.
- **MCP and plugins:** follow MCP tool annotations. `readOnlyHint` makes the call `low`, `destructiveHint` makes it `high`, and no hint makes it `elevated`. Plugin manifests get the same fields.
- **Settings:** changes that weaken security (filesystem, devices, sandbox) are `high`; others are `low`.
- **Agent:** spawning is always `low`. The child's own actions are classified separately.

### 3.3 Decision table

| | Manual | Auto | Full access |
|---|---|---|---|
| `low` read inside workspace | allow | allow | allow |
| any other `low` | **ask** | allow | allow |
| `elevated` | ask | **ask** (later: reviewer, §3.6) | allow |
| `high` | ask | ask | allow |

One **floor** holds even in Full access: writing to `~/.minnow/.key` or decrypted secret stores is always denied, because the backup and secret invariants depend on it. This is open decision **D3**.

### 3.4 Remembered approvals ("allow for this chat")

No persistent per-tool switches. The approval card offers scoped grants that live **in the chat only**:

- shell → command prefix (`npm test`, `git commit`)
- edit outside workspace → that directory
- network/browser → that origin
- MCP/plugin → that server/plugin
- settings → that key

These are stored on the chat record next to `pinnedSkill` and captured into the execution policy snapshot, so delegated runs see them too. Grants only matter in Manual, and Auto in the elevated cases. No grants persist beyond the chat (decision **D4**). The persisted browser origin allowlist is **deleted, not migrated**.

### 3.5 What gets deleted or folded

- `tools.json` `permissions.default` and the per-tool segmented control in Settings. Tool **availability** (turning off a whole family like Browser, or an MCP server) stays as a plain toggle, because that is not a permission.
- The `filesystemAccess` setting: Full access implies full disk.
- The **block** on outside-workspace paths becomes an **ask** in Manual and Auto.
- The `fileWriteScope`/`toolPermissions` fields in `server/chats/policy.js`, replaced by `{ level, grants, turnClamp }`.
- The whole browser origin system: the allowlist store and its Settings UI (`src/config/browser-meta.ts`), `browser-navigation-gate.ts`, `browser-allowlist-match.ts`, the `ask_question` approval flow, `browser-allowlist.md` and the `request_browser_origin_access` tool. Browser navigation is an ordinary `browser` action under the level.
- Goal-loop auto-approve. A goal runs at the chat's level, so the user picks Auto or Full for unattended goals.
- The MCP approval bypass. MCP is now classified like everything else.
- The companion-device rule (`COMPANION_MUTATING_TOOLS`): phones run at the system level, including Full access (decision **D5**). Approvals that do come up appear on the phone with the same card.
- The shell sandbox stays as an orthogonal advanced setting. In Full access, `allow_unsandboxed` is implied.

### 3.6 Auto reviewer (phase 2, behind a setting)

This is Codex's "Approve for me". Instead of asking about an `elevated` action, Auto can send it to a **reviewer**. The reviewer is the chat's own model by default, or a configured small model. It gets a compact policy (~2k chars, adapted from the guardian taxonomy) and returns `allow | ask` with a one-line rationale. `high` always asks.

Ship deterministic Auto first and add the reviewer once the evals show it isn't approving bad actions.

## 4. Approval card redesign

The card replaces `src/ui/tool-approval-modal.ts` and `tool-approval.css` and stays docked above the composer.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⌘ Run a command                                   ◦ sub-agent · Fix CI │
│                                                                      │
│   npm install --save-dev vitest                                      │
│   in  minnow/  ·  ⚠ installs packages from the network                │
│                                                                      │
│ ▸ Details                                                1 of 3 waiting│
│                                                                      │
│ [ Allow  ⏎ ]  [ Allow `npm install` for this chat  2 ]  [ Deny  esc ] │
│ ───────────────────────────────────────────────────────────────────── │
│ ✋ Manual · change          Tell Minnow what to do instead…           │
└──────────────────────────────────────────────────────────────────────┘
```

- **The headline is a verb phrase per kind**: Run a command, Edit 3 files, Open github.com, Use Linear (MCP), Change a setting. The raw tool id goes into Details.
- **The body is the thing itself**: the command, file paths with a mini diff for edits, the URL, or a short argument summary for MCP/plugins.
- **A risk chip shows the classifier's reason**: outside project, network, destructive, secrets.
- **Details** expands to the full args JSON, the workspace path and the tool id.
- **Queue:** with several pending (parallel sub-agents), the card shows "1 of 3". Each card is badged with the asking agent's **title** rather than a type, now that types are gone.
- **Deny with feedback:** typing in the inline field and pressing Enter denies and sends the text to the agent as the tool result, as Claude Code and opencode do. Plain Deny returns "User denied".
- **Keys:** Enter/1 allows, 2 grants for the chat, Esc/3 denies. Keep the existing "don't steal digits while typing" logic.
- **The footer shows the current level** with a one-click switch, which applies the new level to the pending card as well.
- It renders the same card on mobile (`src/mobile/chat-thread.ts`), in the activity/needs-you surfaces and on headless remote requests (`src/ui/managed-chat-requests.ts`), all through one renderer.
- The preview-occluder contract applies (`markPreviewOccluder`).
- Design: `--mn-*` tokens only, entry motion that respects `prefers-reduced-motion`, and an Impeccable pass.

## 5. Modes become slash skills

| Today | After |
|---|---|
| Build (default) | **The agent.** No label. |
| General | **`/ask`**: answer, explain or research. **Turn clamp: read-only.** |
| Plan / Super Plan | **`/plan`**: merges `plan.full.md` (condensed) into the `plan-work` skill. **Clamp: read-only + writes to `documentation/plans/**.md`.** Pinned to the chat until the plan is accepted or the user unpins it, which gives Codex-style plan stickiness with no mode. |
| Debug | **`/debug`**: merges `debug.full.md` into `debug-error`. No clamp. |
| Orchestrate | No longer a mode id. Boards open from the sidebar, as they do today, and `/orchestrate-plan` stays. |
| Onboarding | The first-run chat pins an **`onboarding`** skill with a read-only clamp. |

**Turn clamp.** This is the one new skill front-matter field: `access: read-only | plans`. A clamp only narrows. It removes write, shell-write and git-write actions from *that turn's* execution policy and denies them in the classifier. It never widens the chat's level. This replaces `plan-write-guard`'s mode dependency, so the guard keys off the clamp instead of `modeId`.

Removed: the mode selector (`src/ui/mode-selector.ts`, `mode-icons`), the `set_chat_mode`, `create_chat_with_mode` and `propose_mode_switch` tools, `mode-handoff.md`, `MODE_ALLOWED_GROUPS`, `filterToolsByMode` and all `modes/*.md` prompts.

**Persistence:** `modeId` stays a valid but ignored field on stored chats, scheduler jobs and managed chats, following the `super-plan` precedent, so no record migration is needed. On load, `normalizeModeId` maps an old `plan` chat to a pinned `/plan` skill and an old `general` chat to nothing (it runs as the agent).

## 6. One agent: work agents and sub-agent types go away

- **Work agents:** delete the registry (`src/chat/prompts/work-agents/*`, `work-agent-registry.ts`, the `/api/work-agents` routes and the Settings → Agents prompt editors). Useful guidance moves:
  - builder's verification checklist → `/review` and the base prompt's "verify" line
  - tester → `write-tests`
  - reviewer → `code-review`
  - researcher → `/ask`
  - ui-designer → the `ui-designer` skill (already exists)
  - knowledge-capture → three gated lines in the base prompt (Brain on)
- **Sub-agents:** `spawn_sub_agent({ task, title, wait?, workspace_strategy?, workspace_id? })`. `type`, `category` and `board_task_id` are removed. `sub-agents.json` collapses to `{ enabled, globalMaxConcurrent, defaultModel, contextPolicy }`. A child gets **the parent's tools minus spawning**. It inherits the parent's level and grants, and its approvals surface in the parent's queue. The child prompt is the base prompt plus a five-line delegation envelope (task, "you're not alone in the workspace", return a self-contained report, no questions to the user unless blocked).
- **Board members:** drop the `build`/`test`/`fix` tool lists. The role is a sentence in the task brief. Board tasks run at the board's level, which defaults to the launcher's.
- **Experts** (hidden app): the `expert` prompt part stays wired so its code keeps working, but it is out of scope.

## 7. Tools: up front versus on demand

### 7.1 Consolidate the catalog (127 tools → about 70)

| Merge | Into |
|---|---|
| `read_file`, `read_file_range` | `read_file` (offset/limit) |
| `search_in_file`, `grep` | `grep` |
| `append_file`, `insert_at_line`, `replace_text_in_file` | `edit_file` (anchor replace) + `apply_patch` |
| `start_background_command`, `stop_background_command`, `list_running_commands`, `read_command_log`, `stop_command` | `execute_command` (`background`) + `command_output` + `stop_command` |
| `move_file`, `copy_file`, `make_directory`, `delete_path` | Shell (classified) and `delete_path` (kept for an explicit destructive classification) |
| `fetch_web_content`, `web_extract`, `web_map`, `rag_web_content`, `wikipedia_search` | `web_fetch` (url, optional query) + `web_search` |
| `get_datetime`, `calculate`, `get_system_info` | Removed: the date and OS are in the prompt, and the shell covers the rest |
| `chat_*`, `list_sub_agents`, `get_sub_agent_status`, `cancel_sub_agent`, `agent_capabilities` | `spawn_sub_agent` + `agent` (`status`/`send`/`wait`/`stop`) |
| `set_chat_mode`, `create_chat_with_mode`, `propose_mode_switch`, `request_browser_origin_access` | Removed |

Exact merges get a per-tool audit in wave 5, using the generated inventory, and each one keeps argument compatibility shims for one release.

### 7.2 What is loaded up front (about 15 schemas)

`read_file`, `list_directory`, `grep`, `find_files`, `edit_file`, `apply_patch`, `save_file`, `execute_command`, `command_output`, `todo_write`, `ask_question`, `spawn_sub_agent`, `web_search`, `web_fetch`, `load_skill`, `search_tools`

Everything else is deferred: git, code-intel, LSP diagnostics, browser, issues, brain, documents, settings, appearance, Minnow docs, plugins and MCP.

### 7.3 The model knows what it can load

The system prompt gets a **capability index**: one line per deferred family, with names and no schemas (about 400 tokens in total). For example:

```
Load with search_tools before use:
- git: git_status, git_diff, git_log, git_commit …
- issues (project tracker): issue_add, issue_update, issue_search …
- browser (in-app preview): browser_navigate, browser_snapshot, browser_click …
- mcp · linear: 12 tools — mcp__linear__*
```

This fixes the reason issue tools had to stay in the core set. `search_tools` gains `select:a,b` exact loading and returns schemas **in the result**, so where the provider allows it they are callable in the same turn. The current "next request" behavior stays as a fallback for providers with fixed tool arrays. The CLI-provider MCP path (`search_mcp_tools`/`call_mcp_tool`) folds into the same index.

Prompt-cache note: the core set is fixed per release, and families are appended in load order, keeping the stability the current comment cares about.

## 8. Prompt rewrite

**Target:** one base prompt of about 1.5–2.5k tokens, down from about 10k. No modes, no work-agent part and no lite/full split for the base. Parts, in order:

1. **Runtime:** "You are Minnow, a coding agent running in the Minnow desktop app, through `{{provider}}` as `{{model}}`. Working directory, date, platform." (T3 `<runtime_info>` style)
2. **Harness:** Markdown rendering; `path:line` links; `<system-reminder>` blocks; parallel tool calls; untrusted-data policy (kept, shortened).
3. **Working in code:** match conventions; read before editing; don't revert work you didn't do; verify changes with the narrowest relevant check.
4. **Permissions:** one sentence generated from the level, as Codex's `approval_policy/*.md` does. For example: "Permission level is Auto: routine actions run; risky ones pause for the user. A denial means stop and ask, not work around."
5. **Communication:** brief progress notes only when they add information; the final answer leads with the outcome.
6. **Capability index and skill list** (names and one-line descriptions).
7. **Project context**, as today: AGENTS.md/context docs, memory (gated), code map (gated), pinned skill.
8. **Local-model appendix** (opt-in, about 500 tokens): explicit tool-call discipline, read-before-write and no invented output. It is on automatically for local providers below a size threshold (decision **D6**).

### 8.1 Local-model appendix (draft)

**When it applies:** chats on a local provider (LM Studio, the built-in llama runtime, `llmster`), unless it is turned off in Settings → Prompts. It is about 350 tokens and goes after the base prompt.

**Purpose:** frontier models do these things without being told. 7–30B models often don't. Each rule targets a failure the current prompts already patch in some form, in `tool-usage/default.full.md`, the builder's repair loop and the "describing a call is not executing it" line.

```md
## Working with tools

- To act, make a tool call. Writing "I'll run X" or showing a call in text does nothing.
- Arguments are JSON that matches the tool's schema exactly. Paths are relative to the working directory.
- Never write a tool's result yourself. If you have not seen the output, you do not know it.
- If a tool you need is not in your list, call `search_tools`. Do not guess tool names.
- Batch independent calls. When the next call depends on a result, wait for it.

## Editing

- Read the file, or the relevant range, before you edit it. Copy the exact text you replace, without the `N:` line prefixes `read_file` shows.
- After an edit, confirm it worked by re-reading the region or running the relevant check.

## When something fails

- Read the error and change something before retrying. Never repeat an identical failed call.
- After three failed attempts at one step, stop and tell the user what is blocking you and what you tried.

## Staying on task

- Search before reading. Read ranges of large files, not the whole file. Do not re-read files that haven't changed.
- Keep going until the request is done or you are blocked. Do not stop to ask before routine steps; Minnow asks the user when an action needs approval.
- Finish with the files you changed, what you checked and the result, and anything left undone.
```

The eval gate in §8 runs both ways on the local model, with and without the appendix. A rule that doesn't move the pass rate or the tool-error rate gets cut.

Content that moves out of the system prompt:

| Fragment | Goes to |
|---|---|
| `ask-question-enforcement` | `ask_question` description |
| `sub-agent-delegation`, `chat-coordination` | `spawn_sub_agent`/`agent` descriptions + one line |
| `browser-allowlist`, `shell-sandbox`, `mode-handoff` | Deleted (the permission system handles these) |
| `fact-verification`, `investigate-before-answer` | One line in "Working in code" |
| `github-cli` | One line when `gh` is detected |
| `context7-docs` | Tool description |
| Shell mechanics (Windows pipes, `timeout_ms`, `--test-force-exit`) | `execute_command` description |
| Build report template, todo rules | `todo_write` description; the report template is dropped |

**Eval gate (before and after):** run `src/evals` (including the `agent-coordination` pack) and the benchmark harness on one local model (e.g. Qwen3-Coder 30B) and one cloud model. Record prompt tokens per request, task pass rate and tool-call error rate. The rewrite ships only when the pass rate is within noise or better on both.

## 9. `/` menu redesign

The menu is modelled on Codex's flat list of an icon, a bold label, a muted description and a `›` for submenus, then given a Minnow treatment.

```
╭──────────────────────────────────────────────────────────────╮
│  COMMANDS                                                    │
│  ◌ Ask         Answer or explore without editing files       │
│ ▸◌ Plan        Research and write a plan before building   ›│  ← active row
│  ◌ Debug       Find the root cause, then fix it              │
│  ◌ Review      Review uncommitted changes or a branch      › │
│  ◌ Compact     Fold older turns into a summary               │
│  ◌ Goal · Loop · Follow-up …                                 │
│  ◌ Model                                         GPT-5.1   › │
│  ◌ Permissions                                   Auto      › │
│  ◌ Reasoning                                     High      › │
│  ◌ MCP         Server status                               › │
│  SKILLS                                                      │
│  ◌ frontend-design  ·  impeccable  ·  …                      │
╰──────────────────────────────────────────────────────────────╯
```

- **The Minnow touch:** a small fish glyph marks the active row and *swims* to it on arrow keys (a 120ms translate on one absolutely positioned element). Rows sit on a faint current-line texture. Section labels are small caps. Under `prefers-reduced-motion` the glyph moves without animating.
- **Submenus open in place** (Model, Permissions, Reasoning, Review target, MCP): the list slides one level deeper, with ← or Backspace to go back. These reuse the existing model/reasoning pickers' data.
- **Ranking:** prefix match on the id, then the label, then fuzzy description; the last 3 used appear first when the query is empty. Commands and skills stay in separate sections instead of sorting together alphabetically, as `picker-catalog.ts` does today.
- **Values on the right** (current model, level, reasoning effort) make the menu double as a status panel.
- **Files:** `src/ui/skill-picker.ts` (rewrite), `src/chat/slash-commands/registry.ts` (add `icon`, `section`, `submenu`, `value`), `skill-picker.css`. Add `/ask`, `/plan`, `/debug`, `/review`, `/model`, `/permissions`, `/reasoning`, `/mcp`.

## 10. Decisions

All eight were settled on 2026-11-08 by taking the recommendation as written. The "Recommendation" column is now the agreed behavior.

| # | Question | Agreed |
|---|---|---|
| D1 | Should the composer pill change the level **for this chat** or **globally**? | **Globally.** The composer sets the system default; there are no per-chat overrides. The menu header reads "Permissions". |
| D2 | Default level for new installs and upgrades | **Auto** for everyone. Upgraders who had any tool on `full` keep Auto; the rest get a one-time notice. |
| D3 | Hard floor in Full access for `~/.minnow/.key` and secret stores? | Yes, always denied. |
| D4 | Persistent grants ("always for this project")? | None. Chat-scoped grants only. The browser origin allowlist is deleted; origins follow the level like everything else. |
| D5 | Phone sessions capped at Auto? | **No.** Phones can use Full access. |
| D6 | Local-model appendix: automatic or manual setting? | Automatic for local providers, with an override in Settings → Prompts. |
| D7 | Keep the full/lite prompt profiles? | Drop them for the base prompt; the appendix replaces lite. |
| D8 | Should `/plan` be enforced (clamp) or prompt-only like Codex? | Enforced. The plan-write guard already exists and is cheap to keep. |

## 11. Waves

Each wave can ship on its own. Waves A, B and E can run in parallel.

| Wave | Scope | Main files | Done when |
|---|---|---|---|
| **0 Baseline** | Prompt-token and eval snapshot on a local and a cloud model | `src/evals`, `src/benchmark` | Numbers recorded in this doc |
| **A Permission engine** | `classify.js` + catalog `effect` metadata, decision table, chat grants, server enforcement (`policy.js` → `{level, grants, turnClamp}`), client gate rewrite, MCP/plugin/browser/path/companion/goal/headless routed through it, Settings → Permissions, composer pill and menu | `server/permissions/*`, `server/chats/policy.js`, `src/tools/permission-gate.ts`, `src/tools/config.ts`, `src/headless/approval.ts`, `server/tools/builtin-catalog.js` | Every tool call in `test/` hits one classifier; MCP no longer bypasses; the per-tool permission UI is gone |
| **B Approval card** | New card, queue, deny-with-feedback, chat grants, mobile/remote parity | `src/ui/tool-approval-modal.ts`, `tool-approval.css`, `src/mobile/chat-thread.ts`, `src/ui/managed-chat-requests.ts` | Card covers all action kinds; Impeccable passes |
| **C One agent** | Remove the mode selector, mode tools and mode prompts; add `/ask` `/plan` `/debug` skills with the `access` clamp; onboarding skill; ignore `modeId` | `src/chat/modes/*`, `src/ui/mode-selector.ts`, `src/skills/*`, `plan-write-guard.ts`, `prompt-composer.ts` | No code path reads `modeId` except normalization |
| **D Agent types** | Delete work agents and sub-agent types; simplify `spawn_sub_agent`; board roles become brief text; child approvals bubble up | `src/agents/*`, `src/chat/prompts/work-agents`, `server/runner/tool-set.js`, `server/chats/delegation.js` | One agent config; board scenario contract passes |
| **E Slash menu** | Picker rewrite, sections, submenus, swim indicator | `src/ui/skill-picker.ts`, `src/chat/slash-commands/*` | Keyboard and mouse parity; reduced motion handled |
| **F Tool surface** | Catalog merges, core set, capability index, `search_tools` select and same-turn | `server/tools/builtin-catalog.js`, `server/runner/lazy-tools.js`, `tool-exposure.js` | About 15 up-front schemas; evals at or above baseline |
| **G Prompt rewrite** | New base prompt, level sentences, local appendix, fragments moved into tool descriptions | `src/chat/prompts/base/*`, `tool-usage/*` | Base prompt ≤2.5k tokens; evals at or above baseline |
| **H Docs and cleanup** | `documentation/context.md`; manual `concepts/modes.md` → removed, `tools-and-permissions.md` rewritten, `skills-and-commands.md`; AGENTS.md overview; inventory regen; dead tests removed | docs | `npm run test:product-wiki` and coverage gate pass |

Dependencies: C needs A, because the turn clamp lives in the policy. D needs A and C. F needs C, because tool gating by mode must be gone first. G needs C, D and F. H comes last.

## 12. Risks

- **Local models with small prompts.** The eval gate (§8) and the local appendix guard against regressions.
- **Auto approving something bad.** The classifier is deterministic and conservative, and `high` always asks. The reviewer is opt-in and comes later.
- **Wide `modeId` blast radius.** Keep the field and normalize it rather than migrating stored records, following the super-plan precedent.
- **Prompt cache churn.** Keep the core tool array fixed; deferred loads only append.
- **Hidden apps' tests** (Compare, Bench, Experts) may still construct modes. Update their fixtures; do not delete their tests.
