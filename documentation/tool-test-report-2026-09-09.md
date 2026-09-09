# Tool Surface Test Report — 2026-09-09

- **Date:** 2026-09-09
- **Environment:** Windows 10 (Win32), Electron shell (Minnow 0.0.5, Chromium 150), Node **v24.19.0**, Python **3.14.7**, shell = cmd (Git for Windows on PATH)
- **Workspace:** `C:\Users\dukky\Documents\Development\Minnow` (branch `main` @ `29e8fc15` at completion)
- **Scope decision:** **Full** (user-selected via `ask_question`; sandbox, git writes on a throwaway branch, dev-server registry, background processes, temp issues + brain pages — all with guaranteed cleanup)
- **Tool surface probed:** ~100 tools exposed this session, grouped per the probe tables below. `todo_write`, `explain_symbol`, `list_lsp_servers` are **not exposed** in this session's definitions (they existed in earlier audit runs — see `facts/code-map-tools-audit-2026-09-09.md`).

## Executive summary

| # | Severity | Tool(s) | Issue |
|---|----------|---------|-------|
| 1 | **Medium** | `repo_map` (focus), `find_symbol`, `read_symbol`, `who_calls` | Code-index tools miss files created mid-session. `makeGreeting` in the session-created `tool-test/fixtures/script.ts` was not found by any of them, while committed symbols (`getBrainDir`) resolve perfectly. Root cause is index staleness for new files, not a broken surface. |
| 2 | **Low** | `issue_delete` | Deleting an issue leaves a **dangling inverse `issueRefs` entry on the peer issue** (MIN-306 still listed MIN-307 as `related` after MIN-307 was hard-deleted). `issue_unlink` cleaned it. |
| 3 | **Info** | `append_file` | Appends join directly to the last line when the file has **no trailing newline** (`…sleepy catline four: appended line`). No separator newline is inserted. Caller's responsibility, but easy to hit. |
| 4 | **Info** | `read_clipboard` | First call failed: "Document is not focused. Grant clipboard permission if prompted." Same tool **passed on retry** after a `write_clipboard` (round-trip exact). Transient focus/permission state, not a hard failure. |
| 5 | **Info** | `git_diff` | Stderr noise on docx: `astextplain: line 18: docx2txt.exe: command not found` (Git textconv config, environment-side). Diff itself succeeded; xlsx correctly reported as binary. |
| 6 | **Info** | `browser_navigate` | Navigating to a workspace file URL (`/tool-test/fixtures/sample.html`) serves the **SPA shell** (Vite fallback + hash router), not the raw file. Browser automation itself works; use the preview's workspace-path form for files. |
| 7 | **Info** | `get_settings` | Section-only key (`integrations.search`) returns a clear "cannot be read while Minnow is offline" message; area-filter reads work. Expected behavior, good error copy. |

**Watchlist re-check (2026-08-06 run → now):**

| Watchlist item | Result this run |
|----------------|-----------------|
| 1. `git_status` omits mid-session untracked files | **Not reproduced** — showed `?? tool-test/` correctly; the earlier "disappearance" of 8 baseline entries was a real external commit (`29e8fc15`) landing mid-session, confirmed via raw porcelain |
| 2. `execute_command` mangles quoted args on Windows | **Not reproduced** — `node -e "console.log('hi')"` and `"…with spaces"` both worked |
| 3. Browser tools fail (allowlist / screenshot base64) | **Not reproduced** — all 11 browser tools passed; screenshot saved a 60 KB PNG |
| 4. `brain_ingest_source` lies about page creation | **Not reproduced** — truthfully reported "Ingested source into 1 page(s): tests/tool-surface-test.md" |
| 5. `npm test` engine.test.ts failure | **Not re-run** (surface test, not a suite run) — no change claim |
| 6. `git_commit` brain-hook stderr noise | **Not reproduced** — clean commit, no `[minnow-brain-hook] fetch failed` |
| 7. `manage_dev_servers` primary "Health check timed out" | **Not reproduced** — `primary` shows `no_guide` (no `startup.md`); no timeout observed |
| 8. `run_impeccable detect` 60 s timeout | **REPRODUCED** — full-repo `detect` → `Error: run_impeccable (detect via impeccable cli) timed out after 60s (cwd .)`. Scoped `detect` on `tool-test/` returned instantly with no output (no violations) |
| 9. `get_lsp_diagnostics` raw ENOENT on missing file | **Not reproduced** — clean `Error: File not found: tool-test/fixtures/missing-file.ts` |

**Pass/fail:** 93 tool probes passed · 1 reproduced failure (impeccable detect timeout) · 2 findings needing maintainer attention (code-index staleness, dangling issue refs) · 4 not tested (reasons below).

---

## Tool-by-tool results

### Utility
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `get_datetime` | ✅ | call | ISO 8601: `2026-09-09T22:43:02.412Z` |
| `calculate` | ✅ | `(2 + 3) * 4 - 1` | `19` |
| `get_system_info` | ✅ | call | JSON with platform `Win32`, userAgent (Electron), screen 5120×1440, 32 cores |
| `read_clipboard` / `write_clipboard` | ✅ (caveat) | save original → write marker → read back → restore | Write + read-back exact (`tool-surface-test marker`). First read failed (document not focused); original content was never captured, so restore was impossible — see Cleanup. Finding #4 |

### Filesystem (all inside `tool-test/`)
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `save_file` | ✅ | 5 fixtures (txt/html/ts/json/error.ts) | Bytes reported; readable back |
| `read_file` / `read_file_range` | ✅ | hello.txt full + lines 1–2 | Exact content; numbered slice |
| `append_file` | ✅ (caveat) | append 1 line | Appended, but glued when file lacked trailing newline — Finding #3 |
| `insert_at_line` | ✅ | insert after anchor line | Landed exactly after `line four` |
| `replace_text_in_file` | ✅ | 1 occurrence replace; then `expected_count: 2` on 3 matches | First replaced ok; guard refused: "expected 2 occurrence(s) but found 3… No changes written" |
| `search_in_file` | ✅ | regex `quick\|dog` | `path:line` results |
| `grep` | ✅ | literal `lazy dog` | `tool-test/fixtures/hello.txt:3:…` |
| `find_files` | ✅ | `**/*.ts` | Both TS fixtures listed |
| `copy_file` / `move_file` | ✅ | copy → move | Both succeeded; content verified |
| `get_file_metadata` | ✅ | txt + html | size/mtime/`line_ending: LF` |
| `make_directory` / `delete_path` | ✅ | fixtures + docs dirs; sandbox deleted at cleanup | ok |

### Documents
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `create_pdf` | ✅ | `tool-test/docs/sample.pdf` | 9,450 B |
| `create_spreadsheet` | ✅ | 2 sheets | 17,398 B |
| `create_word_document` | ✅ | 4 sections | 8,612 B |
| `read_document` | ✅ | extract all three | PDF text round-trips; xlsx sheet manifest + rows; docx headings present |

### Git
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `git_status` | ✅ | mid-session untracked check + cross-check vs raw porcelain | Accurate both times (watchlist #1 cleared) |
| `git_diff` | ✅ | staged diff of new sandbox | Correct patches; xlsx `Binary files … differ`; docx textconv stderr noise (Finding #5) |
| `git_add` | ✅ | stage sandbox | ok; LF→CRLF warnings normal on Windows |
| `git_checkout -b` | ✅ | `tool-test-run` | created + switched |
| `git_commit` | ✅ | labeled commit | `e4b0fb59`, 9 files, clean (watchlist #6 cleared) |
| `git_log` / `git_branch` | ✅ | recent commits; branch list | commit on top; branch listed |

### Execution / process
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `execute_command` | ✅ | `node --version`; quoted `-e` with spaces | v24.19.0; quoting works (watchlist #2 cleared) |
| `run_javascript` | ✅ | cwd/node/arch | correct JSON |
| `run_python` | ✅ | sys.version + cwd | 3.14.7, correct cwd |
| `start_background_command` | ✅ | `node -e setInterval(console.log,1000)` | runId + pid 33672 |
| `read_command_log` | ✅ | poll before/after stop | log grew 1→6 ticks; `found/finished/exitCode` flags correct |
| `list_running_commands` | ✅ | during + after run | listed while running; empty after stop |
| `stop_command` | ✅ | stop background run | `finished: true`, exit 1 (killed); registry cleared |
| `stop_background_command` | ⚪ | — | Not probed separately; `stop_command` covers the same lifecycle |
| `manage_dev_servers` | ✅ | list/create/update/start/stop/delete + guard | Full lifecycle ok; delete without `confirmed` refused ("Deletion requires confirmation"), with it deleted; `primary` = `no_guide`, no health timeout (watchlist #7 cleared) |

### Code-intel / LSP
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `repo_map` (focus) | ⚠️ | focus `tool-test/fixtures/script.ts` | "no symbols matched focus" — Finding #1 |
| `find_symbol` | ⚠️ | `makeGreeting` (new file) / `getBrainDir` (committed) | new file: no match; committed: exact match — Finding #1 |
| `read_symbol` | ⚠️ | same pair | new file: `symbol not found`; committed: full span with body (`server/brain/paths.js:21-23`) — Finding #1 |
| `who_calls` | ⚠️ | `makeGreeting` | `symbol not found` (differs from documented "No indexed callers" — same staleness root cause) — Finding #1 |
| `get_lsp_diagnostics` | ✅ | clean file, error.ts, missing file | clean → none; error.ts → 3 errors with line:col (fixture has 3 deliberate errors); missing → clean `File not found` message (watchlist #9 cleared) |

### Web / MCP
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `web_search` | ✅ | "LM Studio local LLM server" | 8 results (tavily), untrusted-data fenced |
| `wikipedia_search` | ✅ | "V8 JavaScript engine" | article hit |
| `fetch_web_content` | ✅ | example.com | main text, fenced |
| `rag_web_content` | ✅ | example.com "example domain purpose" | 2 relevant excerpts, fenced |
| `mcp__context7__resolve_library_id` | ✅ | "Lodash" | `/lodash/lodash` (High rep, 84.07 score) |
| `mcp__context7__query_docs` | ✅ | map/filter | code examples + APIDOC signatures |
| `mcp__fixture__echo` | ✅ | message | replied `pong`, fenced |

### Browser (watchlist #3 cleared — Electron preview backend live)
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `browser_list` | ✅ | initial + after tabs | tab list with [active] marker; initial empty is correct |
| `browser_navigate` | ✅ | local URL + example.com | no allowlist error; SPA fallback for file URL (Finding #6) |
| `browser_snapshot` | ✅ | SPA + example.com | full accessibility tree |
| `browser_fill` | ✅ | file-tree filter `tool-test` | filled |
| `browser_click` | ✅ | refresh file tree | clicked |
| `browser_eval` | ✅ | title/href probe | correct JSON |
| `browser_screenshot` | ✅ | capture | 60 KB PNG saved |
| `browser_new_tab` / `browser_switch_tab` / `browser_close_tab` | ✅ | 2-tab lifecycle | open/switch/close all ok |
| `request_browser_origin_access` | ⚪ | — | Not needed (allowlist already satisfied; no origin prompt surfaced) |

### Brain / memory
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `brain_search` | ✅ | topic + temp pages | ranked results with paths/ids |
| `brain_list` | ✅ | full tree | nested metadata incl. prior audit pages |
| `brain_read_page` | ✅ | `facts/code-map-tools-audit-2026-09-09.md` | full page with frontmatter |
| `brain_write_page` | ✅ | `facts/tool-test-notes.md` | created + searchable |
| `brain_append_log` | ✅ | one line | appended to `log.md` |
| `brain_ingest_source` | ✅ | tiny snippet | "Ingested source into 1 page(s): tests/tool-surface-test.md" — truthful (watchlist #4 cleared) |
| `save_memory` | ✅ | temp fact | saved under `pages/facts/`, searchable |
| `manage_brain` (delete_page) | ✅ | delete 3 temp pages | each required `confirmed: true`; deletions verified via search |

### Issues
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `issue_get_state` | ✅ | header + page | key `MIN`, nextId 17, 116 issues |
| `issue_add` | ✅ | temp issue | MIN-307 created |
| `issue_search` | ✅ | by query | exact hit; `total: 0` after delete |
| `issue_update` | ✅ | title + priority | applied, updatedAt bumped |
| `issue_comment` | ✅ | timeline comment | comment id returned |
| `issue_assign` | ✅ | assignee me | assignedAt set, activity entry |
| `issue_link` | ✅ | code_refs + issue_refs | both attached; bidirectional ref on MIN-306 |
| `issue_move` | ✅ | status change | `in_progress` ok; `in-progress` rejected with clear "unknown status" (taxonomy id, not a bug) |
| `issue_unlink` | ✅ | remove dangling ref | `removed: 1` |
| `issue_delete` | ✅ (caveat) | delete MIN-307 | gone from search, **but peer MIN-306 kept a dangling inverse ref** — Finding #2 |

### Chat context / sub-agents
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `recall_chat_context` | ✅ | "tool surface test scope decision" | graceful "No archived context found" (chat not archived yet) |
| `recall_turn_full` | ✅ | turnIndex 0 | verbatim replay, tool results elided as documented |
| `spawn_sub_agent` (explore, wait) | ✅ | tiny recon of tool-test/ | completed, structured findings, 14 tool turns |
| `spawn_sub_agent` (wait:false) + `cancel_sub_agent` | ✅ | long task then cancel | status → `cancelled`, "the user cancelled this run" |
| `list_sub_agents` | ✅ | after both runs | both listed with statuses |
| `get_sub_agent_status` | ✅ | cancelled run | full metadata incl. `terminalReason: cancelled` |

### Impeccable
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `load_impeccable_context` | ✅ | call | hasProduct + hasDesign + designJson (schemaVersion 3) |
| `load_aesthetics_reference` | ✅ | call | frozen extract returned (mostly TODO placeholders — vendor doc not authored yet) |
| `run_impeccable detect` | ⚠️ | scoped `tool-test` + full repo | scoped: instant, no output; **full repo: 60 s timeout** — watchlist #8 REPRODUCED |

### Minnow docs
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `minnow_docs_search` | ✅ | "install Minnow" | ranked hits with paths + headings |
| `minnow_docs_list` | ✅ | get-started prefix | 3 entries with metadata |
| `minnow_docs_read` | ✅ | install.md | full page, source path cited |

### Settings
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `search_settings` | ✅ | "web search provider" | `integrations.search`, `writable: false` |
| `get_settings` | ✅ | area `general` + section-only key | area read returns server-backed values; section-only key → clear offline message (Finding #7, expected) |
| `update_settings` | ⚪ | — | Not tested — requires an interactive approval strip; no benign value worth flipping during a test run |

### Mode / app / UI
| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `ask_question` | ✅ | scope question | answered "full" |
| `launch_minnow_app` | ✅ | settings app | opened `#/app/settings` |
| `set_chat_mode` | ✅ | build → general (last) | both acknowledged (first `deferred: true`) |
| `create_chat_with_mode` / `propose_mode_switch` | ⚪ | — | **Not run** — would strand the session / pop an interactive handoff prompt (per test protocol) |
| `todo_write` | ⚪ | — | Not exposed in this session's tool definitions |

---

## Not tested (with reasons)

- `update_settings` — needs interactive approval; no harmless change to make.
- `create_chat_with_mode`, `propose_mode_switch` — deliberately skipped: both mutate session state / pop UI prompts mid-test.
- `stop_background_command` — `stop_command` exercised the same stop path.
- `request_browser_origin_access` — the origin was already allowed; no prompt surfaced.
- `todo_write`, `explain_symbol`, `list_lsp_servers` — **not present** in this session's exposed tool surface (previous runs exposed them; `explain_symbol`/`list_lsp_servers` behavior recorded in `facts/code-map-tools-audit-2026-09-09.md`).
- Watchlist #5 (`npm test` engine failure) — out of scope for a surface test; no suite run performed.

## Environment observations

- **External commit mid-session:** the user's own process committed `29e8fc15` (streaming-command work) while probes ran — the 8 baseline working-tree entries vanished from `git_status` for that reason, not a tool bug. Cross-checked with raw `git status --porcelain`.
- **Shell:** cmd.exe; Git for Windows' `astextplain` textconv can't find `docx2txt.exe` (Finding #5).
- **Sub-agent model:** `deepseek-v4-flash` on provider `onboarding-cloud-opencode-go`.
- **Web search provider:** tavily. Clipboard works after the document gains focus; the very first read raced boot focus.
- **Code index:** committed symbols resolve; session-created files don't (Finding #1) — reindex cadence is `on-demand` per Brain settings, so new files wait for an explicit reindex or workspace switch.

## Cleanup performed

- [x] `delete_path` sandbox `tool-test/` (fixtures, docs, generated PDF/xlsx/docx)
- [x] `git_checkout main` — working tree matches pre-test state (`## main...origin/main`), except the throwaway branch below
- [x] **Left behind (labeled):** branch `tool-test-run` with commit `e4b0fb59 "tool surface test: sandbox fixtures"` (9 files) — kept for reproducibility, per protocol
- [x] All background commands stopped (`list_running_commands` empty)
- [x] Test dev-server registry entries deleted (`tool-test-server`, `tool-test-guard`); pre-existing `primary` untouched
- [x] Temp issue MIN-307 deleted; dangling inverse ref on MIN-306 removed via `issue_unlink`
- [x] Temp brain pages deleted (`facts/tool-test-notes.md`, `tests/tool-surface-test.md`, `facts/tool-surface-test-temp-fact.md`); changelog line appended noting the temp page (cleaned up same session)
- [x] Preview browser tabs closed
- [x] Clipboard: **not restored** — original content could not be captured (first read failed, document unfocused). Marker `tool-surface-test marker` remains on the clipboard. Disclosed, not silently claimed.

## Recommended follow-ups

1. **Code-index freshness (Medium):** `repo_map`/`find_symbol`/`read_symbol`/`who_calls` should at least fall back to a live scan (or trigger an incremental reindex) when a query misses and the file exists on disk. Today a brand-new file is invisible to all four tools until reindex.
2. **`issue_delete` cascade (Low):** strip inverse `issueRefs` from peer issues when an issue is hard-deleted, or tombstone deleted ids so `issue_search`/peek can render "deleted" instead of dangling.
3. **`append_file` newline guard (Info):** consider inserting a leading `\n` when the target file lacks a trailing newline (matches most editors' "append line" semantics).
4. **`run_impeccable detect` (Medium):** the 60 s hard timeout makes full-repo detect unusable; surface progress, raise the cap, or stream results incrementally.
5. **`load_aesthetics_reference` (Info):** the returned reference is an unauthored TODO template ("TODO(human): author from…") — either finish it or return a pointer so consumers stop relying on an empty spec.---

## Re-check: Impeccable tools only — 2026-09-09 (second run)

Re-run at the user's request after upstream commit `6e2dd7fa "Enhance Impeccable CLI functionality and documentation"` landed on `main` (user's process, mid-session). Scope: the 3 Impeccable tools only; sandbox-safe probe dir created and deleted. Pre-existing report file was committed by the user's process in `ba9a21f3` during this session — this addendum is a working-tree edit on top of that.

| Tool | Verdict | What was tested | Result / notes |
|------|---------|-----------------|----------------|
| `load_impeccable_context` | ✅ | call | Identical to first run: hasProduct + hasDesign + designJson (schemaVersion 3, generatedAt 2026-07-18). No change |
| `load_aesthetics_reference` | ✅ (unchanged caveat) | call | Still the unauthored TODO template ("TODO(human): author from prompting_for_frontend_aesthetics cookbook") — frozen extract never authored; previous Finding #5 stands |
| `run_impeccable detect` (scoped) | ✅ | `tool-test/impeccable-probe/probe.html` with 3 deliberate violations | **Reported all 3**: `[low-contrast] 4.0:1 (need 4.5:1)`, `[design-system-color]`, `[design-system-radius]`, "3 anti-patterns found." Signaled via **exit code 2 with findings in the error channel** (`Error: impeccable detect exited 2`). Consistent with first run: clean targets return no output / exit 0 |
| `run_impeccable detect` (full, no target) | ❌ **watchlist #8 still reproduces** | default UI roots | `Error: run_impeccable (detect via impeccable cli) timed out after 60s (cwd .)` — unchanged since first run; the 60 s cap still makes whole-repo detect unusable |
| `run_impeccable live` (scoped) | ✅ (new probe) | `live` on the probe dir | **New data point** (untested in first run): returns structured `{"ok":false,"error":"config_missing","path":"…\\.impeccable\\live\\config.json"}` — live mode requires `.impeccable/live/config.json`, which does not exist in this workspace. No hang, no side effects |

**Side effects / cleanup:** sandbox `tool-test/impeccable-probe/` (1 file) created and deleted; `.impeccable/` verified unchanged (only pre-existing `design.json`); no background processes; working tree otherwise clean.

**Follow-up status updates:**
- Prior recommendation #4 (detect timeout): **still open** — full-repo detect times out at 60 s; scoped detect is the usable path.
- Prior recommendation #5 (aesthetics reference TODO): **still open** — template unchanged.
- New: `live` subcommand is inert without `.impeccable/live/config.json`; either document the required config or surface a setup hint.