# Accessibility and keyboard-first audit

Contributor checklist for keyboard operability, focus management, screen-reader behavior, and contrast coverage across Minnow apps. Product reference: [`../context.md`](../context.md) (Accessibility section). User-facing shortcut list: [`../manual/reference/keyboard-shortcuts.md`](../manual/reference/keyboard-shortcuts.md). Regression guard: `npm run test:a11y` (includes `test/theme-contrast.test.mts`).

## Global help surface

Press **`?`** (when not typing in a text field) to open the shell keyboard shortcuts overlay. Lists shell, chat, code, and orchestrate board bindings.

## Per-app keyboard checklist

| App | Core flow (keyboard-only) | Notes |
|-----|---------------------------|-------|
| **Shell / app rail** | Tab through menubar and app rail tiles; Enter launches apps | Ctrl+Tab cycles workspaces picker and recent apps |
| **Code chat** | Tab to composer; type message; Enter send; `/` skills; model picker Arrow keys | Streaming uses throttled `aria-live` (no token spam) |
| **Code** | File tree arrows; editor Tab/Escape; Ctrl/Cmd+K Quick Edit | Terminal: focus with tab; Ctrl/Cmd+C copies selection |
| **Research** | Tab through hub controls; Enter starts run | Progress uses `aria-live="polite"` |
| **Models** | Tab filters and model rows; Enter selects | |
| **Brain** | Tab form fields; Enter save | |
| **Issues** | List keyboard nav; context menu | |
| **Scheduler** | Tab job fields; Enter save | |
| **Settings** | Finder search; Tab sections; Escape closes drawer | Drawer traps focus |
| **Orchestrate board** | Tab cards and header; Arrow grid nav; Enter open task | Exec mode segments: Arrow keys |

Release-gated apps are out of scope until their gate flips; audit them in the PR that releases them.

## Focus management

- **Overlays:** Source Control Center, Scheduler's side panel, and the in-app editors return focus to the control that opened them.
- **Modals:** app dialog, git help, tool approval, question cards, and keyboard help trap Tab and restore focus on close.
- **Reparenting:** moving chat, file tree or preview nodes between layouts must not steal focus from an editable control (MIN-179).

## Screen reader smoke (NVDA on Windows)

1. App rail: tile names announced; Ctrl+Tab cycle announces the focused app.
2. Chat stream: "Generating…" / "Thinking…" once; prose throttled (~3s); "Response complete" at end.
3. Composer mode picker and model listbox: role/listbox + arrow navigation.
4. Tool approval: digit shortcuts documented in strip; buttons labeled.

## Contrast (WCAG AA)

`test/theme-contrast.test.mts` checks all 16 palette themes: `--mn-fg` on `--mn-bg` / `--mn-surface-1`, muted text, accent ink, and light-mode syntax highlights (MIN-243 folded into suite).

## Automated regression

```bash
npm run test:a11y
npm run impeccable:detect   # static anti-patterns incl. a11y heuristics
```

## Known long tail (file as issues)

- Full axe-core DOM pass per app route in Electron (CI browser harness).
- Source Control Center: roving tabindex across the seven-section rail.
- Live NVDA verification scripts (manual, not CI).

## Responsive and assistive-technology audit, October 2, 2026

The Code chat audit covered 320×640, 390×844, 768×1024, 844×390 and
1280×800 CSS-pixel viewports in Chromium, with touch and fine-pointer input.
The 320px viewport also exercises reflow equivalent to a 1280px window at
400% browser zoom. This is a reflow check, not a native browser-zoom or
screen-reader certification.

| Finding | Correction |
| --- | --- |
| Both sidebars left only 70px for chat at 768px. | Chat and file drawers now activate through 1024px, including landscape phones. |
| Inset composer actions competed with settings and model controls. | Columns up to 520px put settings and send actions on separate rows; touch controls have 44px targets. |
| Software keyboards could cover the composer or let long drafts consume its available height. | Shell and composer sizing follow the visual viewport at normal scale. Pinch zoom does not shrink the shell. Long drafts keep a bounded, scrollable input. |
| Closed drawers remained accessible off-screen. | Closed narrow drawers use visibility hiding; opening Chats focuses its controls and closing returns focus to its opener. |
| Portaled composer settings had hidden focus targets and a disconnected tab exit. | Hidden settings are skipped; boundary Tab and Escape close the popover and return to its opener. Placement follows viewport changes. |
| Long code blocks and tables required pointer scrolling. | Rendered code and tables are keyboard focus targets. |
| Issues sorting used table ARIA on standalone buttons; the saved-view button could lose its name after refresh. | Sorting is a labelled group of buttons; themed select buttons retain the field's accessible label. |
| Models rows lacked cells; Brain labelled an untyped container; Scheduler empty states used list semantics. | Added table cell/header roles and a named region; Scheduler exposes list semantics only with job rows. |
| Source Control nested action buttons inside button-like rows. | File rows are named groups; row keyboard shortcuts leave child controls alone. Secondary path/group text and composer context text use the stronger muted-text token. |

Keyboard checks covered opening composer settings, Escape focus restoration,
opening/closing Chats, and a long draft with a simulated 400px visual viewport.
The latter kept Send inside the visible shell. Axe-core checks covered the
default Home, Code, Source Control, Issues, Models, Brain, Scheduler and Settings
views at 390px. These checks cover rendered states, not every dialog or populated
data variant.

Manual release checks still required: NVDA and VoiceOver announcements during
streaming, real iOS/Android keyboard and safe-area behavior, native 200%/400%
browser zoom, and Firefox/Safari reflow. Automated contrast tests cover the core
palette tokens; they do not establish contrast compliance for every component.
