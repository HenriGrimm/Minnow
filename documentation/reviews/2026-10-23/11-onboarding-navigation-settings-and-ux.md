# Onboarding, navigation, settings and UX

Review date: 2026-10-23. Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Reviewer: workspace review subagent, independent source and scratch UI review. Product direction: chat-driven building; Code is the central, mainly chat workspace.

## Assessment and boundaries

Minnow already has the foundation for the intended experience: a persistent conversation and composer, a calm tool-oriented shell, searchable settings, and a dedicated phone conversation UI that reuses the desktop chat machinery. The main product opportunity is to make the conversation and its working result consume the default attention budget. Today, file navigation and configuration ask for substantial space and understanding before they become necessary.

Four independently verified accessibility defects need repair: onboarding loses modal focus containment, phone keyboard navigation reaches the desktop rail behind the phone screen, several default-theme text roles have insufficient contrast, and phone chat lists have invalid list children. These are bounded findings, not a claim that all navigation or accessibility is broken.

Source sampled: onboarding controller and step registry/welcome/remaining steps; Code hub, file panel defaults and main-column overlays; OS shell and app registry; settings catalog/layout/render guard; phone mode, navigation, conversation, chats, sheets; mobile viewport logic; design tokens and associated styles; theme contrast tests. Product and design references were read through Impeccable's product/audit workflow. Context preflight: `context=pass product=pass command_reference=pass shape=not_required image_gate=skipped:read-only-audit mutation=open`. Only review artifacts were written.

Live review used a unique `agent-browser` session, `minnow-review-ux-dukky`, against the root reviewer's isolated server at `http://localhost:19473`. It did not use the live Minnow profile. The profile already contained synthetic chats and a fake model. This was not a clean-install or real-model quality test. Desktop Code/Settings/setup and phone Chats/conversation were sampled. No actual phone, screen reader, OS high-contrast mode, Electron-specific window controls, all-theme screenshot matrix, real downloads, provider onboarding, or external account connection was tested. Scheduler's editor was deliberately excluded from the live accessibility scan because the root reviewer had already encountered a browser-tool hang there.

All screenshots cited in this section were captured independently in that named session; existing root screenshot evidence was not used to claim independent reproduction. The session was closed successfully with `agent-browser --session minnow-review-ux-dukky close`; the root's server/browser work was left running.

## Good

- **One conversation remains the product spine.** The new-chat hub physically relocates the existing composer rather than inventing another chat path (`src/ui/hub.ts:53`, `:61`), with the direct prompt “Tell Minnow what you want to build…” (`:67`). The phone conversation mounts the shared chat host (`src/mobile/chat-thread.ts:119`). This is the right architecture for consistent approvals, streaming, attachments and continuation across surfaces.
- **The visual language supports work.** Sampled screens use restrained surfaces, compact controls, familiar text and a consistent token system. Files and technical metadata use technical styling without making all conversation prose look like a terminal. The screenshots show a coherent instrument rather than unrelated app templates. Preserve this while simplifying the default arrangement.
- **Setup is explicit about the actual boundary.** Welcome says no Minnow account is needed, local chats/settings stay on the machine, and requests go to chosen providers. It offers a restore path (`src/onboarding/steps/welcome.ts:97`, `:156`). The welcome “Set up later” path really exits and marks setup complete (`src/onboarding/controller.ts:330`); later steps can be skipped individually. Avoid describing every registered provider branch as a mandatory step: `getApplicableSteps` filters the registry.
- **Settings has a useful entry point.** The live Startup & setup page exposes common actions such as connecting a model, appearance, agent permissions and backup, plus settings search. Source includes a generation guard for asynchronous section rendering (`src/ui/settings-section-render-guard.ts:5`, `:12`). That mechanism is a good basis for preventing stale section content; this review did not claim every caller is race-free.
- **Phone is a purposeful small-screen surface.** Four main tabs, a simple conversation header and full-width transcript are a better fit than squeezing the desktop columns onto a phone. The mode is intentionally stable for the lifetime of the page (`src/mobile/mode.ts:1`, `:48`), so rotating a phone does not swap shells. The sampled 390px page had no horizontal overflow. Navigation has explicit screen lifecycle handling; retained screens can suspend work when covered.
- **Accessibility/performance intent has concrete infrastructure.** Labels, modal roles, keyboard handlers, viewport synchronization and reduced-motion styles are present. The existing theme suite passes 73 checks. These strengths make the failures below repairable within established patterns; passing token checks alone does not establish rendered accessibility.

## Verified defects

### UX-1 — P2: setup declares a modal but keyboard focus leaves it

**Trigger:** Open Settings → Run setup again. The welcome heading receives focus. Press Shift+Tab once.

**Observed:** Focus moves to the background toast's “Dismiss notification” button while the setup dialog remains open with `aria-modal="true"`. The saved DOM observation records `focusInsideWizard:false` and `modalPresent:true`. Background settings controls also remain in the browser accessibility snapshot. Escape closes setup successfully; that working shortcut does not provide modal focus containment.

**Evidence:** `src/onboarding/controller.ts:85` declares the modal; `:139` appends it to the body; `:282` focuses the heading. The key handler at `:193` handles Escape/Enter but has no Tab containment, and the controller does not make background content inert. Live evidence: [focus observation](evidence/ux-independent-onboarding-focus.json), [setup screenshot](evidence/ux-independent-onboarding.png). The observation came from DOM focus inspection after a real keyboard action, not an axe inference.

**Impact:** Keyboard users can operate controls behind the modal and lose their place. The accessibility tree promises a stronger modal boundary than the UI enforces. This is material onboarding friction; data loss or a completed unintended background action was not demonstrated.

**Recommendation:** Use a shared dialog focus scope: retain the opener, focus the current step, cycle Tab/Shift+Tab through the active dialog, make ordinary background content inert, restore focus on close. Deliberately define any global approval/alert exception instead of leaving the entire background active. Test forward/reverse traversal, step transitions, nested folder picker, Escape and opener restoration.

**Confidence:** High; source plus dynamic reproduction.

### UX-2 — P2: phone keyboard navigation enters the covered desktop app rail

**Trigger:** Load `?mobile=1` at 390×844, open an existing chat, focus its Back button, then press Shift+Tab.

**Observed:** Focus moves to the desktop rail's Reef button, which is behind the visible phone conversation. The browser accessibility snapshot also includes the desktop “Apps” navigation before the mobile content. DOM inspection reports the desktop rail as `display:flex`, visible, not inert. Reef is simply the last button in the retained rail; this defect is independent of the product decision about Reef's placement.

**Evidence:** Mobile CSS hides several desktop roots at `src/styles/mobile-app.css:16` and `:17` but omits `#osAppRail`. The current shell creates that rail inside `#osWorkspace` at `src/os/shell.ts:36` and `:40`. Saved [focus observation](evidence/ux-independent-phone-focus.json), [phone conversation](evidence/ux-independent-phone-chat.png). The observation records `focusInsideMobile:false` and the desktop rail button's markup.

**Impact:** Keyboard and assistive-technology users encounter navigation they cannot see, duplicate app choices and unexpected focus movement. Actual activation of the hidden button was not attempted, so downstream routing behavior is not asserted.

**Recommendation:** When the phone shell owns the screen, hide/inert the actual desktop shell roots, including the app rail. Maintain explicit exceptions for shared approval/question hosts that the phone genuinely uses. Add a regression check that reverse-Tab from the first phone control cannot reach desktop navigation, and inspect the resulting accessibility tree.

**Confidence:** High; source plus dynamic reproduction.

### UX-3 — P2: default-theme secondary information fails text contrast

The default swamp-dark `--mn-fg-subtle` is `#5a626c` (`src/styles/tokens.css:98`). Several roles use it as small informational text. The independent axe 4.12.1 scan measured:

| Sampled role | Foreground/background | Ratio | Expected for sampled text |
| --- | --- | --- | --- |
| Selected chat model, 9px | `#5a626c` / `#293233` | 2.12:1 | 4.5:1 |
| Code throughput metadata, 11px | `#5a626c` / `#161a20` | 2.82:1 | 4.5:1 |
| Phone chat timestamp, 12.5px | `#5a626c` / `#0f1216` | 3.03:1 | 4.5:1 |
| Phone inactive tab labels, 11px | `#5a626c` / `#0b0d11` | 3.14:1 | 4.5:1 |

**Trigger:** Default-theme desktop Code with a selected chat; phone Chats with a populated row and inactive Boards/Issues/Files tabs.

**Evidence:** `src/styles/sidebar.css:578`, `src/styles/code-chrome.css:314`, `src/styles/mobile-app.css:217`, `:240`, `:863`. Raw [Code axe output](evidence/ux-independent-code-axe.json) and [phone axe output](evidence/ux-independent-phone-axe.json). The test suite checks normal/muted foregrounds across all 16 variants (`test/theme-contrast.test.mts:101`, `:112`), but the dedicated subtle-text check covers human-dark (`:142`), not these default-theme rendered roles.

**Impact:** Users with reduced vision have difficulty reading model provenance, status and inactive phone destinations. The problem is amplified by the 9–12.5px sizes. The scan does not imply all text or all themes fail.

**Recommendation:** Use a readable text token for informational text, reserving low-contrast subtle tokens for decoration. Extend rendered-state checks to selected rows, status bars and inactive phone labels across themes. Preserve hierarchy with spacing/weight rather than lowering required text contrast.

**Confidence:** High for the sampled roles; dynamic measurements align with source colors. No claim about every use of `--mn-fg-subtle`.

### UX-4 — P2: phone chat list lacks required list-item semantics

**Trigger:** Open the phone Chats screen with at least one chat.

**Observed:** Axe flags `aria-required-children`: a `div role="list"` contains direct button children. Its scanner impact is “critical”; the review priority remains P2 because the sampled workflow still operates and the harm is incorrect assistive structure, not a demonstrated total block.

**Evidence:** `src/mobile/chats.ts:109` creates the list; `:50` returns each row as a button. [Phone axe output](evidence/ux-independent-phone-axe.json) identifies the exact list and invalid child type.

**Impact:** Screen readers cannot rely on the promised list structure/count. The buttons remain interactive, but their grouping semantics are invalid.

**Recommendation:** Use native `ul`/`li` containing full-row buttons, or add valid list-item wrappers. Check populated and empty lists and keyboard order. Similar patterns elsewhere warrant inspection, but this finding is verified specifically for Chats.

**Confidence:** High; source and live scanner agree.

## Design assessments and proposed improvements

These are product proposals, not additional verified defects or commitments.

### D1 — Give the conversation and working result the default space

In the sampled 1258px desktop Code layout, the app rail, chat sidebar and file tree leave approximately 560px for the conversation. The file tree itself occupies approximately 350px. This is a visible allocation problem for the agreed chat-first product, not proof that editing tools should disappear. The source default leaves the file sidebar expanded (`src/state/file-panel.ts:142`); an individual existing profile can of course override it.

Start a builder with the conversation dominant, a compact project/chat context, and a readily available result/preview pane. Reveal files when the user asks to inspect or edit them; remember the preference for people who work directly in code. Keep explicit access to diffs, terminal and failure logs so the result stays understandable and reviewable. Measure task completion and recovery, not how many tools remain simultaneously visible. [Desktop Code sample](evidence/ux-independent-code.png).

### D2 — Make setup end in the first useful build conversation

The welcome is warm and honest, but its maker letter asks for reading before the builder has experienced value. The step registry then covers theme, provider alternatives, model, routing, API keys, extras, GitHub, permissions, memory and Context7 (`src/onboarding/steps/registry.ts:24`); only applicable branches are shown. Many steps are skippable, which is good, but their existence still communicates a large configuration surface.

Prototype a shorter primary path: choose/connect a usable model, understand the immediate permission boundary, choose a project, describe a goal. Defer appearance, routing and optional integrations until relevant. End setup by placing a concrete starter goal in the real composer and explaining the next observable result. Preserve backup restore, explicit cloud/local choice and advanced setup. Time-to-first-useful-build needs a fresh-profile usability check; this review did not measure it.

### D3 — Keep supporting views legible as part of the same build

Source deliberately suppresses the conversation for several main-column views, including dev servers, overview and orchestration (`src/ui/main-column-overlay.ts:61`). It also has explicit logic to restore chat (`:198`), so this is not a claim that those screens are dead ends. Still, using a tool can temporarily remove the central conversation and its context.

Standardize a persistent project/task identity and an obvious return to the conversation. Where feasible, surface the relevant result beside the discussion: running preview, failing check, proposed change or active board task. Prefer one predictable supporting-pane model over teaching a different navigation pattern for each tool. Keep full-screen views when their work needs the space.

### D4 — Make settings search the reliable escape hatch

Preserve Startup & setup's common actions. Make provider failures link directly to the actionable connection page and distinguish “optional provider unavailable” from “the selected model cannot answer.” A persistent unreachable-LM-Studio toast appeared in this scratch profile even though a fake model/chat was present. That observation is useful for evaluating message context, but it does not prove a production provider-routing defect; the Models reviewer owns that diagnosis.

Settings should explain consequences in task terms: what a change allows Minnow to do, whether it applies to this project or all projects, and whether work can continue before it is configured. Progressive disclosure suits chat-driven building better than hiding advanced controls or forcing configuration into conversation-only commands.

### D5 — Expand accessibility verification around workflows

The current token checks are valuable and green. Add focus lifecycle and rendered contrast checks to the first-run/Code/phone paths, with landmarks around the actual composer and phone content. Axe also reported the `region` best-practice rule on sampled Code/setup/phone content; this is a navigational quality issue, not automatically a WCAG failure. Mobile sheets have their own Escape/focus restoration logic (`src/mobile/sheet.ts:34`); inspect their focus containment when implementing the shared dialog fix rather than assuming the onboarding result proves all sheets fail.

Test 200% zoom, a narrow desktop window, keyboard-only use, one screen reader and actual mobile keyboard/safe-area behavior before calling the experience accessible. Maintain the existing reduced-motion conventions. No broad WCAG certification or product quality score is justified by these samples.

## Checks actually performed

- Read-only source inspection and Impeccable product/audit context loading; no production edits.
- Unique browser session against the root's scratch app. Selected Sandbox at the workspace gate, inspected Code and Settings, reopened setup, verified modal reverse-Tab/Escape, loaded `?mobile=1` at 390×844, inspected Chats/conversation, verified reverse-Tab leakage. No real credentials, provider installation, destructive action or external account was used.
- `agent-browser doctor --offline --quick`: 5 pass, 2 warnings, 0 failures after an initial browser open returned EOF. A subsequent own-session tab worked. The initial tool failure is not a Minnow defect.
- Default axe 4.12.1 scans: Code **2 rule categories / 7 nodes** (contrast 2, region 5); setup **1 rule category / 1 node** (region); phone Chats **3 rule categories / 7 nodes** (required children 1, contrast 4, region 2). The full JSON is retained. Incomplete results, including unresolved lazy `aria-controls` and obscured/pseudo-element contrast, were not promoted to confirmed defects.
- `node --import tsx --test test/theme-contrast.test.mts`: **73/73 pass**. This demonstrates the rendered failures can coexist with the current narrower token assertions.
- Screenshot evidence: [workspace gate](evidence/ux-independent-desktop.png), [Code](evidence/ux-independent-code.png), [Settings](evidence/ux-independent-settings.png), [setup](evidence/ux-independent-onboarding.png), [phone Chats](evidence/ux-independent-phone.png), [phone conversation](evidence/ux-independent-phone-chat.png).

The fake model's “Done.” answer is a harness behavior and was not used to assess Minnow's conversational ability. Screenshot/provider state belongs to an already-used scratch profile, not a pristine install. No broad build, full suite, Lighthouse score or timed startup measurement was run for this section.

## Cross-vertical decisions

Fix the focus/phone isolation/contrast/list defects as repairs. Separately decide the default Code pane allocation and minimum first-run path around the chat-driven product direction. Coordinate onboarding wording with Models/provider recovery, phone behavior with remote-device security and shared session ownership, and supporting panes with the Code runtime-tools report. Reef's place in navigation remains a product decision; the hidden desktop focus defect does not decide it.
