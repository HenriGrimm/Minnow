# Settings UX review — actionable improvements (2026-11-14)

Compiled from three persona audits of the Settings app, run in the browser against the dev server (`#/app/settings`):

- **Maya**: a novice who is new to local AI and put off by jargon.
- **Jordan**: an intermediate frontend developer who also does design and judges visual consistency.
- **Sam**: an expert ML/platform engineer who works from the keyboard and has low vision.

The **Who** column says which personas hit each issue independently: M = Maya, J = Jordan, S = Sam. Items marked ✔ were confirmed in source while compiling.

Effort: **S** = under half a day, **M** = 1–2 days, **L** = multi-day.


## Status (2026-11-14)

Done: #1–#12, #14–#30, #33–#36, #39–#41, #43, #44. #44 was not a bug: the total already sums the selected items, and the copy now says so.

Partly done:
- **#13:** Context policy, Prior reasoning replay and Web search moved, and "About / About" became "System". Not moved: Default project folder (no better home yet). Not merged: Skills and Skills Library.
- **#31 / #32:** Primary buttons now use the accent, Settings buttons have the `.mn-btn` look, and stray native controls use the accent colour. Not done: retiring the `settings-action-btn` / `settings-switch` classes in favour of `createButton` / `.mn-switch`; that is a refactor across many files. Multi-select checklists (Chat context, Issues) deliberately stay checkboxes.
- **#36:** Badges cover only the settings whose timing is known from code.

Not done (each needs its own design):
- **#37:** per-field reset to default (needs a default for every field).
- **#38:** export/import of preferences.
- **#42:** a UI text-size control separate from zoom.

---

## P0 — Broken or blocking

| # | Item | Who | Effort | Where |
|---|---|---|---|---|
| 1 | **Fix the boot race behind "Minnow could not start in this browser".** The error is `sessionState is not initialized; call loadSessionsFromStorage() first`, thrown from `initComposerReasoningEffort` ✔ (`src/main.ts:357`), plus a matching `issuesState` error in Health. Guard or reorder it after state has loaded. Also change the copy: "check that your browser is up to date" points users at the wrong cause. *Before fixing, check that it reproduces without HMR, since all three reviewers saw reloads from the dirty tree.* | M J S | S | `src/main.ts`, `index.html` boot guard |
| 2 | **Desktop app turns into the phone UI when zoomed or the window is short.** `PHONE_MQ` ✔ includes `(max-width:1024px) and (max-height:540px)`. A 1366×768 laptop at 150% zoom gets `mn-phone`, and Settings renders at 0×0. Gate phone mode on `(pointer: coarse)` or companion ingress, not on viewport alone. | S | S | `src/ui/mobile-layout.ts:1` |
| 3 | **Settings opens to the workspace picker.** In a fresh tab, `#/app/settings` redirects to `#/workspaces`, and the first navigation after picking a workspace lands on Code. Most settings are global, so let Settings open without a workspace. | M S | M | `src/os/router.ts` route guard |

## P1 — Major: the core tasks fail or cause confusion

### Search (all three personas hit this hardest)
| # | Item | Who | Effort |
|---|---|---|---|
| 4 | **Build the index from rendered labels and headings, and add a test that every settings `<label>` and `h3` can be found.** Misses today include font size, tab size, context window, compaction, base url, endpoint, reduce motion, secrets and encryption, although all of these are visible on the pages. | M J S | M |
| 5 | **Add synonyms** for these query families: *font size / text size / zoom*; *openai / anthropic / api key / token*; *ctx / n_ctx / context window*; *base url / endpoint / proxy*; *funnel / tailnet / lan / 9480*; *privacy / telemetry / offline*; *wsl*; *shortcut / keybinding*. | M J S | S |
| 6 | **Fix misfiled catalog areas.** `general.toolCalls.constrained` ✔ is filed under `general` but lives in Tools. Check `general.chat.terminal` and Hardware acceleration too (Electron-only, so hide them in a browser session). | J S | S |
| 7 | **Clean up results:** remove duplicate targets (MCP servers ×2, Language servers ×2, Notifications ×2, Devices ×2). Use whole-token or prefix matching for queries of 3 characters or fewer, so "lan" doesn't return Language servers and "gh" doesn't return Theme mode. Fix "AI and agents › AI and agents". Give Models-app hits a section path. | M J S | S |
| 8 | **When a result is chosen,** scroll to the target reliably (Maya saw `scrollTop` stay 0), move focus to the target control, flash its row, and announce "Opened X in Y". | M S | S |
| 9 | **Turn the empty state into a next step:** link to search in the Models app, and offer suggestions. | M | S |

### Navigation and information architecture
| # | Item | Who | Effort |
|---|---|---|---|
| 10 | **Write the section into the URL on every nav click** (`replaceState` or `pushState` to `hashForRoute({appId:'settings', settingsSection})`). Today sections can't be bookmarked, Back doesn't work, and reload lands on the wrong section. | M S | S |
| 11 | **Bring provider and default-model setup into Settings.** Add a summary card with the active provider, its live status in words ("LM Studio · Connected · 3 models" or "Not reachable"), the default model, and a "Manage in Models" link. Mark that link as leaving Settings (`aria-describedby`, not just a "↗" glyph). Use one term: *Models and connections* vs *Models & connections* vs *provider*. | M J | M |
| 12 | **Remove the duplicate permission picker.** It appears in full under both Agents and permissions and Data and privacy › Access. Keep it in one place; Access keeps the sandbox and links back. | M J | S |
| 13 | **Move misfiled settings:** Context policy → Chat context; Prior reasoning replay → Chat context; Web search → beside Tools; Default project folder → Code and workspace. Merge Skills and Skills Library into one page with *Installed* and *Browse* tabs. Rename the "About / About" breadcrumb. | J | M |
| 14 | **Narrow width (≤600px container):** use a drill-down list → detail layout with the existing `.settings-phone-bar`, through `@container`. Today it's two nested scrollers, and the nav takes about 40% of the height. Keep switches trailing on the title line. | J | M |

### Privacy and security clarity
| # | Item | Who | Effort |
|---|---|---|---|
| 15 | **Add a plain-language Privacy summary** at the top of Data and privacy. It says what stays local and what contacts the internet (cloud providers, web search, Google Fonts on selection, updates, GitHub). State the telemetry position. Index it under privacy, telemetry, offline and tracking. | M | S |
| 16 | **Devices → Anywhere:** before enabling, state that this creates a *public internet address via Tailscale Funnel* (only paired devices can sign in). Offer *tailnet-only* up front instead of after setup is ready. | S | S |
| 17 | **Security summary card** in Access: permission level, sandbox state, network listeners (loopback, LAN :9480, Tailscale/Funnel) and paired devices, all in one view. Also add a warning style to the *Full access* option. | M S | M |
| 18 | **Audio asks for the microphone as soon as the page opens.** Enumerate devices only after the user clicks "Show device names / Refresh", and explain why first. | M J | S |

### Accessibility
| # | Item | Who | Effort |
|---|---|---|---|
| 19 | **Unlabelled inputs:** in Add custom language server, give each `<label>` a `for` and each input an id (today they're named only by placeholder). Label the input in the Add custom skill prompt and tie its instructions to it with `aria-describedby`. Name the file inputs on Appearance and Agent packs. | S | S |
| 20 | **Give buttons and summaries specific names:** 50× "Edit SKILL.md" → "Edit /ask SKILL.md". The MCP "Refresh tools/connection" buttons need the server name. Devices "Rename/Disconnect/Try again/Turn off" need the device or feature. Make the Devices "Problem" pill a `role=status`. | S | S |
| 21 | **Manage focus on section change:** after a nav or cross-link jump, focus the new section's h2 (`tabindex=-1`); today focus drops to `BODY`. Add roving tabindex with arrow keys to the nav, or a "Skip to settings content" link, to save about 22 Tab stops. | S | S |
| 22 | **Heading structure:** add an `h1` "Settings" (it can be visually hidden). In Agents and permissions, make the nested groups h4 (today it's flat h3s, with "Boards" twice). | S | S |

## P2 — Copy and consistency sweep

| # | Item | Who | Effort |
|---|---|---|---|
| 23 | **Stale cross-references and names.** Replace them with real links that go through the settings navigator, so names can't drift again. <ul><li>"Settings → Agents → Context policy" (Tools)</li><li>"under Sub-agents" (Timeouts; the page is Sub-agent limits)</li><li>"Mode and agent prompts live under Agents" (Rules)</li><li>"Data & privacy → Agent shell sandbox" (Autopilot)</li><li>"Scheduler runs / reminders / jobs" (now Automations)</li><li>"Global permission mode" (now Permission level)</li><li>"Slash commands that replace the old modes"</li><li>"(today's default)"</li></ul> | M J S | S |
| 24 | **Factually wrong copy:** <ul><li>The Browser page mentions an "allowlist" ✔ (`settings-browser.ts:79`); no allowlist exists.</li><li>The Webhooks summary says "Trigger jobs from outside Minnow" ✔ (`settings-graphite.ts:30`), but webhooks are outgoing.</li><li>Updates shows "You're up to date" next to "available in the installed app".</li><li>Tools shows "Open or restart the app" while the server is running.</li><li>Access says "Require is not available on Windows", but Require isn't offered.</li><li>Tavily shows "55 / Unavailable credits".</li></ul> | M J S | S |
| 25 | **Replace raw errors with plain language, with details in a disclosure:** `listen EACCES … 127.0.0.1:53165` (MCP; explain the Windows excluded port range); "Port 9480 is in use" (mention `MINNOW_LAN_PORT` or add a port field). | M J S | S |
| 26 | **Hide dev and legacy UI:** <ul><li>The "Completion diagnostics (dev / MINNOW_DEBUG only)" block, unless debug is on.</li><li>"Legacy task-chat provisioning controls".</li><li>On Windows, MTPLX (Apple Silicon) in the Servers list.</li><li>Mentions of the hidden Deep Research app.</li><li>`docker-desktop` WSL distros as a default shell.</li></ul> | M J S | S |
| 27 | **Appearance preview:** replace the dev-jargon sample ("Wired the renderer gate to decidePermission…") with neutral text. | M | S |
| 28 | **Language servers status:** one state per row (today: "Disabled in settings … ENABLED"); fix the doubled version prefix "vv0.23.0". | M | S |
| 29 | **Plain-English subtitles for expert pages** (MCP: "Add extra tools for your AI from other apps"). Group or badge Advanced pages: Autopilot, Timeouts, Servers, Webhooks, Language servers. Cut the three stacked intro lines (breadcrumb + summary + lead) down to one. | M J | M |
| 30 | **Casing, badges and dates:** "External Connections" → sentence case; "Built-In" vs "Built-in" and 10px vs 11px badges → one badge component; three date formats → one relative-plus-absolute formatter. | J | S |

## P2 — Design-system conformance

| # | Item | Who | Effort |
|---|---|---|---|
| 31 | **One button system.** Use `createButton()` / `createIconButton()` and retire `settings-action-btn`, `settings-inline-btn`, `updates-button` and `diagnostics-filter-btn`. Primary = `--mn-accent` fill, **one per region**; today it's near-white, Devices shows three primaries at once, and "Run setup again" is primary. | J | M |
| 32 | **One switch.** Merge `.settings-switch` into `.mn-switch`, and replace the stray native checkboxes (Chat context ×8, Issues ×16, "Show modified only") with it. Replace the native range (Surface tint) and the native radios (Chat view, DevTools dock) with a styled range and `.mn-segmented`. | J | M |
| 33 | **Snap to tokens:** 11.5 / 12.5 / 13.5px font sizes → `--mn-type-*` (in `settings-graphite.css`, `settings-appearance.css`, `settings-backup.css`, `settings-devices.css`); 7px and 8px radii → `--mn-radius-sm`. Use one row-title size and one hint size across pages. | J | S |
| 34 | **Row layout:** use `grid-template-columns: 1fr auto` so every trailing control shares one right edge (today Appearance's edges are 560 / 850 / 773 / 744). Pick card or flat for row groups and use it everywhere (DESIGN.md: borders, not cards). Fix the full-width "Reset fonts" button. | J | S |
| 35 | **Low-vision hierarchy:** group titles are 12px at 5.18:1, smaller and dimmer than the 12.5px leads at 7.25:1 below them. Make titles ≥13px in the primary text token. | S | S |

## P3 — Power-user gaps and polish

| # | Item | Who | Effort |
|---|---|---|---|
| 36 | **Scope and apply badges per row** ("Live", "Next turn", "Restart", "This workspace"), driven from the catalog. Today only some sections state this. | S | M |
| 37 | **Per-field "Reset to default"** shown when a value differs from its default. Use one page-level "filter modified + reset" pattern everywhere, or remove it from Notifications. | J S | M |
| 38 | **Export and import preferences** as JSON with no secrets, separate from a full `.mnbak` backup. | S | M |
| 39 | **Keyboard shortcuts page** (read-only at minimum), findable by shortcut, keybinding and hotkey. | J S | M |
| 40 | **Skills page:** add a filter box; about 50 cards means 100+ Tab stops. | S | S |
| 41 | **MCP server details:** transport, command or URL, tool count, and an "Open mcp.json" action. | S | M |
| 42 | **Interface size:** add a real UI text-size control in Electron (it's independent of the zoom problem in #2), or remove the group, which today holds only a hint. | M J S | M |
| 43 | **Loading states:** About shows an empty header for more than 1.2s; add a skeleton. | M | S |
| 44 | **Backups size estimate:** "About 41.6 KB" equals only the key line, while Chats is 1.8 GB. Check that the estimate sums the selected categories. *(Needs confirmation.)* | M | S |

---

## Suggested sequencing

1. **Quick wins first, about 1–2 days:** #1, #2, #6, #10, #12, #16, #18, #19–#22, #23–#28.
2. **Search overhaul:** #4, #5, #7, #8, #9. This was the single most-cited pain across all three personas.
3. **Core setup and privacy:** #11, #15, #17.
4. **Design-system pass:** #31–#35, then #14 (narrow layout) and #13 (IA moves).
5. **Power-user features:** #36–#44.
