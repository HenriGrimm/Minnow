---
name: min-30-model-menu-load-and-open-settings
overview: Replace the per-row Load/Unload buttons in every model menu with one menu-level action row containing exactly two actions — Load/Unload (acting on the currently selected model) and Open Settings (deep-link to that model's My Models load settings).
todos:
  - id: W1-A
    content: "Wave 1: Create src/ui/model-menu-actions.ts (mount + sync + openModelLoadSettings) with unit tests"
    status: pending
  - id: W2-A
    content: "Wave 2: Mount the menu-level action row in the top-bar, composer, and auxiliary model menus + styles"
    status: pending
  - id: W3-A
    content: "Wave 3: Delete the per-row Load/Unload button and flip the tests that pin it"
    status: pending
  - id: W3-B
    content: "Wave 3: Wire Open Settings to Models → My Models → inspector Load tab, with deep-link test"
    status: pending
  - id: W4-A
    content: "Wave 4: Update documentation/context.md and run full verification (npm test, tsc --noEmit)"
    status: pending
isProject: true
---

# MIN-30 — My Models settings from the models menu

**Date:** 2026-09-15
**Goal:** Every model menu keeps exactly two actions — **Load** and **Open Settings** — as menu-level controls, with no per-row Load button.
**Granularity:** medium

## Context

The model picker (`src/ui/model-select-picker.ts`) renders one `<li class="model-select-option">` per option through `appendModelOptionRow()`. When an option supports load/unload (`optionShowsInlineLoadUnload()`), each row gets its own `button.model-select-option-load-unload`, so a 40-model menu shows 40 Load buttons and there is **no way to reach a model's load settings from the menu at all**.

Three surfaces share that rendering path:

1. **Top-bar picker** — `#modelSelectRoot` / `#modelSelectMenu` in `index.html:291-297`, wired by `initModelSelectPicker()`.
2. **Composer / board / menubar chips** — `src/ui/composer-model-trigger.ts`; `createModelMenuPanel()` builds a `.composer-model-menu` panel per trigger (variants `desktop`, `code`, `chat`, `research`, `super-plan`, `menubar`, `board`).
3. **Auxiliary comboboxes** — `mountAuxiliaryModelSelectCombobox()`, used by `src/ui/compare-page.ts:218`, `src/ui/fork-model-dialog.ts:116`, `src/ui/scheduler/job-editor-overlay.ts:233`, `src/ui/settings-model-routing.ts:791`, `src/ui/capability-matrix/roster-panel.ts:84-95`.

The issue asks for the opposite shape: rows are **select-only**, and the menu carries two actions.

**Key insight that makes this cheap:** everything the actions need already exists.

- `toggleModelLoadForSelectValue(selectValue)` (`src/api/models.ts`) already loads **or** unloads from a composite `#modelSelect` value, holds the load lock, and updates status.
- `supportsLoadUnloadForSelectValue(sel, value)` (`src/api/models.ts`) already answers "can this row be loaded?" (true for `minnow-library::<id>` keys, otherwise reads `data-supports-load-unload="1"`).
- `setModelLoadUnloadButtonIdle/Busy/Unsupported(btn, …)` (`src/ui/model-load-unload-button.ts`) already paint the label + spinner.
- `showModelInInspector(modelId, 'load')` (`src/ui/models/inspector.ts:1610`) already opens the inspector on the Load tab; `library-panel.ts:293` uses exactly this for its per-row "Launch settings" button — this plan reuses that proven path.
- `openModels(section)` (`src/ui/models-page.ts:183`) already handles the OS-embedded case via `launchApp('models', { modelsSection })`.
- `decodeLibraryModelSelectKey(selectValue)` (`src/models/model-select-library.ts`) maps a composite key to a library id.

**Intended outcome:** pick a model in the menu → the menu-level Load acts on the **selected** model; Open Settings lands on that model's load settings in Models → My Models.

**Constraints / decisions taken (deviate only with reason):**

- **D1 — Actions act on the selected model, not the hovered row.** The Load/Unload button targets `resolveSelectValue()` — `#modelSelect.value` for the top bar, `resolveTriggerSelectValue(trigger)` for composer chips, `select.value` for auxiliary pickers. To load a *different* model, click its row first: `shouldKeepModelMenuOpenAfterSelect()` (`src/ui/model-select-picker.ts`) already keeps the menu open when the picked row supports load/unload and is not loaded, so select-then-Load is one continuous gesture.
- **D2 — The action row is a sibling of the `<ul>`, not inside the filter bar.** `test/ui/model-host-filter-actions.test.mts:50` asserts `host.querySelector('.model-host-filter-action--load-unload') === null`; keeping the actions out of `.model-host-filter-actions` keeps that assertion (and the compact icon-toolbar) untouched.
- **D3 — Open Settings only appears for My Models rows.** `decodeLibraryModelSelectKey()` returns null for cloud/LM Studio rows, so the button is `hidden` there — there are no load settings for a hosted model. (Alternative considered and rejected: showing it and routing to Models → Providers. It invites "why is this disabled?" and is out of the issue's scope.)
- **D4 — No new IPC or server work.** Everything is renderer-side composition of existing functions.

## Key Files

| File | Role | Action |
|------|------|--------|
| `src/ui/model-menu-actions.ts` | Menu-level action row: mount, sync, `openModelLoadSettings` | CREATE |
| `src/ui/model-select-picker.ts` | `appendModelOptionRow` (per-row Load), `ensureTopBarHostFilterBar`, `mountAuxiliaryModelSelectCombobox` | MODIFY |
| `src/ui/composer-model-trigger.ts` | `createModelMenuPanel()` — composer/board/menubar menu panels | MODIFY |
| `src/api/models.ts` | `updateModelLoadUnloadButtons()`, `syncModelOptionLoadUnloadButtonElement()`, `toggleModelLoadForSelectValue()` | MODIFY |
| `src/styles/model-select.css` | Styles for the new action row | MODIFY |
| `src/ui/models/inspector.ts` | `showModelInInspector(modelId, 'load')` — unchanged, called | READ |
| `src/ui/models-page.ts` | `openModels(section)` — unchanged, called | READ |
| `src/ui/models/store.ts` | `refreshModels()`, `selectModel()` — unchanged, called | READ |
| `src/models/model-select-library.ts` | `decodeLibraryModelSelectKey()` — unchanged, called | READ |
| `src/ui/model-load-unload-button.ts` | `setModelLoadUnloadButtonIdle/Busy/Unsupported` — unchanged, called | READ |
| `test/ui/model-menu-actions.test.mts` | New unit tests for mount/sync/deep link | CREATE |
| `test/ui/model-host-filter-actions.test.mts` | Pins the OLD behaviour (rows have Load; bar has none) | MODIFY |
| `test/api/ensure-chat-model-loaded.test.mts` | `mock.module` stubs for `model-select-picker` / `api/models` | MODIFY |

## Wave Breakdown

Tasks in a wave run concurrently unless they declare `Depends on:`.

### Wave 1 — The action-row module

#### Task W1-A: Create `src/ui/model-menu-actions.ts`
- **Build:**
  - Create `src/ui/model-menu-actions.ts` exporting exactly:
    - `export interface ModelMenuActionsOptions { resolveSelectValue: () => string; closeMenu: () => void; }`
    - `export function mountModelMenuActionsBar(parent: HTMLElement, options: ModelMenuActionsOptions): HTMLDivElement`
      - `div.model-select-menu-actions`, `role="group"`, `aria-label="Model actions"`, containing two `<button type="button">`s:
        - `.model-select-menu-action.model-select-menu-action--load-unload` (text `Load` / `Unload`, `aria-label` `Load model` / `Unload model`)
        - `.model-select-menu-action.model-select-menu-action--open-settings` (text `Open Settings`, `aria-label` `Open load settings`)
      - Both buttons: `addEventListener('mousedown', e => e.stopPropagation())` and `click` handlers that `stopPropagation()` + `preventDefault()` — same guard the current row button uses (`src/ui/model-select-picker.ts:997-1010`), otherwise the outside-click closer fires first and the action never runs.
      - Load/Unload click: resolve `options.resolveSelectValue().trim()`; if empty, return; otherwise `const { toggleModelLoadForSelectValue } = await import('../api/models'); await toggleModelLoadForSelectValue(value);` then re-sync this bar.
      - Open Settings click: `await openModelLoadSettings(value)` then `options.closeMenu()`.
    - `export async function openModelLoadSettings(selectValue: string): Promise<boolean>`
      - `const libraryId = decodeLibraryModelSelectKey(selectValue)` (static import from `../models/model-select-library`); if null → `return false` (decision **D3**).
      - `const { openModels } = await import('./models-page'); openModels('installed');`
      - `const { refreshModels } = await import('./models/store'); await refreshModels();` — **must** await before opening the inspector, otherwise `getSelectedModel()` finds nothing in `state.library` and the inspector renders "No model selected".
      - `const { showModelInInspector } = await import('./models/inspector'); showModelInInspector(libraryId, 'load'); return true;`
      - Wrap in try/catch → `setStatus('err', message)` from `./status`; return false.
    - `export function syncModelMenuActionsBar(bar: HTMLElement, selectValue: string): void`
      - Load/Unload button: `const sel = document.getElementById('modelSelect')`; if `!supportsLoadUnloadForSelectValue(sel, value)` → `setModelLoadUnloadButtonUnsupported(btn, isServerStorageMode())`; else if `isModelLoadUnloadBusy() && getModelLoadUnloadTargetSelectValue() === value` → `setModelLoadUnloadButtonBusy(btn, getModelLoadUnloadPhase())`; else `setModelLoadUnloadButtonIdle(btn, loaded, Boolean(value))` where `loaded = row ? isModelLoaded(row.state) : false` from `getModelRowForSelectOrCanonicalId(value)`, then `btn.disabled = isModelLoadUnloadBusy()`.
      - Open Settings button: `btn.hidden = !decodeLibraryModelSelectKey(value)`; when visible set `title`/`aria-label` to include the model id.
      - Store the options in a module-level `WeakMap<HTMLElement, ModelMenuActionsOptions>` (`menuActionsOptions`) so the sync-all helper can re-resolve the value.
    - `export function syncAllModelMenuActionsBars(): void` — iterate `document.querySelectorAll<HTMLElement>('.model-select-menu-actions')`, look up the options in `menuActionsOptions`, call `syncModelMenuActionsBar(bar, options.resolveSelectValue())`.
  - **Import-cycle rule:** this module may **statically** import from `../api/models`, `../models/model-select-library`, `./model-load-unload-button`, `./status`, `./icon`, `../config/storage-mode`, and `../lib/model-select-key`. It must import `./models-page`, `./models/store`, and `./models/inspector` **dynamically only** (`await import(...)`), because `inspector.ts → ./store → ../../api/models` would otherwise close a cycle through this module.
- **Test:** Create `test/ui/model-menu-actions.test.mts` (happy-dom pattern copied from `test/ui/model-host-filter-actions.test.mts`: build a `Window`, swap `globalThis.document/window/localStorage`, restore in `finally`). Assertions:
  1. `mountModelMenuActionsBar` renders exactly two `.model-select-menu-action` buttons and the group carries `aria-label="Model actions"`.
  2. With `modelCache.set('lmstudio::qwen/x', { id: 'qwen/x', state: 'loaded' })` and option `data-supports-load-unload="1"`, `syncModelMenuActionsBar(bar, 'lmstudio::qwen/x')` → Load/Unload button `textContent === 'Unload'`; with `state: 'not loaded'` → `'Load'`.
  3. With the option lacking `data-supports-load-unload`, the button is `hidden === true`.
  4. `syncModelMenuActionsBar(bar, 'minnow-library::gguf:acme/m:w.gguf')` → `.model-select-menu-action--open-settings` is **not** hidden; with `'openai::gpt-4o'` it **is** hidden.
  5. `await openModelLoadSettings('openai::gpt-4o')` resolves `false`; `await openModelLoadSettings('minnow-library::gguf:acme/m:w.gguf')` sets `getModelsState().selectedId` to `'gguf:acme/m:w.gguf'` and `isModelsInspectorOpen() === true` (mount the `#modelsView` / `#modelsInspector` DOM from `test/ui/models-inspector-visibility.test.mts`).
  - Run: `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --import ./test/assert-dom-safe.mjs --test --test-force-exit --test-timeout=120000 test/ui/model-menu-actions.test.mts` (this is the `tsx-mocks-loader` profile from `test/test-config.mjs`; new files under `test/` are auto-discovered by `npm test`, no `package.json` edit).
- **Accept:** That command exits 0 with all five assertions passing, and `npx tsc --noEmit` is clean for the new module.
- **Touches:** `src/ui/model-menu-actions.ts`, `test/ui/model-menu-actions.test.mts`

### Wave 2 — Mount the action row everywhere

#### Task W2-A: Mount the two actions in the top-bar, composer, and auxiliary menus
- **Build:**
  - `src/ui/model-select-picker.ts`:
    - Import `mountModelMenuActionsBar`, `syncModelMenuActionsBar` from `./model-menu-actions`.
    - In `ensureTopBarHostFilterBar()`: after `mountModelHostFilterBar(shell, { onFilterChange, onAfterRefresh })`, call `mountModelMenuActionsBar(shell, { resolveSelectValue: () => sel.value, closeMenu: closeModelSelectMenu })`. DOM order inside `.model-select-popover` must end up `[filter bar, menu, actions]` — the `<ul>` is already appended into the shell before the filter bar is mounted, so mount the actions bar **last**.
    - In `mountAuxiliaryModelSelectCombobox(select)`: after `root.appendChild(menu)`, `mountModelMenuActionsBar(root, { resolveSelectValue: () => select.value, closeMenu: () => closeAuxiliaryModelSelectMenu() })`.
    - Do **not** put these buttons inside `.model-host-filter-actions` (decision **D2**).
  - `src/ui/composer-model-trigger.ts`: in `createModelMenuPanel()`, after `mountModelHostFilterBar(panel, {...}, 'composer-model-menu__filter')` and after `panel.appendChild(menu)`, add `mountModelMenuActionsBar(panel, { resolveSelectValue: () => { /* same body as the existing resolveLoadUnloadValue */ }, closeMenu: closeComposerModelMenu })`. Factor the existing inline `resolveLoadUnloadValue` arrow into a local `const resolveLoadUnloadValue = () => {...}` so the filter bar and the action row share one resolver.
  - `src/styles/model-select.css`: add
    - `.model-select-menu-actions { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--mn-border); background: var(--mn-surface-0); }`
    - `.model-select-menu-action { flex: 1 1 auto; min-height: 28px; padding: 2px 8px; font-size: 11px; font-weight: 600; font-family: var(--font-ui); line-height: 1.2; color: var(--mn-fg); border: 1px solid var(--mn-border); border-radius: var(--radius-sm); background: var(--mn-bg); cursor: pointer; }` plus `:focus-visible`, `:disabled`, `.is-busy`, and a hover rule — copy the shapes of the existing `.model-select-option-action` rules (`src/styles/model-select.css:469-524`) so the visual language matches.
    - **Only `--mn-*` tokens / `color-mix(... var(--mn-*))`** — per `DESIGN.md` and `AGENTS.md`, hex/rgba literals live only in `src/styles/tokens.css`.
  - Keep `renderModelSelectMenuRows()`'s trailing `void import('../api/models').then(m => m.updateModelLoadUnloadButtons())` calls — that is how the action row re-syncs after a filter/search change or a load completes.
- **Test:**
  - Extend `test/ui/model-menu-actions.test.mts` with: `mountAuxiliaryModelSelectCombobox(select)` produces a `.model-select-menu-actions` inside the picker's `.model-select-inner`, as a sibling of `ul.model-select-menu` (assert `menu.nextElementSibling?.classList.contains('model-select-menu-actions')` is false/true as appropriate — the actions row comes **after** the list).
  - Re-run the existing suites that exercise these menus and must stay green: `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --import ./test/assert-dom-safe.mjs --test --test-force-exit --test-timeout=120000 test/ui/model-select-picker.test.mts test/ui/model-host-filter-context.test.mts test/ui/composer-model-select-shortcut.test.mts`.
  - Grep check: `grep -rn "model-host-filter-action--load-unload" src` → no matches (actions are not in the filter bar).
- **Accept:** With the app open (`npm start`), opening any model menu — top bar, composer chip, board chip, Compare page model picker — shows exactly one row with two buttons (`Load`, `Open Settings`) below the list, and no buttons inside the list rows once W3-A lands.
- **Touches:** `src/ui/model-select-picker.ts`, `src/ui/composer-model-trigger.ts`, `src/styles/model-select.css`
- **Depends on:** W1-A

### Wave 3 — Remove the per-row button; wire the deep link

#### Task W3-A: Delete the per-row Load/Unload button
- **Build:**
  - `src/ui/model-select-picker.ts`: in `appendModelOptionRow()`, delete the whole `if (optionShowsInlineLoadUnload(opt)) { … }` block (the `actionBtn` with class `model-select-option-load-unload model-select-option-action`) and delete the now-unused `optionShowsInlineLoadUnload()` helper. Keep everything else in the row — the `model-load-dot` state dot, `model-select-option-activity`, and capability badges all stay, so users can still see which models are loaded. Keep the `isModelLoadUnloadBusy() && id === getModelLoadUnloadTargetSelectValue()` → `loadState = 'loading'` branch (it drives the row dot).
  - `src/api/models.ts`: delete `syncModelOptionLoadUnloadButtonElement()` and rewrite `updateModelLoadUnloadButtons()` to `const { syncAllModelMenuActionsBars } = await import('../ui/model-menu-actions'); syncAllModelMenuActionsBars();` — keep the exported **name** and keep it callable synchronously (fire-and-forget the dynamic import: `void import('../ui/model-menu-actions').then(m => m.syncAllModelMenuActionsBars())`). Do not change any call site: it is called from `fetchModels()`, `loadModelForSelectValue()`, `unloadModelForSelectValue()`, `selectProviderModel()`, `syncModelSelectPicker()`, and `syncComposerModelTriggers()`.
  - `src/styles/model-select.css`: delete the now-dead `.model-select-option-action*` rules (lines ~469-524) — nothing renders that class any more.
  - `test/ui/model-host-filter-actions.test.mts`: flip the two tests that pin the old behaviour —
    - `'renderModelSelectMenuRows adds inline load/unload on local models'` (lines ~150-196): rename to `'renderModelSelectMenuRows renders no per-row load buttons'`; `assert.equal(localRow?.querySelector('.model-select-option-load-unload'), null)` and same for `cloudRow`; keep the row-count assertions.
    - `'syncModelOptionLoadUnloadButtonElement toggles load vs unload label'` (lines ~198-228): delete it (the function is gone) — coverage moves to `test/ui/model-menu-actions.test.mts`.
  - `test/api/ensure-chat-model-loaded.test.mts`: in the `mock.module('../../src/api/models.ts', …)` and `mock.module('../../src/ui/model-select-picker.ts', …)` blocks, drop `syncModelOptionLoadUnloadButtonElement` and add `updateModelLoadUnloadButtons: () => undefined` if missing (the stub must still cover every export importers use; `mountModelHostFilterBar: () => undefined` stays).
- **Test:**
  - `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --import ./test/assert-dom-safe.mjs --test --test-force-exit --test-timeout=120000 test/ui/model-host-filter-actions.test.mts test/ui/model-select-picker.test.mts test/api/ensure-chat-model-loaded.test.mts` → exit 0.
  - `grep -rn "model-select-option-load-unload\|syncModelOptionLoadUnloadButtonElement\|model-select-option-action" src test` → **no matches** (only the new `model-select-menu-action*` names remain).
  - `npx tsc --noEmit` → clean.
- **Accept:** `renderModelSelectMenuRows()` output contains zero elements with class `model-select-option-load-unload`; `grep -rn "model-select-option-load-unload" src` returns nothing.
- **Touches:** `src/ui/model-select-picker.ts`, `src/api/models.ts`, `src/styles/model-select.css`, `test/ui/model-host-filter-actions.test.mts`, `test/api/ensure-chat-model-loaded.test.mts`
- **Depends on:** W2-A

#### Task W3-B: Make Open Settings land on the model's load settings
- **Build:**
  - `src/ui/model-menu-actions.ts` (from W1-A): confirm `openModelLoadSettings()` works for a **composite** picker value (`minnow-library::gguf:acme/m:weights/model-Q4_K_M.gguf`) — `decodeLibraryModelSelectKey()` strips the composite encoding and returns the library id, which is the same id `library-panel.ts:293` passes to `showModelInInspector(model.id, 'load')`.
  - Cover the "menu is open while Models app is not foreground" case: `openModels('installed')` returns early after `launchApp('models', { modelsSection: 'installed' })` when `isOsEmbedded()` and the foreground app is not `models`. Because `openModelLoadSettings` then `await`s `refreshModels()` before calling `showModelInInspector()`, the inspector's module state (`activeTab`, `selectedId`) is already correct when `bindStaticSections() → initInspector() → render()` finally runs — verify this ordering with a test rather than assuming it.
  - If `refreshModels()` rejects (tool server down), still call `showModelInInspector()` so the user lands on My Models with the row selected, and surface `setStatus('err', …)`.
  - Do **not** add a new route or `ModelsSectionId`; `installed` already exists in `src/ui/models-section-ids.ts` and is the default.
- **Test:**
  - In `test/ui/model-menu-actions.test.mts`, assert: with `modelCache` seeded and a `#modelSelect` option `minnow-library::gguf:acme/model:weights/model-Q4_K_M.gguf`, `await openModelLoadSettings('minnow-library::gguf:acme/model:weights/model-Q4_K_M.gguf')` returns `true`, `getModelsState().selectedId === 'gguf:acme/model:weights/model-Q4_K_M.gguf'`, and `isModelsInspectorOpen() === true`. Stub `../../src/models/api-client.ts` (or `../../src/ui/models/store.ts`) with `mock.module` so no real serve is started — copy the stub discipline from `test/api/ensure-chat-model-loaded.test.mts` ("stub every export importers need; `mock.module` replaces the whole module").
  - Command: same `tsx-mocks-loader` invocation as W1-A.
- **Accept:** From a model menu with a My Models row selected, clicking **Open Settings** ends with Models → My Models open, that row selected, and the inspector showing the **Load** tab; clicking it with a cloud row selected leaves the menu with no Open Settings button at all.
- **Touches:** `src/ui/model-menu-actions.ts`, `test/ui/model-menu-actions.test.mts`
- **Depends on:** W1-A, W2-A

### Wave 4 — Docs and full verification

#### Task W4-A: Update the architecture doc and run the whole gate
- **Build:**
  - `documentation/context.md`: update the model-picker paragraphs (search for `My Models local scan` / the picker section) to state that model menus carry a single menu-level action row with **Load/Unload** and **Open Settings**, that rows are select-only, and name the new module `src/ui/model-menu-actions.ts`. Per `AGENTS.md` conventions, `documentation/context.md` must be updated when architecture changes.
  - Do **not** touch `documentation/manual/` unless it currently documents a per-row Load button — check with `grep -rn "Load" documentation/manual/apps/models.md` and correct only if it describes the row button (user-facing docs must describe what ships).
- **Test:**
  - `npm test` → all discovered suites pass (note: a few unrelated tests are known to fail on `main` per `AGENTS.md` — confirm any failure is pre-existing by checking the same file on a clean tree, and report which).
  - `npx tsc --noEmit` → clean.
  - `npm run test:product-wiki` → passes (CI runs it on every PR).
  - Manual check in `npm start` (or `MINNOW_HEADLESS=1 BROWSER=none npm start` + SPA at `http://localhost:9473`): open the composer model menu with a My Models row selected → exactly two actions, no row buttons; click **Load** → status shows "Loading model…" then "Model loaded", dot turns green; reopen and click **Unload** → "Model unloaded"; with a My Models row selected click **Open Settings** → Models → My Models with that row's Load tab open.
- **Accept:** `npm test` and `npx tsc --noEmit` both exit 0 (modulo pre-existing failures explicitly listed), and `documentation/context.md` names `src/ui/model-menu-actions.ts`.
- **Touches:** `documentation/context.md`, `documentation/manual/apps/models.md`
- **Depends on:** W3-A, W3-B

## Verification Checklist

- [ ] `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --import ./test/assert-dom-safe.mjs --test --test-force-exit --test-timeout=120000 test/ui/model-menu-actions.test.mts` passes (new suite).
- [ ] `test/ui/model-host-filter-actions.test.mts` passes with the inverted assertions — rows have **no** `.model-select-option-load-unload`, and `.model-host-filter-action--load-unload` is still absent.
- [ ] `npm test` passes (except failures verified as pre-existing on `main`).
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run test:product-wiki` passes.
- [ ] `grep -rn "model-select-option-load-unload" src` → nothing.
- [ ] Manual: every model menu (top bar, composer, board chip, Compare, fork dialog, scheduler job editor, Settings → Model routing, capability matrix) shows one action row with **Load** and **Open Settings**, never a per-row button.
- [ ] Manual: Load/Unload works from the menu without opening the Models app, and the button label flips with the selected model's state.
- [ ] Manual: Open Settings lands on that model's My Models **Load** tab with the row selected; hidden for cloud rows.
- [ ] `documentation/context.md` updated.

## Notes for Build Agents

- **The existing tests are the trap.** `test/ui/model-host-filter-actions.test.mts` currently *demands* the per-row Load button (line ~188) and *forbids* a bar-level one (line ~50). W3-A must invert the first and leave the second alone. If you instead put the buttons in the filter bar's `toolbarEnd`, that 50-line assertion breaks — don't.
- **Keep `updateModelLoadUnloadButtons` exported with the same name.** It is called from `src/api/models.ts` (`fetchModels`, `loadModelForSelectValue`, `unloadModelForSelectValue`, `selectProviderModel`), `src/ui/model-select-picker.ts` (`openModelSelectMenu`, `renderModelSelectMenuRows`), and `src/ui/composer-model-trigger.ts` (`openMenu`, `syncComposerModelTriggers`). Renaming it means touching all of them for no benefit.
- **Import cycles are real here.** `src/api/models.ts` must **not** statically import `src/ui/model-menu-actions.ts`, which statically imports `../api/models`. Use the dynamic import inside `updateModelLoadUnloadButtons()`. Likewise `model-menu-actions.ts` must reach `models-page.ts` / `models/store.ts` / `models/inspector.ts` only through `await import(...)`.
- **Don't break the row's other affordances.** Rows keep `model-load-dot` (state), `model-select-option-activity` (live PP/GEN suffix), capability badges, and the `title` tooltip — `test/ui/model-select-picker.test.mts` asserts on all of those. Only the button goes.
- **`selectModelInPicker` + `shouldKeepModelMenuOpenAfterSelect` stay as-is.** They are what let a user pick an unloaded model and still see the menu with Load available. That combination is the whole point of the redesign; verify it in the browser, not just in tests.
- **Styles:** `--mn-*` tokens only (`src/styles/tokens.css` owns hex/rgba). Match the density of the surrounding `model-select.css` rules; this row sits under the list and must not push it off-screen (the popover is capped at `max-width: min(90vw, 32rem)`; keep the actions row a single row of two buttons).
- **No server changes.** `/api/models/serve` and the library serve paths (`loadLibraryModelFromPicker`, `unloadLibraryModelFromPicker` in `src/models/model-select-library.ts`) already do the work.
- **Don't delete `showModelInInspector` / `showInspectorTab` / `library-panel.ts`'s per-row "Launch settings" button** — those are separate surfaces that keep working and are covered by `test/ui/models-inspector-*.test.mts`.
- **Tests must not start real serves.** Use `mock.module` on `src/models/api-client.ts` or `src/ui/models/store.ts` in the new test file; `setStorageModeForTests('server')` is required for any code path guarded by `isServerStorageMode()`.