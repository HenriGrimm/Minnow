---
name: graphite-workspace-redesign
overview: Ship the complete Graphite redesign across the Minnow workspace. Match all 35 canvas boards and their interactive states, retain shipped workflows and data, and require visual, behavioral, upgrade and packaged checks before Graphite becomes the default on main.
todos:
  - id: W0-A
    content: "Wave 0 — Freeze the design reference and establish visual and behavioral baselines"
    status: pending
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
    content: "Wave 5 — Phone workspace, navigation and remote workflows"
    status: pending
  - id: W5-D
    content: "Wave 5 — Workspaces, app navigation, Dashboard and all standalone app boards"
    status: pending
  - id: W5-E
    content: "Wave 5 — Thread states, recovery, issue capture, search and notifications"
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
**Goal.** Ship the complete Graphite workspace with the exact layout, styling, copy and interaction shown in the mockup, with shipped Minnow workflows still reachable, tested and documented.
**Granularity:** medium

## Context

**Design reference.** [The checked-in Graphite export](../../design/graphite/README.md) pins canvas version `1794261255-4921` and includes the boards, stylesheet, icons and canvas notes. The original canvas is private and the export omits its rendering runtime. Authoritative captures from that version are required to verify an exact match.

Use the rendered canvas and `graphite.css` for visual values and the board markup, states and `renderVals()` for interaction. Use Minnow's code for data, persistence, permissions and tools. Apply the same rule to empty, loading, error and platform-specific states the prototype does not show. Record those states and any required design decisions in Wave 0, then use approved references for any additions to the pictured states.

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
- **Feature parity.** Extend the parity matrix before implementation. Every shipped action needs a discoverable home and a behavioral check, including when a route or host lacks a capability.
- **DOM ids stay.** Tests and code query ids from `index.html` (`#msgInput`, `#sendBtn`, `#btnTerminal`, `#terminalPanel`, `#previewPane`, `#fileViewerPane` and others). Move elements into new containers, but do not rename or delete their ids. If an id must go, the same PR updates every test that uses it and states why.
- **Hidden apps stay hidden.** Compare, Bench, Experts and Research keep `releaseState: 'hidden'`, and no surface or menu may link to them.
- **Tokens.** Application CSS uses `--mn-*` tokens. Hex and rgba literals live only in `src/styles/tokens.css`. The one exception is the third-party app logos in W2-C, which keep their brand colours inside the SVG sprite.
- **Overlays.** Every new popover, menu or dialog root calls `markPreviewOccluder` from `src/ui/preview-occlusion.ts`, so the native preview guest pauses underneath it.

## Review findings

The `Graphite` branch and local `main` both pointed to `62280aea9` at review time. That commit adds the design export and original guide. The running product still uses the existing Code layout. Local baseline checks passed for test discovery, TypeScript and 126 focused checks for theme and boot, mobile layout, native preview occlusion and the right-pane split. Visual parity requires rendered reference captures.

| Priority | Finding | Required resolution |
|---|---|---|
| Merge blocker | The original Code-focused tasks left full-app, workspace, notification and phone boards without implementation ownership. | Give all 35 boards an owning task and verify the navigation between them. |
| Merge blocker | Several draft prescriptions differ from the canvas. These include the Appearance family list and tint formulas, the same-surface launcher behavior, the tab close affordance and parts of the responsive layout. | Resolve against the pinned canvas before implementation. Use the exact visible result and interaction. Record required accessibility, capability or safety adjustments in the reference. |
| Merge blocker | Files and Browser currently share two split groups and slot-owned tabs. Matching DOM IDs and moving nodes does not demonstrate mixed split, editor or native guest continuity. | Preserve mixed and same-type splits and the live instances during moves, and test real Electron guest bounds, focus and session continuity. |
| Merge blocker | Thread card and launcher actions cross Git worktree, phone access, permissions and concurrent generation boundaries. Several prototype callbacks use fixture data. | Route actions to authoritative services using the captured chat and workspace context. Test denial, unavailability, partial failure and stale targets. |
| Merge blocker | The original visual check relied on a final walkthrough and used two viewport sizes for boards authored at several sizes. Static ID checks do not show action reachability. | Establish deterministic board-by-board comparison and behavioral journeys in Wave 0. Run them throughout the implementation. |

## Board coverage

Every entry in [the canvas board order](../../design/graphite/project/canvas.json) has an owning task below. Track reachable states within each board as part of that task, including app subsections and interactions beyond the board's starting state.

| Boards | Owner | Production scope |
|---|---|---|
| Main | W3-B, W3-C, W5-D, W5-E | Desktop shell, project navigation, thread list, thread layout, Dashboard and inset app views |
| Workspaces | W5-D | Choose, create, clone, reopen and switch workspaces, with dev-server status and real progress/errors |
| Approval, NewThread, Archive, Search, Capture, Goal, Recovery, Fork, Resume | W5-E | Thread lifecycle, approval, recovery, issue capture and transcript states |
| Command, Shortcuts | W5-B | Command menu, search/shortcut routing, keyboard help and focus |
| ThreadCard | W3-C | Workspace, Git, model, permission and lifecycle actions |
| Surfaces, BottomDock | W3-B | Both launchers, tab states, movement, resize, maximize and restore |
| Changes | W4-A | Inline Diff and safe Git actions |
| Preview | W4-B | Dev servers, embedded browser, Design Mode, Agent Browser and native/iframe paths |
| PullRequest | W4-C | Live PR, checks and safe merge affordance |
| SideChat | W4-D | Independent read-only side conversation |
| Composer | W2-A | Thread, new-thread and phone variants, including model menu |
| Appearance, ThemeOcean, ThemeDesert | W1-A, W2-B | Exact theme palette, Color, accent and persistence |
| Issues, IssueProjects | W5-D | Lists, details, projects and linked chat handoffs |
| SourceControl, Models, Boards, Brain, Scheduler, Settings | W5-D | Full app navigation, tabs, sections and real actions |
| Notify | W5-E | Desktop, board and phone notification variants and Activity |
| Mobile, Phones | W5-C | Full phone navigation and each individual 390×844 screen shown in the phone sheet |

The canvas state strings name exact screens: `thread:gating:card`, `thread:gating:launch[:bottom]`, `thread:<id>:<surface>[+<surface>][:bottom|:right|:full]`, for example `thread:gating:preview+terminal` for both panels. Use them when comparing a build against the design.

## Delivery sequence

Wave 0 establishes the acceptance contract. Waves 1–2 build shared visual primitives. Waves 3–4 deliver Code as a vertical slice. Wave 5 completes app coverage, thread flows and phones against those primitives. Wave 6 validates the integrated release candidate. Land independently safe prerequisites through normal PRs. Keep unfinished Graphite UI behind one temporary opt-in while slices integrate, with a single default cutover after all gates pass. Preserve the existing routes and persisted data so the cutover can be reverted without reversing a storage migration.

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
- **Tabs:** Match the canvas label and icon sizes. The close button is visible on the active tab and appears on hover or keyboard focus for inactive tabs.
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
| Chat search | `#btnChatSearch`, `src/ui/chat-search-popover.ts` | **Mod+F** and the **Search chats** command | `test/ui/shell-commands.test.mts` |
| Branch or worktree switcher | `#sidebarBranch`, `src/ui/git-checkout-picker.ts` | Thread card branch row and the Diff surface picker | `test/ui/git-panel-branch-sync.test.mts` |
| Code views (Chats, Dev servers, Code map, Orchestrate, Files) | `#codeViews` | Unchanged nav; Files also opens the Files surface | W1-C id check |
| Workspace chooser and switcher, first-run setup, recents and new windows | Workspace picker, onboarding, shell router | Graphite chooser and project switcher | W5-D workspace and packaged window journeys |
| Dashboard, released app routes and plugin panels | `src/os/app-registry.ts`, `src/os/router.ts` | Inset app views and Graphite sidebar | W5-D released route and plugin coverage |
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
| Mixed file/browser split and tab moves | `src/ui/right-pane-slot-tabs.ts` | Files and Browser split controls | Existing split suites and W4-B packaged live-instance journey |
| Preview and terminal visible together | Right pane plus terminal panel | Browser in the side panel and Terminal in the bottom panel, both open | `test/ui/surfaces-column.test.mts` |
| Secondary file viewer and preview | `#fileViewerPaneSecondary`, `#previewPaneSecondary` | Split inside the Files and Browser surfaces | `test/ui/preview-secondary-slot.test.mts` |
| Preview browser: back, forward, reload, history, menu, design mode, annotations, DevTools, full width | `#previewPane`, `src/ui/preview-panel.ts` | Browser surface (B), side panel by default; full width maps to maximize | `test/ui/preview-*.test.mts` |
| Agent Browser viewer | `#btnAgentBrowserViewer` | Browser surface menu | W1-C id check |
| Git panel: stage, unstage, discard, commit, generate message, review, push, pull, history | `#btnGitPanelToggle`, `src/ui/git-panel.ts` | Diff surface (D) | `test/ui/git-panel-*.test.mts`, `git-activity-overlay.test.mts` |
| Git conflict recovery, PR merge checks and partial push failure | Diff and Source Control actions | Diff, Pull request and Source Control | Existing recovery suites plus W4-A and W4-C worktree cases |
| Source Control Center | `scm` app | Unchanged app; Diff surface more menu links to it | Existing SCC tests |
| Issues pane in Code | `#btnIssuesPanelToggle`, `src/ui/issues-sidebar.ts` | Issue surface (I) for the linked issue; full list stays in Issues | `test/ui/issues-sidebar.test.mts` |
| Sub-agent drawer | `src/ui/sub-agent-drawer.ts` | Agents surface (A) | Existing sub-agent tests |
| Activity dropdown | `src/ui/activity-dropdown.ts` | Unchanged menubar | `test/ui/activity-dropdown.test.mts` |
| Toasts and notifications | `src/ui/toast.ts` | Unchanged; restyled to tokens | `test/ui/toast.test.mjs` |
| Notification actions, Activity and acknowledgement | `src/notifications/`, shell menu | Graphite alerts and Activity | Existing notification suites and W5-E route/acknowledgement journey |
| Command palette (Mod+Shift+P, Mod+K) | `src/ui/command-palette.ts` | Adds surface, panel and thread-card commands | `test/ui/command-palette.test.mts` |
| Shortcuts sheet (?) | `src/styles/shell-keyboard-help.css` | Adds the new keys | `test/a11y/shell-keyboard-help.test.mts` |
| Capture (issue capture) | `src/ui/issue-capture*.ts` | Header capture button | Existing issue capture tests |
| Reveal in Finder | `src/ui/reveal-in-system-explorer.ts` | Thread card environment row and the Finder entry in Open in | Existing reveal tests |
| Dev servers | `src/ui/dev-server-screen*.ts` | Code view, plus the thread card dev-server row | Existing dev server tests |
| /goal, /loop, /followup, /compact | Slash skills | Unchanged; goal is also a thread card row | Existing engine tests |
| Fork, Replay in new chat, recovery copies | Chat engine | Thread card Model row "Fork…" and the message menu | Existing chat tests |
| Phone access and Devices | Settings → Devices | Unchanged; Phone surface (M) links there | `test/ui/mobile-layout.test.mts` |
| Paired phone follows a host turn and uses supported approvals | Companion and Devices | Graphite phone thread and drawer | Companion/remote suites and W5-C device journey |
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

### Wave 0 — Reference and test baseline

#### Task W0-A — Freeze the reference and establish visual and behavioral baselines

- Obtain rendered reference captures from the pinned canvas version. Inventory every board and all reachable states from `canvas.json`, the component options and the interaction paths. For each case, record the board and state, viewport, theme, scale, data fixture, inputs, expected outcome and owning task. Capture the actual board content, excluding the design canvas and the decorative phone frames.
- Use the authored sizes of 1440×900, 1168×836, 760×560 and 390×844. Capture the individual phone screens at 390×844. Include light/dark, default Graphite, Ocean/Rich, Desert/light/Subtle and Human/Subtle as authored. Use a separate matrix for all supported themes and tint levels, responsive breakpoints, narrower windows, zoom and mobile keyboard. Add approved reference states for shipped controls that lack a board.
- Run the app with an isolated Minnow home, a disposable Git repository and worktree, and deterministic providers and tool responses. Seed the mockup's rows, copy, line breaks, counters and runtime states through the app's normal data paths. Freeze clock, relative times, animations at named phases, fonts, viewport and device scale. Wait for fonts, data and geometry before capture.
- Compare the production UI to the canvas on the same pinned renderer. Assert exact visible copy, typography, colors, icon assets, geometry and interactive states. Fail on differences in stable pixels. If renderer anti-aliasing or embedded external content needs a mask, record its exact region and justification and review unmasked reference, actual and diff images. Maintain separate approved expectations for genuine OS variations such as window controls and key legends.
- Review prototype, draft guide and current product together. Capture resolutions for typography and icon assets, palette controls, motion and reduced motion, touch/keyboard focus, panel rules and actions that have no backing service or need different host behavior. Preserve existing appearance choices. Where safety, accessibility or shipped parity needs visible differences, record the affected state and obtain design sign-off on its reference before building it.
- Extend the parity matrix and use `npm run index-html:coupling-map` to identify owners before moving DOM. Record baseline test, packaged build and performance results on the PR base. Each workstream adds its visual cases and action tests with the implementation.
- **Accept:** Every board and reachable state has a fixture, an owner, a reference and explicit acceptance steps. Running the same capture twice produces identical stable pixels. Missing references and unapproved visual changes block sign-off.

### Wave 1 — Foundations

#### Task W1-A: Theme families, Color intensity and Graphite tokens
- **Build:**
  - Map the canvas ground, sheet, raised levels, text, selected fill, user bubble, primary button, focus, shadows and semantic colors into `src/styles/tokens.css`. Use the exact per-token mixes from `graphite.css`, including the distinct light/dark formulas and fixed diff, warning and syntax colors.
  - Add Graphite dark/light and the Color setting through `src/theme.ts`, `src/ui/theme.ts`, `src/appearance/persist.ts` and `server/config/appearance.js`. Keep all shipped families, legacy aliases, custom themes, font choices and follow-system behavior. Use Graphite as the clean-profile default, with Subtle color as in the canvas. Preserve saved selections and apply the effective values before first paint.
  - Use the canvas Geist and Geist Mono metrics for the Graphite default. Package the exact font assets and their license for offline use. Keep user font overrides and test layout with both defaults and overrides.
- **Test:**
  - Create `test/appearance/tint.test.mts`. Assert that `applyTint('rich')` sets `data-tint="rich"`, that persist round-trips the value, and that an unknown value falls back to `subtle`.
  - Run `npx tsx --import ./test/test-loader.mjs --test test/appearance/*.test.mts` and `npx tsc --noEmit`.
  - `npm run impeccable:detect` reports no new hex literals outside `tokens.css`.
- **Accept:** Switching Color between Off, Subtle and Rich in a running build visibly changes the surface tint for Ocean, Desert and Coral, and leaves Mono neutral.
- **Touches:** `src/styles/tokens.css`, `src/theme.ts`, `src/ui/theme.ts`, `src/appearance/`, `server/config/appearance.js`, `test/appearance/`
- **Depends on:** W0-A

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
- **Depends on:** W0-A

#### Task W1-C: Parity guard test (ids, shortcuts, commands)
- **Build:**
  - Create `test/ui/graphite-parity.test.mts`. It parses `index.html` with happy-dom and asserts that every id in the parity matrix's "Where today" column still exists:
    - `msgInput`, `sendBtn`, `composerPermissionAnchor`, `composerThinkingWrap`, `composerReasoningEffortSelect`, `contextUsageRing`;
    - `orchestratePlanSelect`, `workAgentSelect`, `btnViewModeToggleBoard`, `btnComposerOverflow`, `composerRunStatus`;
    - `terminalPanel`, `fileSidebar`, `fileViewerPane`, `fileViewerPaneSecondary`, `previewPane`, `previewPaneSecondary`;
    - `btnAgentBrowserViewer`, `btnGitPanelToggle`, `btnIssuesPanelToggle`, `btnTerminal`, `btnStats`;
    - `chatSidebar`, `chatSidebarMain`, `chatList`, `codeViews`.
  - Verify documented shortcuts by dispatching real keyboard events through the registered owners. Include a DOM/route smoke check for reachability and a behavior check for each parity row. Use the ID check to guard wiring.
  - The test is added first and stays green through every later wave.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/graphite-parity.test.mts`. It must pass on `main` before any other task lands, and `npm run test:check-coverage` must pick it up.
- **Accept:** Deleting any listed id from `index.html` makes the parity test fail with that id named.
- **Touches:** `test/ui/graphite-parity.test.mts`
- **Depends on:** W0-A

### Wave 2 — Composer, Appearance, Open in

#### Task W2-A: Composer to spec with the composer shadow token
- **Build:**
  - **`src/styles/input.css`:**
    - Replace the `.input-bar` `box-shadow: 0 16px 48px -16px var(--mn-shadow)` with `var(--mn-composer-shadow)`.
    - Replace the focus shadow with `0 0 0 3px var(--mn-accent-soft), var(--mn-composer-shadow)`.
    - Keep `#msgInput` at min-height 46px with padding `14px 16px 4px`.
  - **Composer footer** (`src/styles/composer-controls.css`): use padding `8px 8px 8px 10px`.
  - **Composer rule:** do not add slash-command chips under the composer or on the new-thread welcome (`src/ui/welcome-page.ts`). The `/` picker stays the only entry.
  - Match the Composer board in thread, new and phone variants. Implement the pictured model menu, control order and idle, running and approval treatments. Keep existing composer actions reachable through their pictured control or its approved overflow home.
- **Test:**
  - Run `npx tsx --import ./test/test-loader.mjs --test test/ui/composer-*.test.mts test/ui/welcome-page.test.mjs`.
  - Add an assertion to `test/ui/graphite-parity.test.mts` that `src/styles/input.css` references `--mn-composer-shadow` and contains no `48px` blur on `.input-bar`.
- **Accept:** The idle composer measures 46px of field plus its footer. Its shadow ends within about 12px below the card in both light and dark.
- **Touches:** `src/styles/input.css`, `src/styles/composer-controls.css`, `src/ui/welcome-page.ts`, `test/ui/graphite-parity.test.mts`
- **Depends on:** W1-A, W1-C

#### Task W2-B: Appearance settings (theme grid, Color, accent)
- **Build:**
  - In `src/ui/settings-appearance.ts`, render the pictured theme grid in canvas order with Graphite, Swamp, Ocean, Desert, Coral, Human, Mint and Mono. Keep Matrix and the custom-theme editor accessible in the approved appearance states. Render previews from the same tokens as the workspace.
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
    - Require authenticated host ingress. Resolve the selected thread's canonical workspace/worktree with the existing server context and validate the path with the runtime safe resolver and realpath containment. Use a fixed allowlist and shell-free argument arrays. Reject remote ingress, traversal, symlink escapes and unregistered paths.
    - On macOS, use `open -a Cursor`, `open -a "Visual Studio Code"` or `open -R`.
    - On Windows and Linux, resolve the installed editor executable using the platform's launch mechanism and reuse `server/workspace/reveal-in-explorer.js` for the file manager. Use the host platform name in place of Finder where appropriate.
    - Return `{ ok: false, reason: 'not-installed' }` when the app is missing.
    - Mount the route next to the reveal route.
  - **Logo sprite:** add `src/ui/app-logos.ts`, which exports an inline SVG sprite with `#app-cursor`, `#app-vscode` and `#app-finder`. Copy the paths from the canvas `Main.dc.html` symbols `a-cursor`, `a-vscode` and `a-finder`. The Cursor cube uses `currentColor`, so it follows the theme.
  - **Sizing:** add `.mn-app-logo` (15px) in `src/styles/icons.css`.
  - **Permissions:** run the route through `classifyToolCall` in `src/lib/permissions.mjs` only if an agent tool calls it. The UI route is a user action.
- **Test:**
  - Create `test/workspace/open-in-app.test.mjs`. Stub `child_process.spawn` and assert:
    - the command for each app and platform;
    - that unauthenticated and remote requests, including proxied traffic, and paths outside the validated workspace or worktree are rejected;
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
    - Persist versioned panel preferences by workspace and chat in client-local UI state. Keep viewport-specific sizes local, and keep mobile presentation independent of desktop panel placement. Retain the existing workspace-scoped file, preview and split state in `src/state/file-panel.ts`. On first Graphite launch, map the open legacy panels for the active thread while preserving all tabs and splits. New threads start closed. Handle unknown surface IDs, absent or corrupt preferences, reload, two windows, archive/restore and workspace switches without changing session history or drafts.
    - `openSurface` without a panel uses `panelOf[id]`, else the default (Terminal goes to bottom, everything else to side). It shows that panel, activates the surface and clears a maximize held by the other panel.
    - A generic open activates an existing surface where it lives. Choosing it explicitly from the other panel's launcher moves the same tab there, as in the canvas.
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
    - Keep one mounted instance of each live surface. Prove instance continuity in Electron when moving, maximizing, hiding or switching threads. Keep native hosts attached where needed, with stable instance IDs, current bounds and the existing occlusion lifecycle.
  - **Launcher:** one per panel, a `role="menu"` that takes focus when shown and honours the letter keys.
    - Side panel or maximized: one column, `margin: auto` inside an `overflow-y: auto` container.
    - Bottom panel: the pictured three-column grid, top-aligned with no heading. Confirm the launcher scrolls inside the panel at its minimum size without painting over its tab strip.
  - **Resizers:**
    - Side panel: a vertical `separator` on its left edge, from 340 to 720, default 440. Reuse `src/ui/right-pane-split-resize.ts` patterns.
    - Bottom panel: a horizontal `separator` on its top edge, from 160 to 560, default 320.
    - Both take arrow-key steps and reset on double-click.
    - Match the reference keyboard steps, Home/End and reset behavior. Clamp against actual available space and keep an accessible restore path at narrow widths and elevated zoom.
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
    - **Environment:** "This Mac" on the reference host, with the worktree path and reveal. Bind "Also on iPhone" to supported per-thread sharing on a paired device. Devices remains the place to opt in to remote access. Unsupported capabilities have an explicit state.
    - **Open in:** Cursor, VS Code and Finder with logos, calling W2-C.
    - **Dev server:** command, Running/Stopped state, Run/Stop. Reuse `src/ui/hub-dev-server.ts`.
    - **Branch and worktree:** opens the Diff surface with the picker open.
    - **Changes:** "N changed files" with `+/−`, plus "Commit and push" and "Open PR" or "View PR". Use the same commit and PR action paths as Diff, with the captured thread, workspace, worktree and branch. Revalidate before mutations and report a completed commit accurately if its push fails.
    - **Model:** the current model and "Fork…".
    - **Permissions:** a segmented control (Manual / Auto / Full access) using the existing chat settings path. Keep renderer, server and headless permission decisions aligned, including workflow clamps, active approvals and hard denies.
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
  - Preserve publish, branch sync, the name popover, commit generation status, stage/unstage/discard safeguards and conflict recovery. Test an empty or clean repo, mixed staged and unstaged files, conflicts, protected branches, missing upstream, changed checkout and a successful commit followed by a failed push. Diff can be disabled in the contextual launcher on a clean chat as pictured. Keep Git management reachable through Source Control and its existing commands.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/git-panel-*.test.mts test/ui/git-activity-overlay.test.mts`. Update only selectors that moved, never behaviour. Add assertions that the more menu exposes Pull, Push, Merge to main and Open Source Control, and that the scope label reads "All 2 changes" with nothing staged.
- **Accept:** With two unstaged changes, the Diff surface shows the header row, the commit box and one "Changes 2" list. There are no other bars or boxed sections.
- **Touches:** `src/ui/git-panel.ts`, `src/styles/git-panel.css`, `test/ui/git-panel-*.test.mts`
- **Depends on:** W3-B

#### Task W4-B: Terminal, Files and Browser surfaces
- **Build:**
  - Register `terminal`, `files` and `preview` in the surface panels so they mount the existing `src/ui/terminal-panel.ts`, `src/ui/file-viewer.ts` with the file tree, and `src/ui/preview-panel.ts`.
  - **Terminal:** keeps the agent-runs select, shell tabs, Stop and Clear output. Expand maps to maximize its panel, and Hide hides its panel.
  - **Files:** keeps the tree, editor tabs, unsaved buffers, selection, intent mode, save and LSP. Preserve the existing split operations in `src/ui/right-pane-split.ts` and `src/ui/right-pane-slot-tabs.ts`, including file/file, browser/browser and mixed file/browser splits. Agree on the split affordance with the reference before retiring the old layout.
  - **Browser:** keeps back, forward, reload, history, browser menu, Design Mode, annotations, Agent Browser, DevTools and iframe fallback. Its full-width button maps to maximize its panel. Match the standalone Preview board as well as the in-thread surface.
  - **Preview guest:** verify that moving and resizing preserve session/history, active tab, device emulation, focus and pointer targeting. Menus pause only the overlapping native guest and restore it correctly. Exercise primary and secondary guests in real Electron. Check an active PTY continues without duplicate sessions or dropped output while moving or hiding the terminal.
- **Test:** Run `npx tsx --import ./test/test-loader.mjs --test test/ui/terminal-*.test.mts test/ui/preview-*.test.mts test/ui/file-viewer-recent.test.mts test/ui/right-pane-split.test.mts test/ui/file-sidebar-toggle.test.mjs`. All pass with selectors updated only for moved containers.
- **Accept:** Every button in today's terminal panel, file viewer and preview pane works from its surface in either panel, and Ctrl+` still toggles the terminal.
- **Touches:** `src/ui/terminal-panel.ts`, `src/ui/file-viewer.ts`, `src/ui/preview-panel.ts`, `src/ui/right-pane-split.ts`, `src/styles/terminal.css`, `src/styles/preview-panel.css`, `src/styles/file-panel.css`
- **Depends on:** W3-B

#### Task W4-C: Agents, Issue and Pull request surfaces
- **Build:**
  - **Agents (A):** mounts `src/ui/sub-agent-drawer.ts` content. It shows the agent list on top, the selected agent's brief as a message from the main agent, then its steps and conversation.
  - **Issue (I):** renders the chat's linked issue: id and status, title, description, "Done when", and an "Open in Issues" link. Use `src/ui/issues-detail.ts` in a read-first layout.
  - **Pull request (P):** shows number and state, a GitHub link and live checks from the existing `gh` integration. Reuse existing merge eligibility and confirmation. Surface pending/failed checks, drafts, conflicts, missing auth, protected branches and stale PR data. Scope operations to the linked repository and PR.
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
  - **Phone (M):** use the existing Devices and companion APIs for pairing, sharing and delivery. Wire "Show this thread", "Notify when it needs me" and the test notification to real state where supported. Add narrowly scoped behavior where required. When access is off, show only the Devices link. Cover revoked devices and missing capabilities.
  - **Side chat (S):** run an independent conversation through the shared generation pipeline. Use a snapshot of the parent thread's permitted context and enforce the `/ask` read-only clamp on the server for built-in, native and deferred tools. Scope its run ID, cancellation, stream, queue and history separately. Its header reads "/ask · Read-only. The agent keeps working." and its placeholder reads "Ask about this thread". Cover parent and child running at once, cancelling either, reload/reconnect, and denial of side-chat mutations with the parent set to Full access. Honor remote admission and provider capability.
- **Test:** Create `test/ui/surface-brain-phone-side.test.mts`. Assert that the side chat sends with the `read-only` clamp and does not cancel the active run, that Phone hides the switches when access is off, and that Save to Brain calls the capture path.
- **Accept:** Asking a side question during a running turn gets an answer while the main run keeps streaming.
- **Touches:** `src/ui/surfaces/surface-brain.ts`, `src/ui/surfaces/surface-phone.ts`, `src/ui/surfaces/surface-side-chat.ts`, `test/ui/surface-brain-phone-side.test.mts`
- **Depends on:** W3-B

### Wave 5 — Complete workspace coverage

#### Task W5-A: Transcript links into surfaces
- **Build:** In the message and tool-call rendering (`src/ui/messages.ts` and the tool-call row renderer it uses), make step rows clickable:
  - Read or Edited opens Files at that file.
  - Ran opens Terminal at that run.
  - Searched opens Files with the query.
  - Opened PR opens Pull request.
  - The agents card opens Agents.
  - Resolve targets from typed tool results, including thread/worktree, canonical path and line, terminal run ID and repository/PR identity. Preserve historical messages. Missing, stale or unsupported targets render as text or a disabled action with a reason. Match the mockup links and hover/focus treatment.
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

#### Task W5-C — Phone workspace, navigation and remote workflows
- **Build:**
  - Use `Mobile` and the individual `Phones` screens for the thread list, app drawer, chat, composer, approval, agents, changes, model picker, board task, expanded issue, model hosting and Devices. Cover Brain, Scheduler, Settings and notifications reachable through the phone prototype. Use existing app routes and host capability checks.
  - Reuse `src/ui/mobile-layout.ts`, `src/styles/mobile-app.css` and `src/ui/mobile-drawer-portal.ts`. Match each pictured screen's navigation and sheet geometry. Use Wave 0 references for extra launcher surfaces or thread actions outside the phone boards. Preserve the desktop layout when entering or leaving a phone breakpoint.
  - Handle safe areas, iOS keyboard pan, scroll, rotation, Back, reconnect and 44px touch targets. Use existing paired-device identity, host-owned turn admission, revocation and notification preferences. Cover real LAN and Tailscale paths, including unavailable host and reattachment.
- **Test:** Extend `test/ui/mobile-layout.test.mts` and companion/remote tests. Run phone screen captures and manual iOS Safari, installed Home Screen and Android Chrome journeys.
- **Accept:** A paired phone matches the pictured screens and can open an existing thread, follow a turn, act on a supported approval, inspect the result and return to the list. Revocation, reconnect and host-unavailable states behave as specified.
- **Touches:** `src/ui/mobile-layout.ts`, `src/styles/mobile-app.css`, `test/ui/mobile-layout.test.mts`
- **Depends on:** W2-A, W3-B, W4-A through W4-D, W5-D, W5-E

#### Task W5-D — Workspaces, navigation and all app boards

| Area | Implementation and acceptance |
|---|---|
| Workspaces and shell | Match the chooser, header project switcher, sidebar app placement and inset sheet. Wire open, create, clone, recents and reopen in a new window. Verify progress, failures, cancellation, unsaved workspace switches, window ownership and deep links. Apply the shell to first-run and pairing flows with approved states where the canvas is silent. |
| Dashboard, Issues and Projects | Implement Main's Dashboard and pipeline, Issues list, detail and project navigation. Preserve filters, groups, saved views, issue dependencies, GitHub sync, worktree/chat links and start-work handoff. Verify changes appear in all views and reopen the correct workspace. |
| Source Control | Match Changes, History, Branches, Stashes, Worktrees, PRs, Actions and Releases. Reuse Git, recovery and repository APIs. Exercise AI commit/review, PR checks and release drafts using fixtures or a disposable repo. |
| Models | Match Server, Discover, Library, Providers, CLIs, Pools, Routing, Sampling, Usage, Voice and Storage. Verify model install/load/unload, offline and provider failures, model selection in the composer, and preservation of routing and native CLI options. |
| Boards | Match waves, verification and activity, including task/worktree detail. Keep Orchestrate's current execution and gates. Run the board scenario contract and verify pause, retry, resume and final integration. |
| Brain | Match Graph, Proposals, Memories, Ingest, Lint, Code, Log, Schema and Settings. Verify search, proposal decisions, graph/code navigation and failure/empty states through existing storage and tools. |
| Scheduler | Match Jobs, Runs, the editor and live run view. Verify create/edit, run now, history, cancellation/retry and correct workspace targeting. |
| Settings | Map the canvas groups and pages to the live settings registry. Preserve every shipped setting, plugin and skills entry, provider configuration, Devices and backups. Verify settings links, validation, persistence and registered plugin navigation. |

- **Depends on:** W0-A, W1-A, W1-B, W2-B and shared shell work in W3-B. Integrate through the existing router and app registry. Preserve legacy hashes and plugin routes. Keep release-gated apps excluded from every entry point.
- **Accept:** Each board subsection has an approved comparison at its authored size and tests against its real service. A user can navigate from the chooser through each released app and back to the correct Code thread.

#### Task W5-E — Thread states, recovery, search and notifications

- Match Main, NewThread and Archive for sidebar grouping and search, the centered transcript, composer, empty workspace, running/steering/queue states, compact and expanded activity, ready-to-review changes, pin, archive, undo and restore. Keep model availability, drafts and streamed updates intact when the user switches threads or workspaces.
- Match Approval, Goal, Recovery, Fork and Resume using the real generation and session flows. Cover allow/deny, reconnect to a live turn, retry/continue, fork with each pictured context choice, interruption and restart, goal evaluation/compaction, and provider unavailable. Assert the UI's status corresponds to server state and actions target the intended turn exactly once.
- Match Search and Capture, including filter and selection keyboard behavior, archived matches, result navigation to the right workspace and message, issue capture/link, validation and draft preservation.
- Match Notify's desktop, board and phone variants, Activity and alerts. Verify actionable notification routing and acknowledgement, deduplication, cross-window behavior, OS preferences and device delivery with opted-in fixtures.
- **Depends on:** W2-A, W3-C, W5-A and W5-B. Integrate alongside W5-D.
- **Accept:** Complete a real turn through approval, live tools, review and archive. Restart with an interrupted turn and verify the pictured recovery choices. Search for the thread, capture an issue, and open its related notification in the right workspace.

### Wave 6 — Docs and regression gate

#### Task W6-A: Manual, context.md and budgets
- **Build:**
  - **`documentation/manual/apps/code.md`:** rewrite "The layout" for the sidebar, the chat with its thread card, and the side and bottom panels, with move, maximize and letter keys. Replace the right-pane and terminal-panel wording.
  - **`documentation/manual/chat/chatting.md`:** update the composer section for the thread card and remove nothing else.
  - **`documentation/manual/apps/settings.md`:** add Color to Appearance.
  - **`documentation/context.md`:** document the shell, surface lifecycles, preference migration, phone and open-in boundaries. Update `DESIGN.md`, the design system references and the affected manual pages with the shipped visuals and navigation. Refresh generated inventories where changed.
  - **Copy:** user-facing docs describe only what ships.
  - **Budgets:** after `npm run build`, run `npm run check:performance-budgets`. If a chunk grows past its ceiling, raise `budgets.json` with a rationale in the PR and refresh the baseline.
- **Test:** Run `npm run test:product-wiki`, `npm run build` and `npm run check:performance-budgets`.
- **Accept:** The manual's Code page describes the side panel, bottom panel and thread card, with no mention of the old right pane.
- **Touches:** `documentation/manual/apps/code.md`, `documentation/manual/chat/chatting.md`, `documentation/manual/apps/settings.md`, `documentation/context.md`, `budgets.json`, `scripts/bundle-size-baseline.json`
- **Depends on:** W5-A through W5-E

#### Task W6-B: Full regression pass and sign-off
- **Build:**
  - Run the board/state screenshot suite against the frozen reference. Publish the exact reference, actual and diff for each failed state. Review the full test matrix, including typography, motion phases, hover, focus, disabled controls, overlays and phone layouts.
  - Complete the release journeys below in built browser and packaged Electron with an isolated home. Validate fresh install and upgrade from the current release, including restart and rollback to the old shell with the upgraded profile.
  - Make the visual and journey check report a required PR result for the default cutover. Run against the current `main` base and attach platform, device, package and performance evidence to the PR.
- **Test:** Run `npm run test:check-coverage`, `npx tsc --noEmit`, `npm test`, `npm run check:icons`, `npm run test:a11y`, `npm run test:product-wiki`, `npm run architecture:check`, `npm run board:scenario-contract`, `npm run build`, `npm run test:packaged-boundary`, `npm run check:performance-budgets` and `npm run impeccable:detect`. Run platform package jobs and smoke the installed builds on macOS, Windows and Linux.
- **Accept:** Required CI checks pass, visual diff review is signed off, every parity row is backed by a passing behavior check, and the packaged candidate is verified. Switch the default only in the final PR. If a cutover regression requires reverting the default, the existing shell can read the same profile and reach the same work.
- **Depends on:** W6-A

## Release journeys

| Journey | Required outcome |
|---|---|
| Fresh install and upgrade | Open, create or clone a workspace and reach Code. Upgrade a profile containing open tabs, mixed split, drafts, archived/linked chats, worktrees, themes, providers and enabled plugins. Verify restart and the rollback rehearsal preserve access to all of it. |
| Real build loop | Open an issue, start work in its worktree, send a turn, approve a protected action, follow the tool output, open a file from the transcript, inspect Diff, commit and create or inspect a PR. Exercise a denied approval and a failed push. |
| Live panels | Run a dev server and terminal, open its preview and an unsaved file, move both surfaces, maximize and restore, switch chat/workspace and return. Confirm buffer, PTY, previews, mixed split, focus and input stay correct. Open overlays over each guest and verify only the intersecting guest pauses. |
| Concurrency and recovery | Keep a main turn streaming while sending a read-only Side chat. Cancel each independently. Restart during interrupted work, test retry/continue/fork, and verify no duplicate tool execution or queued turn. |
| Full workspace navigation | Use the project menu, links, palette and shortcuts to reach every released app and return. Verify deep links, saved settings, app-scoped commands, plugin entry points and notifications in the correct workspace. |
| Phone and device security | Pair from the host, open an active thread on LAN and Tailscale, follow the run, complete a supported approval and reconnect. Revoke access and verify protected requests stop working. Verify remote callers cannot launch desktop apps or opt a host into sharing via the thread UI. |
| Keyboard, touch and appearance | Use keyboard only across sidebar, thread, composer and panels. Check IME, editor, terminal and browser shortcut ownership, focus recovery, screen-reader names and state, zoom, reduced motion, contrast across theme/tint combinations, and touch with the software keyboard open. |
| Package and performance | Run cold start and first-use captures with assets offline. Use existing boot and bundle budgets, and measure layout movement, sustained streaming, panel resizing and native guest reveal against the pre-change baseline. Verify installers and built web entry points use the same Graphite assets. |

## Verification Checklist
- [ ] `test/ui/graphite-parity.test.mts` passes; it lands first and stays green.
- [ ] `npm run test:check-coverage` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm test` and required PR checks pass on current `main` plus the cutover.
- [ ] `npm run build` and `npm run check:performance-budgets` pass.
- [ ] `npm run impeccable:detect` reports no new hex literals outside `src/styles/tokens.css`.
- [ ] All 35 boards and their mapped states pass visual comparison at their authored sizes. Any approved platform or accessibility-specific state has its own reference.
- [ ] Every parity row has a behavioral check and all release journeys pass, including native preview, real phone pairing and fresh install/upgrade/rollback.
- [ ] Browser at the side and Terminal at the bottom stay visible together, and the empty bottom panel shows the three-column launcher with nothing over its tab strip.
- [ ] The composer shadow stays within about 12px of the card in light and dark.
- [ ] No slash chips appear under the composer or on the new-thread screen.
- [ ] Hidden apps remain unreachable.
- [ ] The final PR includes the capture report, packaged smoke results, upgrade/rollback results and the single Graphite default cutover.

## Integration review

The supplied offline export rendered all 35 pinned boards with their authored viewport sizes and Material file icons. The follow-up compared those references with Chromium, native Electron and simulated iPhone Safari. Live captures used isolated profiles and real app routes, with seeded data for otherwise transient states. The visual comparison covers the boards listed below. Pixel sign-off and the complete interaction-state matrix remain open.

| Board | Live comparison and remaining differences |
|---|---|
| Workspaces | Captured the chooser, switcher and folder picker at 1440×900. Recent rows retain real checkout and workspace data. The prototype's activity and resource details are incomplete. |
| Main | Compared the desktop shell and active thread. Verified adaptive transcript and composer widths of 660 px at 1440, 821 px at 1728, and 628 px beside the default side panel at 1440. The sidebar model card uses live throughput samples when available. Dashboard was removed at review. |
| Approval | Compared the command prompt and Agents inspector separately. The approval card retains risk information, denial feedback and prompt controls required for real tool calls. The seeded approval and active agents have separate captures. |
| NewThread | Compared the starter with the real composer, issue and Activity summaries. Metrics and inherited panels are hidden while drafting. Data depends on the active workspace. |
| Issues | Compared list and detail. Compact rows and toolbar align to the canvas. Detail tabs and taxonomy still reflect the production issue workflow. |
| Changes | Compared live line counts, inline patches and reviewed-file layout. Exercised real Git fixtures and AI review. |
| Archive | Compared populated archive, date grouping, search and restoration. Seeded timestamps differ from the canvas. |
| Command | Compared the sheet, command rows and keyboard controls. Production retains categories and its available command set. The prototype's open-in-inspector shortcut remains open. |
| SourceControl | Compared the three-column stage with staged and unstaged files. Unified and Split views and real Summarize and Review are wired. All subroutes need pixel sign-off. |
| Models | Compared the stopped Local server view. Loaded model cards, VRAM and RAM gauges still need a comparable runtime fixture. |
| Boards | Compared a saved draft and two running builders. The two-column grid and 340 px task inspector fit the authored 1168 px stage. The inspector falls back to a dialog in narrow workspaces. Exact tabs, task approval and progress treatments remain open. |
| Brain | Compared the navigation rail, real graph and page reader. Graph data and reader content differ. |
| Scheduler | Compared Jobs, its inspector and All runs. A real scratch headless run completed and appeared in history. All editor and failure states still need comparison. |
| Settings | Compared at 1168×836. The content starts at x268 and y55. Production settings retain additional entries. |
| Preview | Compared the 1168×836 maximized stage. Native Electron verified a real dev server, preserved guest across dock moves, viewport sizing and live PTY. The canvas's takeover assumes ownership transfer on the same page. Live takeover applies to isolated Agent Browser sessions. Native DevTools docks in Preview and uses Chromium's own inspector. |
| Composer | Compared a 760 px live component crop, the model picker and expanded Metrics. Production retains its provider rail and filters. Adaptive Code sizing follows the user's updated direction. |
| Notify | Compared the desktop failure card with a matching fixture at 360×125.78 px and verified the phone position. Larger touch controls change phone card height. Activity groups live records. |
| Mobile | Compared paired Chrome and iPhone 17e Safari at 390 CSS px. The thread list and new-thread controls remain simpler than the canvas. |
| Search | Compared the results overlay and verified navigating directly to a matching transcript message. Production retains the all-workspace control. |
| Phones | Compared navigation and the live Changes, model picker, Models, Settings and device views. OS chrome, production app content and utility sheets differ. Physical-device gesture and background checks remain open. |
| Shortcuts | Compared the two-column sheet and keyboard focus. Production lists additional supported shortcuts. |
| Capture | Compared the anchored compact issue form. Verified that a real issue saves with notes, label, priority and optional thread link. |
| Goal | Compared the card with a seeded goal and evaluator round count. Production shows actual evaluator output. The canvas's separate completion criteria and fixed round ceiling remain open. |
| Recovery | Compared the inline failure card and details. Production retains Continue, Fork and Clear with their existing history semantics. A separate retry-from-step action remains open. |
| Fork | Compared model choices and carry-over modes. Verified separate fork history and preservation of the source thread. Larger model catalogs use the searchable picker. |
| IssueProjects | Compared populated project list and inspector. The detail pane begins within 1 px of the reference. The Projects confirmation now shows the selected issues and dispatches directly from Issues. |
| Resume | Compared selectable items and the confirmation count. Unselected chats stay paused for automatic recovery. Starting a resumed item from a compacted summary remains open. |
| ThreadCard | Compared the anchored card and tested keyboard dismissal, model fork, permissions and live context. Available rows depend on the current checkout, issue and model. |
| BottomDock | Compared both panels open at 1440×900. The side panel measures 440×836 and the bottom dock 700×320. Verified that the dock and Terminal shortcut work without the old empty footer. |
| Surfaces | Compared launcher geometry and exercised focus, tabs, resize, hide, maximize and restore. Surface availability follows the active thread's actual capabilities. |
| PullRequest | Compared the live inspector. Verified pending checks block merging and stale heads are rejected. The confirmed request passes the displayed head SHA to the forge. |
| SideChat | Compared the inspector and verified an independent read-only model turn with the source thread preserved. |
| ThemeOcean | Compared at 1440×900. Sampled background and sheet colors match Ocean/Rich. Fixture content and shell spacing differ. |
| ThemeDesert | Compared at 1440×900. Sampled background and sheet colors match Desert/light/Subtle. Fixture content and shell spacing differ. |
| Appearance | Compared the preview and theme grid. The card starts at x560 and y171, with tile origin within 0.35 px. Production font and theme controls remain available below the preview. |

The paired flow exercised ticket pairing, authenticated host-owned streaming on existing and new threads, reconnect navigation, real Git Changes, the model picker, device settings and self-disconnect. The phone's settings use its paired identity and local alert preference. Desktop Phone still needs thread-scoped access and test delivery through a verified companion protocol. Simulator Safari used DOM events for inputs, and Android ran in Chromium handset emulation. Physical taps, the software keyboard, installed Home Screen behavior and background delivery remain open.

An isolated macOS app rehearsal read a legacy session, retained its workspace, pinned thread and transcript, and saved a composer draft that the previous package could reopen after rollback. A local ARM64 DMG mounted and the copied app passed the packaged runtime checks. The Linux ARM64 package passed those checks on Ubuntu 24.04. The AppImage launch in that container needed `libz.so` available to its loader, and the bundled SQLite prebuild required glibc 2.38 or later. Debian 12 failed that SQLite check. The unpacked Linux x64 payload passed the runtime verifier under Rosetta on Ubuntu 24.04. Rosetta rejected the original AppImage launcher, and a temporary copy with the AppImage marker cleared reached the renderer recovery screen. Native x64 startup remains unverified. The Windows x64 cross-build packed the app and reached NSIS generation, where Wine aborted under QEMU. Signing, notarization and native Windows installer and rollback verification remain separate release gates.

The full local suite, test discovery, accessibility, TypeScript, product wiki, architecture inventory, board scenario contract, production build and bundle budgets passed. The packaged runtime verifier passed on the final macOS app. The full suite was followed by focused checks for the final Boards inspector and native Agent Browser Guide changes.

The total-assets ceiling increases from 12110 KB to 12350 KB for offline fonts, app inspectors, recovery and issue capture UI and paired-device controls. The integrated build measures 12334.4 KB. The other bundle and startup ceilings keep their previous limits. The repository design audit still reports findings.

## App Review Follow-up

The left edge of the workspace sheet casts a continuous shadow onto the rail. The transparent menubar lets that shadow continue through the top of the sidebar. The light and dark treatments were checked in Electron. Dashboard and its launcher were removed. Legacy Dashboard and Overview links open Code chat. The Issues Projects confirmation retains batch dispatch and shows the ready issues before starting isolated work. The Work tab exposes the saved batch plan for review and approval.

Settings was compared at the authored desktop size and at a 390 px touch viewport. All 31 Settings pages and the Models link rendered without horizontal overflow. Native Settings deep links were verified while Settings was already open. Models was compared across 13 production routes and 11 authored states, with additional routes retained for production settings. Issues, Projects, Source Control, Brain, Scheduler, and Boards were compared at their authored sizes using saved data, Git changes, a Scheduler run, and a running board. Files, Changes, Terminal, and the native Preview guest were exercised in Electron. Paired Chromium verified Settings and Models navigation, Git Changes, existing and new chat streaming, and revocation.

Production states still differ from the export. Live diagnostics, device pairing and backup flows expose different controls from the Settings fixtures. The Models loaded-card fixture verified the browser layout, with telemetry painting covered by automated tests. Routing, Thinking, and Usage expose the product's supported controls and measured values. The running Board used the existing attention inbox. The specific permission request in the export remains unverified. Graph and change counts come from the active workspace.

The full suite passed, and focused checks covered the final route and app changes. Accessibility passed all 104 checks. The production build measured 12377.2 KB against a 12400 KB total-assets ceiling, which adds 50 KB for the review changes. The repository design audit reports 471 findings. The earlier release-platform gaps remain separate from this visual sweep.

## Detail Review Follow-up

The desktop rail and collapsed header share Activity, Models, Help, Search, and Settings. The same button nodes move between the two locations. The application sheet casts a soft shadow across the rail, and the collapsed header shares the sheet background. The workspace picker keeps routine server status out of the header and opens its folder browser as a taller dialog. Notification cards put Dismiss in the top right and draw the countdown at the bottom edge.

Side Chat renders the shared transcript and a compact composer. It sends visible parent messages, available compaction context, and any partial assistant reply as a bounded reference for the side question. It keeps its turns, cancellation and saved transcript scoped to the panel. Brain and Phone were removed from the panel launcher. A saved retired tab selects another tab in that panel or closes it. The Brain app and device settings remain available through their normal navigation.

The Brain graph fits visible nodes to the usable canvas when opening its reader or changing the shell layout. Source Control badges use smaller tabular numerals. The model picker gives favorites and provider models separate space, with single-column navigation on phones. My Models starts with compact rows and an optional filter bar. Composer Metrics uses the five-card reference, with available token and model breakdowns under Turn details. Issues uses a single Start thread action with the selected model and worktree option.

Paired Chromium and iPhone Simulator Safari exercised Settings, the model picker, Changes, a host-streamed reply, and revocation. The phone Changes sheet shows the live diff above the pinned commit form. Its checkout, review, and separate Commit and Commit and push actions follow the live Git workflow. The simulator used DOM events for text entry and did not exercise a physical keyboard or background notifications.

The local suite finished with 14,608 passing tests and 66 skips. The final production build measured 12417.2 KB, with the total-assets ceiling raised by 25 KB to 12425 KB for the follow-up. The design audit dropped from 471 to 307 findings. The remaining findings include legacy styles, bundled detector fixtures, and the Geist fonts specified by the prototype.

The unsigned macOS ARM64 DMG mounted successfully. Minnow copied from the disk image passed the eight packaged runtime checks, including native SQLite, canonical transcripts, the composer bundle, and packaged manual assets. Signing, notarization, and native Windows and Linux installer validation remain release gates.

## Notes for Build Agents
- The pinned canvas and the Wave 0 decisions govern appearance and interaction. Minnow's services govern actual data and authority. Update the state inventory for any required reference decision before closing the owning task.
- Never rename or delete an `index.html` id that a test or module queries. Move it.
- Use icons by `icon.ts` semantic name. The only non-Uicon marks allowed are the three app logos in `src/ui/app-logos.ts`.
- Motion: opacity and transform only, 120–180ms, ease-out, and none under reduced motion. No bounce, overshoot, glow or animated shadows.
- Copy: short and specific, sentence case, no explanatory filler. Copy labels from the canvas.
- Every popover, menu and sheet root calls `markPreviewOccluder` and restores focus to its trigger on close.
- Permission level is global per chat (Manual / Auto / Full access) through `src/lib/permissions.mjs`. The thread card only changes the chat's level and never adds per-tool settings.
- Side chat uses the `/ask` clamp (`read-only`) and must not stop or steer the main run.
