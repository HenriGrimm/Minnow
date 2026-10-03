---
name: min-109-auto-save-settings
overview: Replace manual Settings and Models save steps with validated auto-save behavior while retaining explicit transactional, credential, destructive, test, and runtime actions.
todos:
  - id: W1-A
    content: "Wave 1: Add the shared auto-save controller"
    status: pending
  - id: W2-A
    content: "Wave 2: Convert Settings configuration forms"
    status: pending
  - id: W2-B
    content: "Wave 2: Convert Settings entity and provider editors"
    status: pending
  - id: W2-C
    content: "Wave 2: Convert Models configuration surfaces"
    status: pending
  - id: W3-A
    content: "Wave 3: Add cross-surface regression coverage"
    status: pending
isProject: true
---

# MIN-109 — Auto-save Settings and Models

**Date:** 2026-10-02
**Goal:** Persist every valid Settings and Models configuration change without requiring a manual Save button.
**Granularity:** medium

## Context

MIN-109 explicitly covers both Settings and every Models page. The repository currently mixes immediate persistence (Settings sampler/thinking/model routing and Models inspector settings) with grouped Save buttons (browser, search, research, entity/provider editors, CLI, routers, and voice). Use immediate change events for selects/radios/checkboxes and a short debounce plus blur flush for text/number fields. Never persist invalid intermediate values. Serialize each form's writes and use latest-value-wins semantics so slow responses cannot overwrite newer edits. Hydration must not trigger writes and failed edits must remain visible and retryable.

Creation/deletion, credential storage or rotation, backup passphrases, imports/exports, tests, downloads, model load/eject, and server install/start/stop remain explicit actions; they are transactions, not ordinary settings persistence. No new third-party API or dependency is needed.

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `src/ui/settings-auto-save.ts` | Shared debounce, validation, serialization, and status lifecycle | CREATE |
| `test/ui/settings-auto-save.test.mts` | Auto-save controller unit tests | CREATE |
| `src/ui/settings-browser.ts` | Browser behavior and allowlist | MODIFY |
| `src/ui/settings-search-section.ts` | Search provider, keys, fallbacks, limits | MODIFY |
| `src/ui/settings-research-section.ts` | Research model and limits | MODIFY |
| `src/ui/settings-entity-editor.ts` | Compaction, prompt, work-agent, binding, and type editors | MODIFY |
| `src/ui/settings-providers.ts` | Provider edit forms | MODIFY |
| `src/ui/settings-plugin-packages.ts` | Plugin connection fields | MODIFY |
| `src/ui/settings-issues.ts` | Issue settings | MODIFY |
| `src/ui/settings-sections.ts` | Prompt/meta and inline settings | MODIFY |
| `src/ui/settings-skills.ts` | Skill editor | MODIFY |
| `src/ui/models/cli-panel.ts` | Agent CLI configuration | MODIFY |
| `src/ui/models/routers-panel.ts` | Model pool/router editor | MODIFY |
| `src/ui/models/voice-panel.ts` | STT/TTS configuration | MODIFY |
| `src/ui/models/models-settings-panel.ts` | Storage and Hugging Face settings | MODIFY |
| `test/ui/settings-auto-save-contract.test.mts` | Cross-surface save-button contract | CREATE |

## Wave Breakdown

### Wave 1 — Shared behavior

#### Task W1-A: Add the shared auto-save controller
- **Build:** Create `src/ui/settings-auto-save.ts` with exported `createAutoSaveController`, `bindAutoSaveForm`, `AutoSaveController`, and `AutoSaveState`. Support injected `read`, optional synchronous `validate`, async `save`, configurable debounce, immediate discrete-control changes, text input debounce, blur/change flush, hydration suppression, `flush()`, and `dispose()`. Serialize writes, coalesce queued edits to the newest snapshot, and suppress stale completion callbacks. Publish `idle | dirty | saving | saved | error` without replacing edited values after failure.
- **Test:** Add `test/ui/settings-auto-save.test.mts`; run `node --import tsx --import ./test/test-loader.mjs --test --test-force-exit test/ui/settings-auto-save.test.mts`. Assert hydration emits no save, discrete controls save immediately, text debounces, blur flushes, invalid values are withheld, rapid edits serialize to the newest snapshot, stale completions do not publish success, errors retain dirty state, and disposal cancels pending work.
- **Accept:** A bound form persists only its latest valid state without a Save button or overlapping API writes.
- **Touches:** `src/ui/settings-auto-save.ts`, `test/ui/settings-auto-save.test.mts`

### Wave 2 — Surface conversions

#### Task W2-A: Convert Settings configuration forms
- **Build:** Use `bindAutoSaveForm`/`createAutoSaveController` in `renderBrowserSettingsSection`, `renderSearchSettingsSection`, and `renderDeepResearchSettingsSection`, preserving `saveBrowserMeta`, `saveSearchConfig`, `saveResearchConfig`, normalization, cache invalidation, offline guards, and error messages. Convert configuration groups in `src/ui/brain/settings-section.ts` using `saveSynthesisConfig`, `saveMemoryEmbeddingsConfig`, and `saveBrainCodeConfig`, but keep Download/Reindex/git-hook actions explicit. Audit `src/ui/settings-sections.ts` for remaining grouped configuration saves and convert them; keep credentials, profile capture, rules, import/export, reset, and destructive actions explicit. Remove obsolete action rows and stale “click Save” copy.
- **Test:** Extend focused Settings UI tests and run `npm run test:settings`. Assert field changes persist without clicks, hydration makes zero writes, invalid browser/search/research values do not write, rapid textarea/number edits coalesce, and failures leave values visible.
- **Accept:** Every ordinary top-level Settings configuration field persists on change or typing pause without a manual settings Save control.
- **Touches:** `src/ui/settings-browser.ts`, `src/ui/settings-search-section.ts`, `src/ui/settings-research-section.ts`, `src/ui/settings-sections.ts`, `src/ui/brain/settings-section.ts`, `test/ui/settings-*.test.mts`, `test/ui/brain-settings*.test.mts`
- **Depends on:** W1-A

#### Task W2-B: Convert Settings entity and provider editors
- **Build:** Refactor `mountCompactionKnobs`, `mountPromptFileEditor`, `mountWorkAgentEditor`, and work-agent/type binding editors in `src/ui/settings-entity-editor.ts` to auto-save through existing callbacks. Convert existing-provider forms in `src/ui/settings-providers.ts`, plugin connection forms in `src/ui/settings-plugin-packages.ts`, configuration fields in `src/ui/settings-issues.ts`, and `mountSkillEditor` in `src/ui/settings-skills.ts`. Validate whole-form invariants (including compaction high/low gap and required provider fields), debounce prompt/SKILL text, guard entity/profile switches against stale completions, and retain Reset/Create/Delete/Disconnect/token/rule actions. Preserve diff/baseline refresh after confirmed saves.
- **Test:** Update `test/ui/settings-entity-editor.test.mjs` and provider/plugin/issues/skills suites; run `npm run test:settings`. Assert unchecked booleans persist as `false`, prompt edits save per selected profile, stale results cannot cross profiles/entities, invalid forms do not write, and explicit transactional controls remain.
- **Accept:** Valid Settings entity edits persist automatically while transactional entity and credential actions remain deliberate.
- **Touches:** `src/ui/settings-entity-editor.ts`, `src/ui/settings-providers.ts`, `src/ui/settings-plugin-packages.ts`, `src/ui/settings-issues.ts`, `src/ui/settings-skills.ts`, `test/ui/settings-entity-editor.test.mjs`, `test/providers/settings-provider-filter.test.mts`, `test/ui/settings-plugins.test.mjs`, `test/issues/settings-issues-section.test.mts`, `test/ui/settings-skills-library.test.mjs`
- **Depends on:** W1-A

#### Task W2-C: Convert Models configuration surfaces
- **Build:** In `src/ui/models/cli-panel.ts`, replace submit-only settings with per-CLI controllers calling `deps.updateSettings`, respecting native validity and isolating Enable/Verify/Install/Sign in. In `src/ui/models/routers-panel.ts`, replace `markDirty` and the Save configuration button with scheduled serialized `commit` calls for router/default/entry mutations, ensuring refresh/render cannot lose queued edits. In `src/ui/models/voice-panel.ts`, bind STT/TTS configuration shells to `saveSttSettings` and `saveTtsSettings`, remove Save settings actions/copy, and `flush()` valid configuration before the real Test mic/Test voice click continues. Preserve user activation: microphone/audio tests begin only from those clicks. Retain existing `persistDraft` launch auto-save and inference sampler behavior in `src/ui/models/inspector.ts`. Audit `mountModelsSettingsSection`; keep Add/Browse/Clear and encrypted Hugging Face token submission explicit.
- **Test:** Extend `test/ui/models-cli-panel.test.mts`, `test/model-routers/availability.test.mjs`, voice tests, and `test/ui/models-inspector-launch-sliders.test.mts`. Run `npm run test:settings && npm run test:voice` plus the named Models tests. Assert CLI validity gating, serialized router saves across rerenders, STT/TTS flush-before-test, editable failures, and no duplicate inspector saves.
- **Accept:** No Models configuration field requires Save settings/configuration, while credentials, downloads, installs, runtime lifecycle, and model loading remain explicit.
- **Touches:** `src/ui/models/cli-panel.ts`, `src/ui/models/routers-panel.ts`, `src/ui/models/voice-panel.ts`, `src/ui/models/models-settings-panel.ts`, `test/ui/models-cli-panel.test.mts`, `test/model-routers/availability.test.mjs`, `test/ui/models-inspector-launch-sliders.test.mts`, `test/voice/*.test.mjs`
- **Depends on:** W1-A

### Wave 3 — Regression contract

#### Task W3-A: Add cross-surface regression coverage
- **Build:** Create `test/ui/settings-auto-save-contract.test.mts` with exported test helpers `collectManualSettingsSaveLabels` and `assertAllowedExplicitAction`. Inventory every released Settings section and Models route and reject generic manual controls such as “Save settings,” “Save changes,” and “Save configuration.” Maintain a narrow allowlist for credentials/passphrases, entity creation, reset/capture, imports/exports, and authored artifacts rather than globally banning “save.” Update stale source copy and affected existing selectors.
- **Test:** Run the new test directly, `npm run test:settings`, `npm run test:voice`, `npm run test:check-coverage`, `npx tsc --noEmit`, and `npm run build`. The contract failure must name the regressed surface/control.
- **Accept:** Automated coverage proves released Settings and Models configuration surfaces are auto-save-only and documents every retained explicit Save action.
- **Touches:** `test/ui/settings-auto-save-contract.test.mts`, `test/ui/settings-page-html.test.mjs`, `test/os/models-app.test.mts`, `src/ui/settings-*.ts`, `src/ui/models/*.ts`
- **Depends on:** W2-A, W2-B, W2-C

## Verification Checklist

- [ ] `npm run test:settings` passes.
- [ ] `npm run test:voice` passes.
- [ ] Focused Models tests named in W2-C pass.
- [ ] `npm run test:check-coverage` recognizes new tests.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run build` passes.
- [ ] Rapid edits serialize and the final persisted value matches the UI after reload.
- [ ] Invalid input is withheld with actionable feedback.
- [ ] Offline sections retain existing behavior.
- [ ] Credential, destructive, creation, import/export, test, download, install, and runtime actions remain explicit.
- [ ] Microphone and speech tests start only after clicking their app controls.

## Notes for Build Agents

Follow existing DOM/TypeScript style and `setStatus`; add no dependency. Treat “immediately” as change-triggered for discrete controls and short-debounced for typing controls. Do not remount a form to show save progress. Keep controllers per form, dispose on rerender, and key async completion to the active entity/profile.

Do not auto-submit secrets per keystroke. Hugging Face tokens, API keys, plugin secrets, backup passphrases, and connection-token rotation remain explicit credential transactions. Add/New/Delete/Reset/Import/Export/Test/Install/Load/Eject/Start/Stop are commands, not settings persistence.

Before deleting a button, trace its handler for cache invalidation, model refresh, reindex, test preparation, or selection refresh and preserve those effects after successful auto-save.
