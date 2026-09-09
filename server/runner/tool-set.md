# Headless tool set (MIN-701 / P2-D)

The runner does not hardcode Builder/Tester roles. Callers pass `tools` (P2-B)
and, when they want a default, `DEFAULT_HEADLESS_TOOL_IDS` from
`server/runner/tool-set.js`. This note records the port-vs-exclude decision for
every renderer-only tool a board agent might want.

**Rule:** a tool is in the default set only if `POST /api/tools` (and therefore
`executeServerTool`) implements it. Renderer-only tools stay excluded until a
later phase ports them with every guard they have today (browser origin
allowlist, ask_question UI, and so on). Skipping a guard because “the caller is
trusted” is how a board agent kills the host.

Tests assert `rendererOnlyToolsIn(DEFAULT_HEADLESS_TOOL_IDS)` is empty and that
each default id is not answered with `Not implemented: <name>`.

## Exclude (do not port in P2-D)

| Tool | Why it needs a renderer | Decision |
|------|-------------------------|----------|
| `get_datetime`, `calculate` | `src/tools/browser-executor.ts` | Exclude. Agents can use `execute_command` (`date`, `node -e`) if they need a clock or math. |
| `get_system_info` | Browser executor (UA / `navigator`) | Exclude. Node `execute_command` covers OS facts. |
| `read_clipboard`, `write_clipboard` | DOM clipboard | Exclude. Unattended runs have no clipboard. |
| `ask_question` | Composer card; P6-B injects `AskCapability` on interactive `runTurn` callers | Exclude from the default headless set. Unattended `runTurn` passes `ask: null`; a fabricated call is an immediate tool error (no hang). |
| `wikipedia_search` | Browser executor (CORS fetch) | Exclude. Use `fetch_web_content` / `web_search_ddg`. |
| `web_search` | **Client router** to Brave (browser) or `web_search_ddg` / Tavily / SearXNG | Exclude the router name. Include the **server backends** (`web_search_ddg`, `web_search_tavily`, `web_search_searxng`). |
| `spawn_sub_agent`, `cancel_sub_agent`, `list_sub_agents`, `get_sub_agent_status` | Nested loops in the renderer adapter | Exclude. V2 attempts are processes started by the effector (P2-F), not sub-agent tools. |
| V1 board mutation tools (deleted MIN-715) | V1 board UI + session state | Gone. V2 reports through the injected report tool (`report_outcome`); the engine owns the graph. |
| `set_chat_mode`, `create_chat_with_mode`, `launch_minnow_app`, `propose_mode_switch` | Mode handoff + OS window | Exclude. Headless turns do not switch composer modes. |
| `browser_*`, `request_browser_origin_access` | Electron preview + **origin allowlist** (`checkBrowserNavigationAllowed`) | **Exclude.** Phase 5 ports a server-side driver and must take the allowlist with it. Shipping `browser_navigate` in-process without that allowlist would bypass the guard Linear called out. |
| `todo_write` | Chat checklist DOM (`src/ui/todo-panel`) | Exclude. No transcript-scoped todo panel on the server. |
| `get_appearance`, `update_appearance`, `upload_appearance_asset` | Theme / CSS in the renderer | Exclude. Not a Builder/Tester need. |
| `recall_chat_context`, `recall_turn_full` | Session archive in the renderer | Exclude. The attempt transcript is injected (`TranscriptStore`). |
| Issue tools (`issue_*`) | Client issue store / v2 HTTP mix | Exclude from the **default** set (not a board-agent need). Callers may pass them later if a server handler exists. |

## Port (already server-side — include in the default)

File read/write, git, `execute_command` (+ log/stop/dev-server/JS/Python), code-intel, LSP, Brain wiki read + `save_memory`, web backends + `fetch_web_content` / `rag_web_content`, `minnow_docs_*`, Impeccable load/run.

These already run through `executeServerTool` with cwd-guard, host-kill, host-port-bind, windows-pipe, plan-write, output-cap, and `workspaceRoot` allowlist. The in-process dispatcher is a call-route skip, not a new implementation.

## Intentionally omitted from the default (server-side but not agent work)

`update_settings` / `get_settings` / `search_settings` (host config), `manage_brain` (destructive), email, `board_provision_infra`, notifications. A caller can still pass them in `allowedToolNames` / `tools`.

## Board roles are narrower than the default (2026-09-09)

`DEFAULT_HEADLESS_TOOL_IDS` is now the **sub-agent** set — everything above that
a headless caller may hold. Board roles run from two smaller lists, selected by
`headlessToolIdsForRole`:

| Role | List | Tools |
|------|------|-------|
| `builder` | `BOARD_BUILDER_TOOL_IDS` | read + `BOARD_WRITE_TOOL_IDS` |
| `tester`, `final`, `merge` | `BOARD_VERIFIER_TOOL_IDS` | read only |
| `sub-agent`, anything else | `DEFAULT_HEADLESS_TOOL_IDS` | the full set |

Two reasons, and both are about what an unattended attempt can reach for:

**Duplicates are a per-turn decision, not free surface.** A board task is scoped
work in one worktree, so it does not need two ways to background a command
(`execute_command` with `background: true` covers `start_background_command`),
two script runners (`run_javascript` / `run_python` vs `execute_command`), three
search engines (only `web_search_ddg` needs no API key), or two page fetchers.
Nor does it need office-document creation, the Minnow product manual, the
impeccable design-review set, or `save_memory` — an unattended attempt should
not be writing the user's long-term memory.

**A prompt line is not an enforcement point.** The Tester and Final Tester are
both told "Do not modify application code" while holding `save_file`,
`delete_path`, `git_checkout` and `git_commit`. In this repo a running board has
written the real checkout. The verifier list removes the capability instead of
asking for restraint.

### `browser_drive_*` is dispatch-only

The browser rung drives those tools from code, after the Final Tester finishes,
against the plan's pinned URL. No model chooses the calls, so no role's tool
list contains them. `dispatchToolIdsForRole('final')` — the **execution**
allow-list `browser-rung.js` passes to `executeInProcessTool` — is the only
place they appear. Before this split, the Final Tester was handed all eight
schemas and its prompt spent a section talking it back out of using them.
