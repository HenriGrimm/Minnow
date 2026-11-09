---
name: graphite-workspace-redesign
overview: Convert the Graphite design canvas into Minnow's Code app. The work covers the theme families with a Color intensity setting, Minnow's Uicons, a composer held to its current spec with a tighter shadow, a thread card popover, two surface panels that replace the tabbed right pane and the terminal panel: a side panel and a bottom panel that can be open together, each with its own tabs, plus per-thread memory, move between panels, maximize and letter keys, a cleaner source control surface, transcript links into surfaces, and a parity gate so no current Minnow feature is lost.
todos:
  - id: W1-A
    content: "Wave 1: Theme families, Color intensity and Graphite tokens"
    status: pending
  - id: W1-B
    content: "Wave 1: Icon names for every Graphite glyph"
    status: pending
  - id: W1-C
    content: "Wave 1: Parity guard test (ids, shortcuts, commands)"
    status: pending
  - id: W2-A
    content: "Wave 2: Composer to spec with the composer shadow token"
    status: pending
  - id: W2-B
    content: "Wave 2: Appearance settings (theme grid, Color, accent)"
    status: pending
  - id: W2-C
    content: "Wave 2: Open-in-app server route and app logos"
    status: pending
  - id: W3-A
    content: "Wave 3: Surface registry and per-thread surface state"
    status: pending
  - id: W3-B
    content: "Wave 3: Side and bottom panels, launchers and resizers"
    status: pending
  - id: W3-C
    content: "Wave 3: Thread header and thread card popover"
    status: pending
  - id: W4-A
    content: "Wave 4: Diff surface (source control cleanup)"
    status: pending
  - id: W4-B
    content: "Wave 4: Terminal, Files and Browser surfaces"
    status: pending
  - id: W4-C
    content: "Wave 4: Agents, Issue and Pull request surfaces"
    status: pending
  - id: W4-D
    content: "Wave 4: Brain, Phone and Side chat surfaces"
    status: pending
  - id: W5-A
    content: "Wave 5: Transcript links into surfaces"
    status: pending
  - id: W5-B
    content: "Wave 5: Command palette, shortcuts sheet and focus order"
    status: pending
  - id: W5-C
    content: "Wave 5: Phone layout for the surface panels"
    status: pending
  - id: W6-A
    content: "Wave 6: Manual, context.md and budgets"
    status: pending
  - id: W6-B
    content: "Wave 6: Full regression pass and sign-off"
    status: pending
isProject: true
---

# Graphite workspace redesign: implementation guide

**Date:** 2026-11-09
**Goal:** Ship the Graphite layout in Minnow's Code app with every feature Minnow has today still reachable, tested and documented.
**Granularity:** medium

## Context

**The design source** is the canvas at https://claude.ai/artifact/2JzcfVNSHbbraMYsQ2ugca (v45). It is private to the owner, so ask them for access. A full export of every board, the stylesheet and the icons is checked in at `design/graphite/` (see its README).

Each board is a live mockup. Read its markup for structure and its `renderVals()` logic for behaviour. Its `graphite.css` holds the reference token values. Treat the canvas as the spec for layout, spacing, copy and interaction. Treat Minnow's code as the spec for data, persistence and tools.

**The user's direction**, settled over several rounds of review:
- Keep Graphite's look, and differentiate Minnow from VS Code-style tools through layout.
- Move thread controls into a thread card in the chat column.
- Replace the fixed tabbed right pane with on-demand surfaces.
- Allow tasteful colour through theme families.
- Use Minnow's real icons.
- Keep copy terse.
- Use subtle motion only: no bounce, overshoot or glow.

**What changes for users:**
- **Right pane and terminal panel → two surface panels.** Today's right pane (file tree, editor tabs, preview, split) and the bottom terminal panel become the **side panel** and the **bottom panel**.
  - Both can be open at once, for example Browser at the side and Terminal at the bottom.
  - Each panel has its own tabs, its own + launcher and its own size.
  - Any tab can move to the other panel, and either panel can be maximized over the thread.
  - Both start closed. Each thread remembers its open surfaces, which panel each one is in, and each panel's active tab.
- **Thread card.** The branch chip in the thread header opens a card (Mod+.) with:
  - the environment;
  - Open in, with app logos;
  - the dev server;
  - branch and worktree;
  - changes, with commit and pull request;
  - model and fork;
  - permission level;
  - issue and goal;
  - pin and archive.
- **Theme families.** Swamp, Ocean, Desert, Coral and Mono already exist as `data-theme` palettes. They gain a Color intensity setting (Off / Subtle / Rich) that tints the surfaces.
- **Composer.** It keeps today's metrics (46px field, 14/16/4 padding, 16px radius). Its large drop shadow becomes a short, mode-aware shadow token.

**Constraints:**
- **Nothing may disappear.** Use the parity matrix below as the contract. Every row must name a home and a regression test before its task closes.
- **DOM ids stay.** Tests and code query ids from `index.html` (`#msgInput`, `#sendBtn`, `#btnTerminal`, `#terminalPanel`, `#previewPane`, `#fileViewerPane` and others). Move elements into new containers, but do not rename or delete their ids. If an id must go, the same PR updates every test that uses it and states why.
- **Hidden apps stay hidden.** Compare, Bench, Experts and Research keep `releaseState: 'hidden'`, and no surface or menu may link to them.
- **Tokens.** Application CSS uses `--mn-*` tokens. Hex and rgba literals live only in `src/styles/tokens.css`. The one exception is the third-party app logos in W2-C, which keep their brand colours inside the SVG sprite.
- **Overlays.** Every new popover, menu or dialog root calls `markPreviewOccluder` from `src/ui/preview-occlusion.ts`, so the native preview guest pauses underneath it.

## Reading the canvas

| Board | What it specifies | Task |
|-------|-------------------|------|
| Main (thread views) | Header, transcript, composer, side and bottom panels | W2-A, W3-B, W3-C, W5-A |
| ThreadCard | Thread card popover, every row | W3-C |
| Surfaces / BottomDock (two panels) | Tabs, launchers, move, maximize, resizers | W3-B |
| Changes | Diff surface and source control | W4-A |
| PullRequest | Pull request surface | W4-C |
| SideChat | Side chat surface | W4-D |
| Appearance, ThemeOcean, ThemeDesert | Theme grid, Color, accent | W1-A, W2-B |
| Composer | Composer spec and states | W2-A |
| Mobile, Phones | Phone layout | W5-C |
| Command, Capture, Fork, Resume, Goal, Recovery, IssueProjects | Flows that keep today's behaviour with the new chrome | W5-B, W6-B |

The canvas state strings name exact screens: `thread:gating:card`, `thread:gating:launch[:bottom]`, `thread:<id>:<surface>[+<surface>][:bottom|:right|:full]`, for example `thread:gating:preview+terminal` for both panels. Use them when comparing a build against the design.

## Design spec (values to copy)

- **Panel layout:** a CSS grid over the thread area.
  - Columns are `minmax(0, 1fr)` plus the side panel width when it is open. Rows are `minmax(0, 1fr)` plus the bottom panel height when it is open.
  - The side panel spans the full height (`grid-area: 1 / 2 / -1 / 3`). The bottom panel sits under the chat only (`2 / 1 / 3 / 2`).
  - A maximized panel takes `1 / 1 / 2 / 2`; the chat and the other panel hide until it is restored.
- **Sizes:**
  - Side panel: 440px by default, from 340 to 720.
  - Bottom panel: 320px by default, from 160 to 560.
  - Each panel's resizer sits on its inner edge.
- **Panel header:** 40px.
  - On the left, the tab strip and a + launcher ("Open a surface here").
  - On the right:
    - move, shown only when a tab is active: "Move to bottom panel" or "Move to side panel";
    - maximize or restore;
    - hide.
- **Tabs:** 13px labels with a 14px icon, plus a close button that appears on hover or focus.
- **Placement rules:**
  - Terminal opens in the bottom panel by default, and every other surface opens in the side panel.
  - A surface opened from a panel's launcher goes into that panel.
  - A moved surface remembers its panel for that thread, even after it is closed and reopened.
  - Moving the only tab out of a panel hides that panel.
  - A surface is in at most one panel at a time.
- **Launcher:** each panel has its own.
  - Side panel or a maximized panel: one column, at most 330px wide, centred with `margin: auto` inside a scroll container. The scroll container is what keeps it from overflowing upward.
  - Bottom panel: three columns (`repeat(3, minmax(0, 1fr))`), at most 880px wide, top-aligned, no heading.
  - **Groups:**
    - Diff, Terminal, Files, Browser
    - Agents, Pull request, Issue, Side chat
    - Brain, Phone
  - **Hints:** shown only for diff size, agent count, issue id, pull request number and dev-server port.
  - **Unavailable surfaces:** disabled, with a reason in `title`.
- **Letter keys:** D, T, F, B, A, P, I, S, N, M open the matching surface in the panel whose launcher is showing. When both launchers are showing, they go to the panel used last. They never fire while typing.
- **Global shortcuts:**
  - Mod+J toggles the side panel.
  - Ctrl+` keeps its meaning: it shows Terminal, in whichever panel holds it, or hides that panel when Terminal is already the active tab there.
  - The header has two toggles, "Bottom panel" and "Side panel (⌘J)", each with `aria-pressed`.
  - Mod+. toggles the thread card.
  - Escape closes the top popover first.
  - Mod+J and Mod+. are unused today; check `src/ui/composer-shortcuts.ts` and `src/ui/command-palette.ts` before binding them.
- **Tabs:**
  - Each panel's tab strip is a `tablist` named after its panel; each surface body is a `tabpanel` with an `aria-label`.
  - ArrowLeft and ArrowRight cycle the tabs with wrap-around; Delete or Backspace closes the active tab.
  - Each tab's title includes its key, as in "Diff (D)".
- **Resizers:** a `separator` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`. Arrow keys step 16px, and a double-click resets to the default.
- **Composer:**
  - Card radius 16px, a `--mn-border-strong` border and a `--mn-surface-0` background.
  - Field: min-height 46px, padding `14px 16px 4px`, 14.5px type, line-height 1.55, `field-sizing: content`.
  - Footer padding `8px 8px 8px 10px`.
  - Shadow `var(--mn-composer-shadow)`:
    - dark: `0 1px 2px` at 0.35 alpha plus `0 8px 20px -10px` at 0.6;
    - light: `0 1px 2px` at 0.05 alpha plus `0 6px 16px -8px` at 0.12.
  - Focus ring: `0 0 0 3px var(--mn-accent-soft)` plus the shadow.
  - No slash-command chips under the composer or on the new-thread screen.
- **Thread card:**
  - About 340px wide, a 12px radius, rows 36px high with 14px icons.
  - Open in shows a 15px app logo next to each label (Cursor, VS Code, Finder).
- **Diff surface:**
  - **Header row:** the branch picker (branch name, worktree chip, ahead/behind such as `↑1 ↓2` shown only when non-zero), a refresh button and a more menu (Pull, Push, Merge to main, separator, Open Source Control).
  - **Commit box:** one bordered box (12px radius) holding the borderless message field. Its footer holds, in order:
    - write message (sparkles);
    - review (eye);
    - a scope label ("3 staged" or "All 5 changes", with the full sentence in `title`);
    - "Commit and push" as a ghost button;
    - "Commit" as the primary button (Mod+Enter).
  - **Lists:** flat lists with no boxed sections and no uppercase headers. The header is sentence case, 12px, weight 500, followed by its count, with the bulk action ("Stage all") as a quiet text button.
  - **Rows:** 28px with a 7px radius. Line counts swap for the actions on hover.
  - **Expanded diff:** its own bordered, rounded block.
  - **History:** the same flat header over a timeline.
- **Motion:** opacity and transform only, 120–180ms, ease-out. Reduced motion removes all of it. Never use overshoot, bounce, glow or pulsing shadows.

## Parity matrix

Every row is a feature Minnow ships today. **Home** says where it lives after the redesign. **Guarded by** names the test that must stay green or be added. A row with no test is not done.

| Feature today | Where today | Home after redesign | Guarded by |
|---------------|-------------|---------------------|------------|
| Chat list, groups, pinned, Today and Older | `#chatSidebar`, `src/ui/sidebar.ts` | Unchanged sidebar | `test/ui/sidebar-order.test.mts`, `test/ui/sidebar-pinned-chats.test.mts` |
| Needs you (questions and approvals) | `src/ui/sidebar-needs-you.ts` | Unchanged | Existing sidebar tests plus W1-C id check |
| Working and Archive views, Undo toast | Sidebar footer | Unchanged; Archive is also in the thread card footer | `test/ui/sidebar-archive.test.mts` |
| Chat search | `#btnChatSearch`, `src/ui/chat-search-popover.ts` | Header search button | W1-C id check |
| Branch or worktree switcher | `#sidebarBranch`, `src/ui/git-checkout-picker.ts` | Thread card branch row and the Diff surface picker | `test/ui/git-panel-branch-sync.test.mts` |
| Code views (Chats, Dev servers, Code map, Orchestrate, Files) | `#codeViews` | Unchanged nav; Files also opens the Files surface | W1-C id check |
| Composer: permission pill | `#composerPermissionAnchor` | Same place in the composer footer, and the thread card Permissions row | `test/ui/composer-*.test.mts` plus W1-C |
| Composer: thinking and reasoning effort | `#composerThinkingWrap`, `#composerReasoningEffortSelect` | Unchanged | `test/ui/composer-reasoning-effort.test.mts`, `composer-thinking.test.mts` |
| Composer: context documents, code map, brain notes | Composer settings gear | Unchanged (gear "This turn" page) | `composer-context-documents.test.mts`, `composer-code-map.test.mts`, `composer-brain-notes.test.mts` |
| Context ring | `#contextUsageRing` | Unchanged | W1-C id check |
| Orchestrate plan strip, work agent | `#orchestratePlanSelect`, `#workAgentSelect` | Unchanged | W1-C id check |
| Model trigger, Mod+M | `src/ui/composer-model-trigger.ts` | Unchanged; also the thread card Model row | `composer-model-trigger.test.mts`, `composer-model-select-shortcut.test.mts` |
| Board view toggle | `#btnViewModeToggleBoard` | Unchanged | W1-C id check |
| Mic, expander, send, stop, steer, queue | `#sendBtn`, `src/ui/composer-*.ts` | Unchanged | `composer-send.test.mjs`, `composer-steer.test.mjs`, `composer-message-queue.test.mjs`, `composer-voice.test.mts`, `composer-expand.test.mts` |
| Prompt history, follow-up suggestion, drafts, paste, drop | `src/ui/composer-*.ts` | Unchanged | `composer-prompt-history*.test.mts`, `composer-followup-suggestion.test.mts`, `composer-draft.test.mts`, `composer-paste.test.mts`, `composer-drop.test.mts` |
| Slash skill picker (/ at start) | `src/ui/slash-menu-commands.ts` | Unchanged; no chips added | Existing skill picker tests |
| Run status above composer | `#composerRunStatus` | Unchanged | W1-C id check |
| Inference metrics strip | `#btnStats`, `src/ui/stats.ts` | Metrics line under the composer, expandable | `test/ui/stats-split-layout.test.mjs`, `stats-strip-last-stats.test.mts` |
| Terminal panel: agent runs, shell tabs, stop, clear, expand, hide, Ctrl+` | `#terminalPanel`, `src/ui/terminal-panel.ts` | Terminal surface (T), in the bottom panel by default; Expand maximizes, Hide hides its panel; Ctrl+` toggles it | `test/ui/terminal-*.test.mts` |
| File tree, filter, refresh | `#fileSidebar` | Files surface (F) | `test/ui/file-sidebar-toggle.test.mjs`, `file-tree-activity.test.mts` |
| Editor tabs, save, intent mode, split right | `#fileViewerPane`, `src/ui/file-viewer*.ts` | Files surface; split stays inside it | `file-viewer-recent.test.mts`, `right-pane-split.test.mts` |
| Preview and terminal visible together | Right pane plus terminal panel | Browser in the side panel and Terminal in the bottom panel, both open | `test/ui/surfaces-column.test.mts` |
| Secondary file viewer and preview | `#fileViewerPaneSecondary`, `#previewPaneSecondary` | Split inside the Files and Browser surfaces | `test/ui/preview-secondary-slot.test.mts` |
| Preview browser: back, forward, reload, history, menu, design mode, annotations, DevTools, full width | `#previewPane`, `src/ui/preview-panel.ts` | Browser surface (B), side panel by default; full width maps to maximize | `test/ui/preview-*.test.mts` |
| Agent Browser viewer | `#btnAgentBrowserViewer` | Browser surface menu | W1-C id check |
| Git panel: stage, unstage, discard, commit, generate message, review, push, pull, history | `#btnGitPanelToggle`, `src/ui/git-panel.ts` | Diff surface (D) | `test/ui/git-panel-*.test.mts`, `git-activity-overlay.test.mts` |
| Source Control Center | `scm` app | Unchanged app; Diff surface more menu links to it | Existing SCC tests |
| Issues pane in Code | `#btnIssuesPanelToggle`, `src/ui/issues-sidebar.ts` | Issue surface (I) for the linked issue; full list stays in Issues | `test/ui/issues-sidebar.test.mts` |
| Sub-agent drawer | `src/ui/sub-agent-drawer.ts` | Agents surface (A) | Existing sub-agent tests |
| Activity dropdown | `src/ui/activity-dropdown.ts` | Unchanged menubar | `test/ui/activity-dropdown.test.mts` |
| Toasts and notifications | `src/ui/toast.ts` | Unchanged; restyled to tokens | `test/ui/toast.test.mjs` |
| Command palette (Mod+Shift+P, Mod+K) | `src/ui/command-palette.ts` | Adds surface, panel and thread-card commands | `test/ui/command-palette.test.mts` |
| Shortcuts sheet (?) | `src/styles/shell-keyboard-help.css` | Adds the new keys | `test/a11y/shell-keyboard-help.test.mts` |
| Capture (issue capture) | `src/ui/issue-capture*.ts` | Header capture button | Existing issue capture tests |
| Reveal in Finder | `src/ui/reveal-in-system-explorer.ts` | Thread card environment row and the Finder entry in Open in | Existing reveal tests |
| Dev servers | `src/ui/dev-server-screen*.ts` | Code view, plus the thread card dev-server row | Existing dev server tests |
| /goal, /loop, /followup, /compact | Slash skills | Unchanged; goal is also a thread card row | Existing engine tests |
| Fork, Replay in new chat, recovery copies | Chat engine | Thread card Model row "Fork…" and the message menu | Existing chat tests |
| Phone access and Devices | Settings → Devices | Unchanged; Phone surface (M) links there | `test/ui/mobile-layout.test.mts` |
| Themes, custom theme, fonts | `src/ui/settings-appearance.ts`, `src/appearance/*` | Appearance page gains the Color setting | `test/appearance/*.test.*`, `test/ui/settings-appearance-fonts.test.mts` |
| Zoom, Ctrl+Tab cycling, focus rail | Shell | Unchanged | Existing shell tests |
| Hidden apps (Compare, Bench, Experts, Research) | `src/os/app-registry.ts` | Still hidden, with no surface links | Existing registry tests |

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `src/styles/tokens.css` | Theme palettes, Graphite surface mixes, `--mn-composer-shadow`, tint levels | MODIFY |
| `src/ui/theme.ts` | Applies `data-theme` and the new `data-tint` | MODIFY |
| `src/appearance/persist.ts` | Persists `appearance.tint` | MODIFY |
| `src/ui/settings-appearance.ts` | Theme grid, Color segment, accent | MODIFY |
| `src/ui/icon.ts` | Semantic icon names mapped to `fi-rr-*` | MODIFY |
| `src/styles/icons.css` | App logo sprite sizing (`.mn-app-logo`) | MODIFY |
| `src/styles/input.css` | Composer card shadow and focus ring | MODIFY |
| `index.html` | Side and bottom panel containers, thread header, thread card anchor | MODIFY |
| `src/ui/surfaces/surface-registry.ts` | Surface ids, labels, icons, keys, availability | CREATE |
| `src/ui/surfaces/surface-state.ts` | Per-thread open surfaces, the panel each is in, each panel's active tab, open state, maximize and sizes | CREATE |
| `src/ui/surfaces/surfaces-column.ts` | Side and bottom panels: grid layout, tab strips, launchers, move, maximize, hide, resizers, keyboard | CREATE |
| `src/styles/surfaces.css` | Panel grid, tabs, launchers | CREATE |
| `src/ui/thread-card.ts` | Thread card popover | CREATE |
| `src/styles/thread-card.css` | Thread card styles | CREATE |
| `server/workspace/open-in-app.js` | Opens a workspace path in Cursor, VS Code or Finder | CREATE |
| `src/ui/git-panel.ts` | Diff surface layout | MODIFY |
| `src/styles/git-panel.css` | Flat lists, commit box | MODIFY |
| `src/ui/terminal-panel.ts`, `src/ui/file-viewer.ts`, `src/ui/preview-panel.ts` | Mount into surfaces | MODIFY |
| `src/ui/right-pane-split.ts`, `src/ui/right-pane-split-resize.ts` | Split stays inside Files and Browser | MODIFY |
| `src/ui/sub-agent-drawer.ts`, `src/ui/issues-sidebar.ts` | Agents and Issue surfaces | MODIFY |
| `src/ui/command-palette.ts` | Surface commands | MODIFY |
| `src/ui/mobile-layout.ts` | Phone: surfaces as a sheet | MODIFY |
| `test/ui/graphite-parity.test.mts` | Parity guard | CREATE |

## Wave Breakdown

### Wave 1 — Foundations

#### Task W1-A: Theme families, Color intensity and Graphite tokens
- **Build:**
  - **`src/styles/tokens.css`:**
    - Add `--mn-tint-c` (the palette's tint colour) and `--mn-tint-strength` to every `data-theme` palette (swamp, desert, ocean, coral, mono, each in dark and light).
    - Add `:root[data-tint="none"|"subtle"|"rich"]` rules that set `--mn-tint-strength` to 0%, 4% and 9% in dark and 0%, 3% and 7% in light.
    - Mix the tint into `--mn-surface-0`, `--mn-surface-1` and `--mn-surface-2` with `color-mix(in oklab, var(--mn-tint-c) var(--mn-tint-strength), <base>)`.
    - Add `--mn-composer-shadow` with the dark and light values from the Design spec, plus `--mn-bubble` (user message fill) and `--mn-sel` (selected row fill), copied from the canvas `graphite.css`.
  - **`src/ui/theme.ts`:** add `applyTint(level: 'none' | 'subtle' | 'rich')`. It writes `data-tint` on `document.documentElement`.
  - **`src/appearance/persist.ts`:** persist `appearance.tint` with default `'subtle'`, and apply it during boot before first paint, next to the existing theme application.
- **Test:**
  - Create `test/appearance/tint.test.mts`. Assert that `applyTint('rich')` sets `data-tint="rich"`, that persist round-trips the value, and that an unknown value falls back to `subtle`.
  - Run `npx tsx --import ./test/test-loader.mjs --test test/appearance/*.test.mts` and `npx tsc --noEmit`.
  - `npm run impeccable:detect` reports no new hex literals outside `tokens.css`.
- **Accept:** Switching Color between Off, Subtle and Rich in a running build visibly changes the surface tint for Ocean, Desert and Coral, and leaves Mono neutral.
- **Touches:** `src/styles/tokens.css`, `src/ui/theme.ts`, `src/appearance/persist.ts`, `test/appearance/tint.test.mts`

#### Task W1-B: Icon names for every Graphite glyph
- **Build:**
  - Add semantic names to `ICON_CLASS` in `src/ui/icon.ts` for the glyphs the canvas uses that are missing today:
    - `sidebar`, `sort-alt`, `book-alt`, `stop-circle`, `shield-check`;
    - `lock`, `key`, `bulb`, `pause`, `eye`, `cube`, `thumbtack`, `filter`;
    - `list-timeline`, `keyboard`, `palette`, `tags`, `cursor`, `eject`.
  - Name them by role, following the existing style: for example `surfaceDockBottom` (`sidebar-flip` rotated 90° through a CSS class), `pin`, `review`, `writeMessage`.
  - Every new surface and the thread card pick icons by these semantic names, never by raw `fi-rr-*` classes.
- **Test:** Extend the existing icon test, or create `test/ui/icon-names.test.mts`, to assert that every new name resolves to a class present in `node_modules/@flaticon/flaticon-uicons/css/regular/rounded.css`. Then run `npx tsc --noEmit`.
- **Accept:** Each new semantic name renders a glyph in a running build. No surface uses a hand-drawn SVG icon.
- **Touches:** `src/ui/icon.ts`, `src/styles/icons.css`, `test/ui/icon-names.test.mts`

#### Task W1-C: Parity guard test (ids, shortcuts, commands)
- **Build:**
  - Create `test/ui/graphite-parity.test.mts`. It parses `index.html` with happy-dom and asserts that every id in the parity matrix's "Where today" column still exists:
    - `msgInput`, `sendBtn`, `composerPermissionAnchor`, `composerThinkingWrap`, `composerReasoningEffortSelect`, `contextUsageRing`;
    - `orchestratePlanSelect`, `workAgentSelect`, `btnViewModeToggleBoard`, `btnComposerOverflow`, `composerRunStatus`;
    - `terminalPanel`, `fileSidebar`, `fileViewerPane`, `fileViewerPaneSecondary`, `previewPane`, `previewPaneSecondary`;
    - `btnAgentBrowserViewer`, `btnGitPanelToggle`, `btnIssuesPanelToggle`, `btnTerminal`, `btnStats`;
    - `chatSidebar`, `sidebarBranch`, `btnChatSearch`, `codeViews`.
  - It also asserts that the documented shortcuts in `documentation/manual/reference/keyboard-shortcuts.md` still each have a handler. Import the shortcut tables from `src/ui/composer-shortcuts.ts` and `src/ui/command-palette.ts`.
  - The test is added first and stays green through every later wave.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/graphite-parity.test.mts`. It must pass on `main` before any other task lands, and `npm run test:check-coverage` must pick it up.
- **Accept:** Deleting any listed id from `index.html` makes the parity test fail with that id named.
- **Touches:** `test/ui/graphite-parity.test.mts`

### Wave 2 — Composer, Appearance, Open in

#### Task W2-A: Composer to spec with the composer shadow token
- **Build:**
  - **`src/styles/input.css`:**
    - Replace the `.input-bar` `box-shadow: 0 16px 48px -16px var(--mn-shadow)` with `var(--mn-composer-shadow)`.
    - Replace the focus shadow with `0 0 0 3px var(--mn-accent-soft), var(--mn-composer-shadow)`.
    - Keep `#msgInput` at min-height 46px with padding `14px 16px 4px`.
  - **Composer footer** (`src/styles/composer-controls.css`): use padding `8px 8px 8px 10px`.
  - **Composer rule:** do not add slash-command chips under the composer or on the new-thread welcome (`src/ui/welcome-page.ts`). The `/` picker stays the only entry.
  - **Footer contents:** confirm the footer holds the same controls in the same order as today's `index.html`. Restyle, but do not reorder or drop any.
- **Test:**
  - Run `npx tsx --import ./test/test-loader.mjs --test test/ui/composer-*.test.mts test/ui/welcome-page.test.mjs`.
  - Add an assertion to `test/ui/graphite-parity.test.mts` that `src/styles/input.css` references `--mn-composer-shadow` and contains no `48px` blur on `.input-bar`.
- **Accept:** The idle composer measures 46px of field plus its footer. Its shadow ends within about 12px below the card in both light and dark.
- **Touches:** `src/styles/input.css`, `src/styles/composer-controls.css`, `src/ui/welcome-page.ts`, `test/ui/graphite-parity.test.mts`
- **Depends on:** W1-A, W1-C

#### Task W2-B: Appearance settings (theme grid, Color, accent)
- **Build:**
  - In `src/ui/settings-appearance.ts`, render the theme grid: Graphite, Swamp, Ocean, Desert, Coral, Mono and Custom, each with a preview built from the `settings-theme-preview[data-theme]` tokens.
  - Add a **Color** segmented control (Off / Subtle / Rich) bound to `applyTint` and persisted through `src/appearance/persist.ts`.
  - Keep the existing custom accent and font controls. Copy is one line each: "Color" with the subline "How much the theme tints surfaces".
  - Styles go in `src/styles/settings-appearance.css`.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/settings-appearance-fonts.test.mts test/appearance/*.test.mts`. Add a case asserting that clicking Rich sets `data-tint="rich"` and persists it.
- **Accept:** Settings → Appearance shows the theme grid and the Color control, and a choice survives an app restart.
- **Touches:** `src/ui/settings-appearance.ts`, `src/styles/settings-appearance.css`, `test/ui/settings-appearance-fonts.test.mts`
- **Depends on:** W1-A

#### Task W2-C: Open-in-app server route and app logos
- **Build:**
  - **Route:** create `server/workspace/open-in-app.js`, exposing `POST /api/workspace/open-in-app` with `{ path, app: 'cursor' | 'vscode' | 'finder' }`.
    - Resolve `path` with `server/workspace/safe-path.js`.
    - On macOS, use `open -a Cursor`, `open -a "Visual Studio Code"` or `open -R`.
    - On Windows and Linux, use the `cursor` or `code` CLI when it is on PATH, and reuse `server/workspace/reveal-in-explorer.js` for the file manager.
    - Return `{ ok: false, reason: 'not-installed' }` when the app is missing.
    - Mount the route next to the reveal route.
  - **Logo sprite:** add `src/ui/app-logos.ts`, which exports an inline SVG sprite with `#app-cursor`, `#app-vscode` and `#app-finder`. Copy the paths from the canvas `Main.dc.html` symbols `a-cursor`, `a-vscode` and `a-finder`. The Cursor cube uses `currentColor`, so it follows the theme.
  - **Sizing:** add `.mn-app-logo` (15px) in `src/styles/icons.css`.
  - **Permissions:** run the route through `classifyToolCall` in `src/lib/permissions.mjs` only if an agent tool calls it. The UI route is a user action.
- **Test:**
  - Create `test/workspace/open-in-app.test.mjs`. Stub `child_process.spawn` and assert:
    - the command for each app and platform;
    - that a path outside the workspace is rejected;
    - the `not-installed` reason.
  - Run `node --test test/workspace/open-in-app.test.mjs`.
- **Accept:** In the thread card, choosing VS Code opens the thread's worktree in VS Code, and a missing app shows a toast saying so.
- **Touches:** `server/workspace/open-in-app.js`, `server/workspace/middleware.js`, `src/ui/app-logos.ts`, `test/workspace/open-in-app.test.mjs`
- **Depends on:** W1-B

### Wave 3 — Surfaces and the thread card

#### Task W3-A: Surface registry and per-thread surface state
- **Build:**
  - **Registry** (`src/ui/surfaces/surface-registry.ts`): exports `SURFACES`, an ordered list of `{ id, label, iconName, key, group, available(ctx), hint(ctx), unavailableReason(ctx) }`. The entries:

    | Id | Label | Key |
    |----|-------|-----|
    | `changes` | Diff | D |
    | `terminal` | Terminal | T |
    | `files` | Files | F |
    | `preview` | Browser | B |
    | `agents` | Agents | A |
    | `pr` | Pull request | P |
    | `issue` | Issue | I |
    | `side` | Side chat | S |
    | `brain` | Brain | N |
    | `phone` | Phone | M |

    Groups are `[changes, terminal, files, preview]`, `[agents, pr, issue, side]` and `[brain, phone]`.
  - **State** (`src/ui/surfaces/surface-state.ts`): a per-chat record `{ open: SurfaceId[], panelOf: Record<SurfaceId, 'side' | 'bottom'>, side: { shown, active }, bottom: { shown, active }, maximized: '' | 'side' | 'bottom' }`, plus app-wide `sizes: { side, bottom }`.
    - It exports `getSurfaceState(chatId)`, `openSurface(chatId, id, panel?)`, `closeSurface(chatId, id)`, `moveSurface(chatId, id, panel)`, `setActive(chatId, panel, id | 'launch')`, `setPanelShown(chatId, panel, shown)`, `toggleMaximize(chatId, panel)`, `toggleTerminal(chatId)` and `setSize(panel, px)`.
    - State persists per chat with the chat's UI state, using the same store as drafts (see `src/ui/composer-draft.ts`).
    - `openSurface` without a panel uses `panelOf[id]`, else the default (Terminal goes to bottom, everything else to side). It shows that panel, activates the surface and clears a maximize held by the other panel.
    - Opening a surface that is already open activates it in its own panel.
    - Closing the active tab activates its neighbour in the same panel. Closing the last tab shows that panel's launcher.
    - `moveSurface` hides the source panel when it becomes empty.
    - Hiding a maximized panel clears the maximize.
- **Test:** Create `test/ui/surface-state.test.mts`. Cover:
  - default placement (Terminal bottom, Browser side);
  - opening into a named panel;
  - move, and that moving the last tab hides the source panel;
  - close and activate order within a panel;
  - maximize, plus restore on opening into the other panel;
  - the Ctrl+` toggle;
  - per-chat isolation and persistence round-trip;
  - that an unavailable surface cannot open.

  The cases mirror the canvas harness: Browser at the side with Terminal at the bottom; F from the bottom launcher lands in the bottom panel; moving Terminal to the side.
- **Accept:** A chat with Browser at the side and Terminal at the bottom restores both panels, their tabs and sizes after switching to another chat and back.
- **Touches:** `src/ui/surfaces/surface-registry.ts`, `src/ui/surfaces/surface-state.ts`, `test/ui/surface-state.test.mts`
- **Depends on:** W1-B

#### Task W3-B: Side and bottom panels, launchers and resizers
- **Build:**
  - **Panels** (`src/ui/surfaces/surfaces-column.ts`, `mountSurfacePanels(host)`): lay the thread area out as the grid in the Design spec, with `#surfaceSide` and `#surfaceBottom` as two `aside` elements, each labelled with its panel name.
    - Each panel renders its 40px header: a `role="tablist"` strip, its + launcher, and move, maximize and hide buttons.
    - Each surface body is a `role="tabpanel"` with an `aria-label`.
    - A surface's existing DOM node is reparented into whichever panel holds it, never cloned, so xterm, CodeMirror and the preview guest keep their state.
  - **Launcher:** one per panel, a `role="menu"` that takes focus when shown and honours the letter keys.
    - Side panel or maximized: one column, `margin: auto` inside an `overflow-y: auto` container.
    - Bottom panel: a three-column grid, top-aligned, no heading. This fixes the overflow seen in the canvas, where a centred list taller than the panel spilled over the tab strip.
  - **Resizers:**
    - Side panel: a vertical `separator` on its left edge, from 340 to 720, default 440. Reuse `src/ui/right-pane-split-resize.ts` patterns.
    - Bottom panel: a horizontal `separator` on its top edge, from 160 to 560, default 320.
    - Both take arrow-key steps and reset on double-click.
  - **`index.html`:** add `#surfaceSide` and `#surfaceBottom`. Move the existing `#fileSidebar`, `#fileViewerPane`, `#previewPane` and `#terminalPanel` under a hidden holder they are reparented from, without renaming them.
  - **Header and shortcuts:** add the "Bottom panel" and "Side panel" toggles to the header. Mod+J toggles the side panel, and Ctrl+` calls `toggleTerminal`.
  - **Overlays:** call `markPreviewOccluder` on each launcher. When the bottom panel opens or resizes, re-measure the preview guest in the side panel.
  - **Styles:** create `src/styles/surfaces.css`.
- **Test:**
  - Create `test/ui/surfaces-column.test.mts` (happy-dom). Assert:
    - both panels start closed for a new chat;
    - Mod+J shows the side launcher with focus on it, and B opens Browser there;
    - Ctrl+` opens Terminal in the bottom panel while Browser stays visible at the side;
    - F from the bottom launcher lands in the bottom panel;
    - ArrowRight wraps within a panel's tabs, and Delete closes the active tab;
    - Move sends the active tab to the other panel;
    - maximize hides the chat and the other panel, and restore brings both back;
    - the bottom resizer's ArrowUp grows it by 16px;
    - the side resizer's ArrowLeft widens it by 16px;
    - the reparented `#terminalPanel` and `#previewPane` nodes are the same objects after a move.
  - Run `test/ui/graphite-parity.test.mts` and `test/ui/right-pane-*.test.mts`.
- **Accept:** In a running build, Browser at the side and Terminal at the bottom are visible together, and an empty bottom panel shows all ten surfaces in three columns with nothing drawn over its tab strip.
- **Touches:** `src/ui/surfaces/surfaces-column.ts`, `src/styles/surfaces.css`, `index.html`, `test/ui/surfaces-column.test.mts`
- **Depends on:** W3-A, W1-C

#### Task W3-C: Thread header and thread card popover
- **Build:**
  - **Header:** title, the branch chip (opens the card, Mod+.), the diff chip (`+N −M`, opens Diff), the surfaces toggle (Mod+J), capture and search. Style it in `src/styles/code-chrome.css`.
  - **Card** (`src/ui/thread-card.ts`, `openThreadCard(anchor, chatId)`): rows in canvas order.
    - **Environment:** "This Mac" with the worktree path and reveal. Its dropdown has "Also on iPhone", a switch bound to the Devices share state.
    - **Open in:** Cursor, VS Code and Finder with logos, calling W2-C.
    - **Dev server:** command, Running/Stopped state, Run/Stop. Reuse `src/ui/hub-dev-server.ts`.
    - **Branch and worktree:** opens the Diff surface with the picker open.
    - **Changes:** "N changed files" with `+/−`, plus "Commit and push" and "Open PR" or "View PR".
    - **Model:** the current model and "Fork…".
    - **Permissions:** a segmented control (Manual / Auto / Full access) writing the chat's level through `src/lib/permissions.mjs` callers.
    - **Issue and Goal:** shown only when present.
    - **Footer:** Pin/Unpin, Archive and a Mod+. hint.
  - **Behaviour:** Escape and an outside click close the card, and focus returns to the chip. Call `markPreviewOccluder` on it.
  - **Styles:** `src/styles/thread-card.css`.
- **Test:**
  - Create `test/ui/thread-card.test.mts`. Assert that every row renders from fixture chat state, that Permissions writes the level, that Archive calls the sidebar archive path with an Undo toast, that Open in posts to `/api/workspace/open-in-app`, and that Escape restores focus.
  - Run `test/ui/sidebar-archive.test.mts` and `test/ui/sidebar-pinned-chats.test.mts`.
- **Accept:** Mod+. on any chat opens the card, and each row performs the same action as its existing control elsewhere in Minnow.
- **Touches:** `src/ui/thread-card.ts`, `src/styles/thread-card.css`, `src/styles/code-chrome.css`, `index.html`, `test/ui/thread-card.test.mts`
- **Depends on:** W2-C, W3-B

### Wave 4 — Surfaces content

#### Task W4-A: Diff surface (source control cleanup)
- **Build:** Restructure `src/ui/git-panel.ts` to the canvas Changes board.
  - **Header row:**
    - the branch picker from `src/ui/git-checkout-picker.ts`, showing ahead/behind inline only when non-zero;
    - refresh;
    - a more menu with Pull, Push, Merge to main and Open Source Control.
  - **Removed:** the separate sync row and the worktree help blurb. The help lives in the manual.
  - **Commit box:** one card holding the borderless message field. Its footer holds, in order:
    - write message;
    - review;
    - the scope label ("N staged" or "All N changes", with the long sentence in `title`);
    - "Commit and push" as a ghost button;
    - "Commit" as the primary button (Mod+Enter).
  - **Lists:** Staged, Changes and History become flat lists with sentence-case 12px headers, a count and a quiet "Stage all" or "Unstage all" button.
    - Rows are 28px with a 7px radius, and line counts swap for the actions on hover or focus.
    - An expanded diff shows in a bordered, rounded block.
  - **Styles:** in `src/styles/git-panel.css`, drop the uppercase `letter-spacing` headers and the boxed section borders.
  - **Unchanged behaviour:** publish, branch sync, the name popover and commit generation status.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/git-panel-*.test.mts test/ui/git-activity-overlay.test.mts`. Update only selectors that moved, never behaviour. Add assertions that the more menu exposes Pull, Push, Merge to main and Open Source Control, and that the scope label reads "All 2 changes" with nothing staged.
- **Accept:** With two unstaged changes, the Diff surface shows the header row, the commit box and one "Changes 2" list. There are no other bars or boxed sections.
- **Touches:** `src/ui/git-panel.ts`, `src/styles/git-panel.css`, `test/ui/git-panel-*.test.mts`
- **Depends on:** W3-B

#### Task W4-B: Terminal, Files and Browser surfaces
- **Build:**
  - Register `terminal`, `files` and `preview` in the surface panels so they mount the existing `src/ui/terminal-panel.ts`, `src/ui/file-viewer.ts` with the file tree, and `src/ui/preview-panel.ts`.
  - **Terminal:** keeps the agent-runs select, shell tabs, Stop and Clear output. Expand maps to maximize its panel, and Hide hides its panel.
  - **Files:** keeps the tree on the left of the surface, then editor tabs, save, intent mode and the secondary split (`src/ui/right-pane-split.ts`).
  - **Browser:** keeps back, forward, reload, history, the browser menu, Design Mode, annotations and DevTools. Its full-width button maps to maximize its panel.
  - **Preview guest:** the native preview pauses while a surface overlay covers it (`src/ui/preview-occlusion.ts`).
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/terminal-*.test.mts test/ui/preview-*.test.mts test/ui/file-viewer-recent.test.mts test/ui/right-pane-split.test.mts test/ui/file-sidebar-toggle.test.mjs`. All pass with selectors updated only for moved containers.
- **Accept:** Every button in today's terminal panel, file viewer and preview pane works from its surface in either panel, and Ctrl+` still toggles the terminal.
- **Touches:** `src/ui/terminal-panel.ts`, `src/ui/file-viewer.ts`, `src/ui/preview-panel.ts`, `src/ui/right-pane-split.ts`, `src/styles/terminal.css`, `src/styles/preview-panel.css`, `src/styles/file-panel.css`
- **Depends on:** W3-B

#### Task W4-C: Agents, Issue and Pull request surfaces
- **Build:**
  - **Agents (A):** mounts `src/ui/sub-agent-drawer.ts` content. It shows the agent list on top, the selected agent's brief as a message from the main agent, then its steps and conversation.
  - **Issue (I):** renders the chat's linked issue: id and status, title, description, "Done when", and an "Open in Issues" link. Use `src/ui/issues-detail.ts` in a read-first layout.
  - **Pull request (P):** shows number and state, a GitHub link and the checks list from the `gh` CLI data the sidebar already uses. Merge is disabled with a one-line reason while checks run or the PR is a draft.
  - **Availability:**
    - Agents is available once the chat has sub-agents.
    - Issue is available once the chat has a linked issue.
    - Pull request is available once a PR exists. Otherwise the launcher greys it with its reason.
- **Test:**
  - Create `test/ui/surface-agents-issue-pr.test.mts`. Use fixture chat state with agents, an issue and a PR, and assert the rendered fields and the disabled-merge reasons.
  - Run the existing sub-agent tests and `test/ui/issues-sidebar.test.mts`.
- **Accept:** A chat with a running sub-agent, a linked issue and an open PR shows all three surfaces with live data, and merge is blocked while checks run.
- **Touches:** `src/ui/sub-agent-drawer.ts`, `src/ui/surfaces/surface-agents.ts`, `src/ui/surfaces/surface-issue.ts`, `src/ui/surfaces/surface-pr.ts`, `test/ui/surface-agents-issue-pr.test.mts`
- **Depends on:** W3-B

#### Task W4-D: Brain, Phone and Side chat surfaces
- **Build:**
  - **Brain (N):** search, a "Related" list for the thread, and "Save to Brain". Reuse `src/ui/chat-brain-capture.ts` and the Brain search API.
  - **Phone (M):** a device card with "Show this thread" and "Notify when it needs me" switches, a test notification button and a Devices link. Respect the opt-in rule: when phone access is off, show only the Devices link.
  - **Side chat (S):** a read-only `/ask` chat, clamped to `read-only` through `decidePermission`, that runs beside the main turn without stopping it. Its header reads "/ask · Read-only. The agent keeps working." and its placeholder reads "Ask about this thread".
- **Test:** Create `test/ui/surface-brain-phone-side.test.mts`. Assert that the side chat sends with the `read-only` clamp and does not cancel the active run, that Phone hides the switches when access is off, and that Save to Brain calls the capture path.
- **Accept:** Asking a side question during a running turn gets an answer while the main run keeps streaming.
- **Touches:** `src/ui/surfaces/surface-brain.ts`, `src/ui/surfaces/surface-phone.ts`, `src/ui/surfaces/surface-side-chat.ts`, `test/ui/surface-brain-phone-side.test.mts`
- **Depends on:** W3-B

### Wave 5 — Wiring and phone

#### Task W5-A: Transcript links into surfaces
- **Build:** In the message and tool-call rendering (`src/ui/messages.ts` and the tool-call row renderer it uses), make step rows clickable:
  - Read or Edited opens Files at that file.
  - Ran opens Terminal at that run.
  - Searched opens Files with the query.
  - Opened PR opens Pull request.
  - The agents card opens Agents.
  - Rows are buttons with an accessible name such as "Open src/ui/stream-status.ts". The visual stays the same as today's rows, with a hover background.
- **Test:** Create `test/ui/transcript-surface-links.test.mts`. Render fixture steps and assert each click calls `openSurface` with the right id and target.
- **Accept:** Clicking a "Read" step in a finished turn opens the Files surface on that file.
- **Touches:** `src/ui/messages.ts`, `test/ui/transcript-surface-links.test.mts`
- **Depends on:** W4-B, W4-C

#### Task W5-B: Command palette, shortcuts sheet and focus order
- **Build:**
  - In `src/ui/command-palette.ts`, add commands:
    - "Open Diff", "Open Terminal", "Open Files", "Open Browser", "Open Agents", "Open Pull request", "Open Issue", "Open Side chat", "Open Brain", "Open Phone";
    - "Toggle side panel", "Toggle bottom panel", "Move tab to other panel", "Maximize panel";
    - "Thread card".
  - Each new command carries aliases ("panel", "inspector", "right pane", "terminal").
  - Add Mod+J (side panel), Ctrl+` (terminal), Mod+. and the surface letter keys to the shortcuts sheet and to `documentation/manual/reference/keyboard-shortcuts.md`.
  - Tab order follows sidebar, header, transcript, composer, then surfaces.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/command-palette.test.mts test/a11y/shell-keyboard-help.test.mts test/a11y/index-html-a11y.test.mts`. Add cases for the new commands and keys.
- **Accept:** Typing "terminal" in the palette offers "Open Terminal", and running it opens the Terminal surface.
- **Touches:** `src/ui/command-palette.ts`, `src/styles/shell-keyboard-help.css`, `documentation/manual/reference/keyboard-shortcuts.md`, `test/ui/command-palette.test.mts`
- **Depends on:** W3-B, W3-C

#### Task W5-C: Phone layout for the surface panels
- **Build:**
  - In `src/ui/mobile-layout.ts` and `src/styles/mobile-app.css`, at phone width the side and bottom panels become a single bottom sheet over the chat, using `src/ui/mobile-drawer-portal.ts`.
  - Both panels collapse into that one sheet, showing one surface at a time with a surface picker. Move and maximize are hidden, and the thread card opens as a full-width sheet.
  - Touch targets are at least 44px.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/mobile-layout.test.mts`. Add cases asserting that the sheet opens from the header, hides move and maximize, and keeps one surface.
- **Accept:** On a phone connected through Devices, opening Diff shows it as a sheet, and closing it returns to the chat.
- **Touches:** `src/ui/mobile-layout.ts`, `src/styles/mobile-app.css`, `test/ui/mobile-layout.test.mts`
- **Depends on:** W4-A, W4-B

### Wave 6 — Docs and regression gate

#### Task W6-A: Manual, context.md and budgets
- **Build:**
  - **`documentation/manual/apps/code.md`:** rewrite "The layout" for the sidebar, the chat with its thread card, and the side and bottom panels, with move, maximize and letter keys. Replace the right-pane and terminal-panel wording.
  - **`documentation/manual/chat/chatting.md`:** update the composer section for the thread card and remove nothing else.
  - **`documentation/manual/apps/settings.md`:** add Color to Appearance.
  - **`documentation/context.md`:** add the surfaces architecture and the open-in route, under "Theme and appearance" and "Major apps".
  - **Copy:** user-facing docs describe only what ships.
  - **Budgets:** after `npm run build`, run `npm run check:performance-budgets`. If a chunk grows past its ceiling, raise `budgets.json` with a rationale in the PR and refresh the baseline.
- **Test:** Run `npm run test:product-wiki`, `npm run build` and `npm run check:performance-budgets`.
- **Accept:** The manual's Code page describes the side panel, bottom panel and thread card, with no mention of the old right pane.
- **Touches:** `documentation/manual/apps/code.md`, `documentation/manual/chat/chatting.md`, `documentation/manual/apps/settings.md`, `documentation/context.md`, `budgets.json`, `scripts/bundle-size-baseline.json`
- **Depends on:** W5-A, W5-B, W5-C

#### Task W6-B: Full regression pass and sign-off
- **Build:**
  - Walk the parity matrix row by row in a running build (`npm start`). For each row, perform the action from its new home and record pass or fail in the PR description.
  - Compare each canvas board against the build at 1440×900 and 390×844, in light and dark, for Graphite, Ocean and Desert with Color set to Rich.
  - Fix any drift in the owning task's files.
- **Test:** Run `npm run test:check-coverage`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run check:performance-budgets` and `npm run impeccable:detect`. Only failures already known on `main` may remain, and the PR lists them.
- **Accept:** Every parity matrix row is marked pass, and CI is green on Windows, Ubuntu and macOS.
- **Touches:** `test/ui/graphite-parity.test.mts`
- **Depends on:** W6-A

## Verification Checklist
- [ ] `test/ui/graphite-parity.test.mts` passes; it lands first and stays green.
- [ ] `npm run test:check-coverage` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm test` passes, except failures already known on `main`, which the PR lists.
- [ ] `npm run build` and `npm run check:performance-budgets` pass.
- [ ] `npm run impeccable:detect` reports no new hex literals outside `src/styles/tokens.css`.
- [ ] Every parity matrix row is checked in a running build.
- [ ] Browser at the side and Terminal at the bottom stay visible together, and the empty bottom panel shows the three-column launcher with nothing over its tab strip.
- [ ] The composer shadow stays within about 12px of the card in light and dark.
- [ ] No slash chips appear under the composer or on the new-thread screen.
- [ ] Hidden apps remain unreachable.

## Notes for Build Agents
- The canvas is the spec for look and behaviour, and Minnow's code is the spec for data. When the two disagree on what data exists, keep Minnow's and flag it in the PR.
- Never rename or delete an `index.html` id that a test or module queries. Move it.
- Use icons by `icon.ts` semantic name. The only non-Uicon marks allowed are the three app logos in `src/ui/app-logos.ts`.
- Motion: opacity and transform only, 120–180ms, ease-out, and none under reduced motion. No bounce, overshoot, glow or animated shadows.
- Copy: short and specific, sentence case, no explanatory filler. Copy labels from the canvas.
- Every popover, menu and sheet root calls `markPreviewOccluder` and restores focus to its trigger on close.
- Permission level is global per chat (Manual / Auto / Full access) through `src/lib/permissions.mjs`. The thread card only changes the chat's level and never adds per-tool settings.
- Side chat uses the `/ask` clamp (`read-only`) and must not stop or steer the main run.
