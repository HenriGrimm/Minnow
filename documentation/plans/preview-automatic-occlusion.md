---
name: preview-automatic-occlusion
planType: build
overview: Replace the hand-maintained registerChromePopover counter with VS Code-style automatic overlay detection for the native preview guest. Shell overlays carry one marker class; a tracker finds markers whose box overlaps the preview host and confirms with a hit-test. While the guest is visible, a cached JPEG frame refreshes about once a second so it can step aside at once. The main process never zero-sizes a guest while a capture is copying, notifications show a paused message, and all 30 registering modules plus the toast stack move to the marker.
---

# Automatic occlusion detection for the native preview guest

## Goal and scope

In the Electron shell the browser preview is a native `WebContentsView` composited above the renderer (`electron/preview-host.ts:667`), so no CSS stacking order can put a menu above it. Today every overlay must call `registerChromePopover()` (`src/ui/preview-electron-visibility.ts:93`). That counter is global and ignores geometry, and modules that forget it stay underneath; `src/ui/toast.ts` never registers.

After this work:

- **Marked overlays are found automatically.** Any element with the class `mn-occludes-preview` is detected; no feature calls a register function.
- **The guest hides only when covered.** It steps aside only when a marked overlay's box intersects that preview host's box *and* a hit-test at the overlap centre confirms the overlay is painted on top. A menu on the far side of the window leaves the page live.
- **No wait or flash on hide.** While the guest is visible, a cached JPEG of the page refreshes about once a second. The cached frame shows synchronously before the native view hides.
- **No zero-sizing mid-capture.** The main process never resizes a guest to 0×0 while a `capturePage` copy is in flight, which is the macOS hang described in `documentation/plans/browser-screenshot-macos-freeze.md`.
- **Toasts work and say why.** Toasts are marked overlays. When a notification is what covers the page, the frozen frame shows "Paused while a notification is open".
- **Secondary hosts get the same check.** The secondary split preview and the Reef preview (`src/ui/preview-instance-host.ts`) use the per-element overlap check instead of the global counter.

**Non-goals:**

- No change to the whole-app gates: foreground app, full-screen app pages, wiki overlay, Design Mode iframe swap, and agent reveal (`canPaintElectronPreviewHost`, `canAgentRevealPreviewPanel`). They stay exactly as they are.
- No `<webview>`, no iframe mode for localhost, no offscreen rendering.
- No header rewriting in `electron/preview-session.ts`.
- No change to `browser_screenshot` / `capturePreviewEntryBase64` semantics apart from the shared in-flight capture gate.
- No full browser end-to-end suite.

## Decisions and constraints

These are the reference design and the assumptions I made. Scope questions were skipped, so flag any assumption you disagree with.

- **Reference design.** This follows VS Code's `src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts` and `webContentsViewHost.ts`, which fixed the same bug in microsoft/vscode#311149 / PR #311198. The Brain note "How VS Code's integrated browser keeps menus above its native WebContentsView" summarizes it.
- **Marker contract.**
  - The class `mn-occludes-preview` goes on the element that visibly covers content. The name is verified unused in `src/`.
  - An optional `data-occluder-kind` takes one of `menu | dialog | panel | notification`. A missing kind means `panel`.
  - Transparent click-catcher layers get `mn-occluder-hit-exclude` so hit-testing looks through them.
  - A class (not a data attribute) is used so `document.getElementsByClassName` gives a live collection, as VS Code does.
- **Overlap test.**
  1. Intersect the overlay's client rect with the host's client rect, and take the centre of the intersection.
  2. Call `document.elementFromPoint` at that centre, re-hit-testing inside a shadow root if the hit has one. Excluded classes are skipped using `elementsFromPoint`.
  3. The overlay counts only if it `contains()` the hit element.
  4. Overlays that contain the host itself are skipped.
- **Hit-testing needs pointer events.** `elementFromPoint` skips `pointer-events: none` boxes. A marked overlay must therefore receive pointer events where it paints. `.mn-toast-stack` has `pointer-events: none` (`src/styles/toast.css:29`), so each `.mn-toast` is marked, not the stack. The stack's padding box would also over-report overlap.
- **Observer cost.**
  - **Structure observer.** One `MutationObserver` on `document.body` (`childList`, `subtree`), connected only while at least one native guest host is subscribed. Its callback ignores the records and schedules one animation-frame check, coalesced.
  - **Per-overlay observers.** Each marked overlay gets an observer on `style`/`class`/`childList` that invalidates its cached rect.
  - **Steady-state cost.** With zero marked overlays present (the normal case during chat streaming), a check is a length test of the live collection and no layout reads.
- **Force-hide hold stays, renamed.** The `registerChromePopover` / `unregisterChromePopover` pair becomes `holdPreviewGuestHidden()` / `releasePreviewGuestHidden()`, used only for surfaces whose geometry can't be measured. Today that is the `select:open` picker in `src/ui/native-select-preview-guard.ts`, which lives in a top-layer `::picker(select)` pseudo-element. The old names are deleted at the end, so a missed migration fails `npx tsc --noEmit`.
- **Cached frame.**
  - **Capture loop.** It runs only while the guest is visible, the document is visible, and Electron preview exists. It captures through a new `capturePlaceholder` IPC that returns JPEG quality 80 and never temporarily reveals a hidden guest.
  - **Timing.** One second between the end of one capture and the start of the next. The loop skips a tick if the host bounds changed in the last 300 ms.
  - **Mounting.** The frame lives in an always-mounted, hidden `<img>` inside the host. Showing it is a synchronous `hidden = false`.
  - **Fallback.** If no frame is cached yet, keep today's on-demand immediate capture (`preparePreviewPopoverSnapshot`).
- **Capture gate in the main process.** `PREVIEW_HIDE` and `hidePreviewHostEntry` call `view.setVisible(false)` immediately, which is the visual hide. They defer the 0×0 `setBounds` until in-flight captures on that entry settle. A capture already has a 250 ms immediate timeout or the 3 s normal bound. A show that arrives before the deferred resize runs cancels it.
- **Paused message.** Shown over the frozen frame only when a `notification`-kind overlay is among the overlaps. The text matches VS Code: heading "Paused while a notification is open", detail "Dismiss the notification to keep using the browser." It uses `--mn-*` tokens only and no icons. It has `pointer-events: none` and is excluded from hit-testing because it sits inside the host.
- **Alternative not taken:** moving the toast stack left of the preview pane so it never overlaps. It's simpler, but it doesn't solve the general problem. Add it later if the paused state feels intrusive.
- **Test environment.** happy-dom has no layout, so the tracker takes injectable `getRect` and `hitTest` functions. Unit tests drive overlap with fixed rectangles; real geometry is checked once in the Electron smoke step.

## Relevant files

| File | Role | Change |
|---|---|---|
| `src/ui/preview-occlusion.ts` | Overlay tracker | **CREATE**: marker constants, `markPreviewOccluder`, `createPreviewOcclusionTracker`, `subscribePreviewOcclusion`, `getPreviewOccluders` |
| `src/ui/preview-electron-visibility.ts` | Primary guest visibility gate | **MODIFY**: replace `isChromePopoverOpen()` in `shouldShowElectronPreviewHost` / `runElectronPreviewHostLayoutSync`; rename the hold API; replace `onChromePopoverChange` with `onPreviewOcclusionChange` |
| `src/ui/preview-popover-snapshot.ts` | Snapshot `<img>` | **MODIFY**: per-host cached frame plus capture loop, keeping the on-demand fallback |
| `src/ui/preview-instance-host.ts` | Secondary/Reef native guests | **MODIFY**: per-element overlap check and cached frame |
| `electron/preview-capture-gate.ts` | In-flight capture tracking | **CREATE**: pure helper, testable without Electron |
| `electron/preview-host.ts` | Native host | **MODIFY**: `hidePreviewHostEntry`, `PREVIEW_HIDE`, `capturePreviewEntryBase64`, new `PREVIEW_CAPTURE_PLACEHOLDER` handler |
| `electron/preview-guest-actions.ts` | `previewCapturePageBase64` | **MODIFY**: `format: 'jpeg'` option |
| `electron/ipc-channels.ts`, `electron/preload.ts`, `src/electron.d.ts` | IPC surface | **MODIFY**: `capturePlaceholder(tabId?, instanceId?)` |
| `src/ui/toast.ts` | Toasts | **MODIFY**: mark each `.mn-toast` as `notification` |
| `src/styles/preview-panel.css` | Snapshot/paused styles | **MODIFY** |
| 30 modules calling `registerChromePopover` (listed in steps 7 and 8) | Overlays | **MODIFY**: mark root, drop register/unregister |
| `test/ui/preview-occlusion.test.mts`, `test/electron/preview-capture-gate.test.mts` | New tests | **CREATE** |
| `test/ui/preview-electron-visibility.test.mts`, `test/ui/preview-popover-snapshot.test.mts`, `test/ui/preview-instance-host.test.mts`, `test/ui/preview-chrome-popover-panels.test.mts`, `test/ui/native-select-preview-guard.test.mts` | Existing tests | **MODIFY** |
| `documentation/context.md` (Preview browser bullet, around line 1409) | Architecture reference | **MODIFY** |

**Run one test file** with the same flags as `test/test-config.mjs` → `tsx-mocks-loader`:

```bash
node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --import ./test/assert-dom-safe.mjs --test --test-force-exit <file>
```

The steps below call this `RUN_TS <file>`.

## Implementation steps

### 1. Overlay tracker module
- [ ] `src/ui/preview-occlusion.ts` detects marked overlays covering a given host element, with injectable geometry.
- Changes: Create the tracker module with the following parts.
  - **Exports:**
    - `PREVIEW_OCCLUDER_CLASS = 'mn-occludes-preview'` and `PREVIEW_OCCLUDER_HIT_EXCLUDE_CLASS = 'mn-occluder-hit-exclude'`.
    - `type PreviewOccluderKind = 'menu' | 'dialog' | 'panel' | 'notification'`.
    - `markPreviewOccluder(el: HTMLElement, kind: PreviewOccluderKind = 'panel'): void`, which adds the class and sets `dataset.occluderKind`.
  - **Tracker factory:** `createPreviewOcclusionTracker(options: { doc: Document; getRect?: (el: Element) => DOMRectReadOnly; hitTest?: (x: number, y: number) => Element | null })`. It returns `{ getOverlaps(host: HTMLElement): PreviewOccluderInfo[]; subscribe(listener: () => void): () => void; invalidate(): void; dispose(): void }`, where `PreviewOccluderInfo = { element: HTMLElement; kind: PreviewOccluderKind; rect: DOMRectReadOnly }`.
  - **Observer lifecycle:**
    - The body observer and per-overlay observers connect on the first subscriber and disconnect on the last (mirror `MicrotaskEmitter` `onWillAddFirstListener` in VS Code).
    - Rect caching uses a `WeakMap<Element, DOMRectReadOnly>`. A per-overlay observer invalidates it on `style`/`class`/subtree changes, and `invalidate()` clears it.
    - Notifications go through one `scheduleAnimationFrame` from `src/lib/schedule-animation-frame.ts`.
  - **Hit-test:** default `hitTest` = `elementFromPoint`, falling back to `elementsFromPoint(...).find(not excluded)` when the topmost hit is excluded, then re-run inside `hit.shadowRoot` when present.
  - **Module singleton:** `subscribePreviewOcclusion(listener)` and `getPreviewOccluders(host)` bound to `document`, created lazily, plus `resetPreviewOcclusionForTests()`. Add a window `resize` listener while subscribed that calls `invalidate()`.
  - Comment density: one-line JSDoc per export, matching `preview-electron-visibility.ts`.
- Verify: create `test/ui/preview-occlusion.test.mts` (happy-dom, fixed rectangles via injected `getRect`/`hitTest`). Then `RUN_TS test/ui/preview-occlusion.test.mts` passes with these cases:
  - (a) No marked elements → `[]`.
  - (b) Marked menu at `{0,0,100,100}`, host `{200,0,400,300}` → `[]`, because they don't intersect.
  - (c) Marked menu `{150,0,100,100}` intersecting the host, with `hitTest` returning a child of the menu → one entry with `kind: 'menu'`.
  - (d) Same geometry but `hitTest` returns a host child → `[]`, because the menu is underneath.
  - (e) Topmost hit carries `mn-occluder-hit-exclude` → the next element from the injected `elementsFromPoint` list decides.
  - (f) An overlay that contains the host is ignored.
  - (g) A subscriber is called once per animation frame after appending a marked element, and not after its own `unsubscribe`.
  - (h) Toggling the `style` attribute of a marked element invalidates its cached rect: the next `getOverlaps` calls `getRect` again.

### 2. Main-process capture gate and placeholder capture IPC
- [ ] The native host never zero-sizes a view mid-capture, and exposes a JPEG placeholder capture that never reveals a hidden guest.
- Changes: Add the gate, the deferred hide, the JPEG option and the placeholder channel.
  - **Capture gate.** Create `electron/preview-capture-gate.ts` with `createPreviewCaptureGate()` returning:
    - `track<T>(key: object, capture: Promise<T>): Promise<T>`
    - `whenIdle(key: object): Promise<void>` (resolves immediately when none are in flight)
    - `inFlight(key: object): number`
    
    It is keyed by `PreviewHostEntry`, with no Electron imports.
  - **Hide path in `electron/preview-host.ts`.**
    - Add a module-level `captureGate`. Wrap both capture calls in `capturePreviewEntryBase64` with `captureGate.track(entry, ...)`.
    - Split `hidePreviewHostEntry(entry)`: set `entry.visible = false` and `view.setVisible(false)` (plus devtools) immediately. Then, if `captureGate.inFlight(entry) > 0`, defer the `setBounds({0,0,0,0})` calls until `whenIdle(entry)` resolves; otherwise run them synchronously.
    - Store a `pendingZeroBounds` token on the entry. `applyPreviewViewBounds` / `showPreviewGuestIfHidden` clear it so a show that lands first wins.
  - **JPEG option.** In `electron/preview-guest-actions.ts`, add `format?: 'png' | 'jpeg'` to `PreviewCapturePageOptions`. The immediate branch returns `image.toJPEG(80)` base64 when `format === 'jpeg'`.
  - **Placeholder channel.**
    - Add `PREVIEW_CAPTURE_PLACEHOLDER = 'minnow:preview:capture-placeholder'` to `electron/ipc-channels.ts`.
    - Its handler in `registerPreviewHostIpc` returns `''` unless the active entry is `visible`. Otherwise it returns `captureGate.track(entry, previewCapturePageBase64(wc, { immediate: true, captureTimeoutMs: 250, format: 'jpeg' }))`.
    - Expose `capturePlaceholder(tabId?: string, instanceId?: string): Promise<string>` in `electron/preload.ts` and type it on `MinnowPreviewApi` in `src/electron.d.ts:236`.
- Verify: All three checks below pass.
  - New `test/electron/preview-capture-gate.test.mts`, run with `RUN_TS`:
    - `whenIdle` resolves only after every tracked promise settles, including rejection.
    - Different keys are independent.
    - `inFlight` counts correctly.
  - `npx tsc --noEmit` passes.
  - `RUN_TS test/electron/preview-guest-reveal.test.mts test/electron/preview-browser-actions.test.mjs` still passes.

### 3. Cached frame per host
- [ ] `src/ui/preview-popover-snapshot.ts` keeps an always-mounted hidden frame per host, refreshed about once a second while that host's guest is visible.
- Changes: Extend `src/ui/preview-popover-snapshot.ts` and its styles.
  - **Cache API.** Add `startPreviewFrameCache(host: HTMLElement, instanceId?: string): () => void`:
    - Creates `img.preview-popover-snapshot` with `hidden = true`, `alt=''`, `aria-hidden`.
    - Loops `api.capturePlaceholder(undefined, instanceId)`, then `img.src = 'data:image/jpeg;base64,...'` after a successful `decode()`. The next tick is scheduled one second after the previous capture *ends*.
    - Skips ticks while `document.visibilityState === 'hidden'`, or while `noteHostBoundsChanged(host)` was called within the last 300 ms.
    - Ignores late results after stop. The returned function stops the loop and removes the img.
  - **Show/hide helpers.** `showCachedPreviewFrame(host): boolean` unhides the img and returns `false` when no frame has loaded yet. `hideCachedPreviewFrame(host)`.
  - **Compatibility.** Keep `preparePreviewPopoverSnapshot` / `clearPreviewPopoverSnapshot` as the no-cached-frame fallback, with unchanged behavior.
  - **Styles.** In `src/styles/preview-panel.css`, keep `.preview-popover-snapshot` and add `[hidden] { display: none; }` coverage for it.
- Verify: extend `test/ui/preview-popover-snapshot.test.mts`. Then `RUN_TS test/ui/preview-popover-snapshot.test.mts` passes with these cases:
  - The cache issues no capture while `visible` is false.
  - After a resolved capture, `showCachedPreviewFrame` returns `true` and the img `src` starts with `data:image/jpeg;base64,`.
  - A stop during an in-flight capture leaves no img.
  - A bounds change within 300 ms skips the tick.
  - The existing four tests still pass.

### 4. Wire the tracker into primary and secondary visibility
- [ ] Guest visibility depends on actual overlap of the host plus force-hide holds, not on a global counter.
- Changes: Update the primary gate, its lifecycle and the secondary hosts.
  - **Primary gate (`src/ui/preview-electron-visibility.ts`).**
    - Rename `chromePopoverOpenCount` / `registerChromePopover` / `unregisterChromePopover` / `isChromePopoverOpen` / `resetChromePopoverRegistryForTests` to `previewHideHoldCount` / `holdPreviewGuestHidden` / `releasePreviewGuestHidden` / `isPreviewHideHeld` / `resetPreviewHideHoldsForTests`.
    - **Temporarily** re-export the old names as aliases so steps 7 and 8 can migrate incrementally.
  - **Occlusion check.**
    - Add `isPreviewHostObscured(host: HTMLElement): boolean`, returning `isPreviewHideHeld() || getPreviewOccluders(host).length > 0`.
    - `shouldShowElectronPreviewHost()` becomes `canPaintElectronPreviewHost() && !isPreviewHostObscured(#previewBody)`.
    - Replace `onChromePopoverChange` with `onPreviewOcclusionChange(listener)`, which fires for hold changes and tracker changes.
  - **Hide path in `runElectronPreviewHostLayoutSync`.** When obscured but paintable:
    - Call `showCachedPreviewFrame(body)` first.
    - If it returns `false` and the guest was visible, fall back to `await preparePreviewPopoverSnapshot()`.
    - Then `api.hide()`.
    - On show, `hideCachedPreviewFrame` and `clearPreviewPopoverSnapshot`.
  - **Primary lifecycle.** Subscribe the tracker (and `scheduleElectronPreviewHostVisibilitySync`) only while `usesElectronPreview()`. Start the frame cache for `#previewBody` when `previewGuestVisible` flips true, and stop it when the guest hides for non-occlusion reasons (leaving Code, pane closed). Call `noteHostBoundsChanged` wherever `waitForStablePreviewBodyBounds` observes movement.
  - **Secondary hosts (`src/ui/preview-instance-host.ts`).**
    - `syncInstance` uses `isPreviewHostObscured(bound.element)`, shows the cached frame before `api.hide`, and subscribes via `onPreviewOcclusionChange`.
    - `bindPreviewInstanceToElement` starts `startPreviewFrameCache(element, instanceId)`, and `unbindPreviewInstance` stops it.
    - The `ResizeObserver` callback calls `noteHostBoundsChanged`.
- Verify: `RUN_TS test/ui/preview-electron-visibility.test.mts test/ui/preview-popover-snapshot.test.mts test/ui/preview-instance-host.test.mts test/ui/preview-secondary-slot.test.mts test/ui/preview-agent-reveal.test.mts` passes. Add these cases, using `resetPreviewOcclusionForTests` plus injected geometry:
  - A marked menu that does **not** intersect `#previewBody` leaves the guest shown, with no `hide` call.
  - An intersecting, hit-confirmed menu → `hide` is called, and the cached img is visible before it.
  - Removing the menu → `show`.
  - A hold with no overlays still hides.
  - An instance host obscured only on its own element hides that instance and not the primary.

### 5. Paused message for notifications
- [ ] A frozen frame caused by a notification says why.
- Changes: Add the paused-message helper, call it, and style it.
  - **Helper.** In `src/ui/preview-popover-snapshot.ts` add `setPreviewPausedMessage(host: HTMLElement, visible: boolean): void`. It lazily creates `.preview-paused` containing `.preview-paused__heading` ("Paused while a notification is open") and `.preview-paused__detail` ("Dismiss the notification to keep using the browser."), with `role="status"`.
  - **Call sites.** `runElectronPreviewHostLayoutSync` and `syncInstance` call it with `overlaps.some((o) => o.kind === 'notification')` while obscured, and `false` on show or clear.
  - **Styles.** In `src/styles/preview-panel.css`, a centred card over the snapshot with `pointer-events: none` and only `--mn-*` tokens. Reuse surface/border/text tokens from `.mn-toast` in `src/styles/toast.css`. No hex or rgba literals.
- Verify: `RUN_TS test/ui/preview-electron-visibility.test.mts` passes with these new cases.
  - In `test/ui/preview-electron-visibility.test.mts`, a hit-confirmed `notification` overlap renders `.preview-paused` with the heading text.
  - A `menu` overlap does not render it.
  - Dismissal removes or hides it.
  - `npm run check:icons` is unaffected (no icons added).

### 6. Shared overlay surfaces and the toast stack
- [ ] The high-traffic shared primitives use the marker, and toasts become notification occluders.
- Changes: Mark the shared surfaces, convert the select guard, and update their tests.
  - **Marking.** In each module, call `markPreviewOccluder(root, kind)` where the overlay root is created, and delete its `registerChromePopover` / `unregisterChromePopover` calls and any `chromePopoverRegistered` / `registered` bookkeeping:
    - `src/ui/toast.ts`: each `.mn-toast` element, `notification`.
    - `src/ui/context-menu.ts`: every `level.root`, including submenus, `menu`.
    - `src/ui/app-dialog.ts`: `overlayEl`, `dialog`.
    - `src/ui/command-palette.ts`: palette root, `dialog`.
    - `src/ui/model-select-picker.ts`: both panels at lines ~929 and ~1254, `menu`.
    - `src/ui/composer-model-trigger.ts`: panel, `menu`.
  - **Select guard.** `src/ui/native-select-preview-guard.ts` switches to `holdPreviewGuestHidden` / `releasePreviewGuestHidden`.
  - **Click-catchers.** If any of these roots is a transparent full-window click-catcher wrapped around the visible panel, mark the visible panel instead and add `mn-occluder-hit-exclude` to the catcher. Check this per module in its CSS file.
  - **Tests.** Rewrite `test/ui/preview-chrome-popover-panels.test.mts` so each surface asserts that its open root carries `mn-occludes-preview` with the expected `data-occluder-kind`, and that it is gone after close. That replaces the `isChromePopoverOpen()` assertions. Update `test/ui/native-select-preview-guard.test.mts` for the renamed hold API.
- Verify: Both checks below pass.
  - `RUN_TS test/ui/preview-chrome-popover-panels.test.mts test/ui/native-select-preview-guard.test.mts` passes.
  - Add a toast case: `showToast('x')` produces `.mn-toast.mn-occludes-preview[data-occluder-kind="notification"]`.
  - The existing toast tests found by `grep -l showToast test/ui` still pass.

### 7. Migrate the shell menus and popovers
- [ ] Menubar, workspace, git, models and chat popovers use the marker.
- Changes: mark the visible root and remove register/unregister calls (kind in parentheses):
  - `src/os/app-switcher-menu.ts` (menu)
  - `src/os/update-menubar.ts` (menu)
  - `src/ui/agent-activity-panel.ts` (panel)
  - `src/ui/browser-url-suggest.ts` (menu, both the suggest list and the history popover)
  - `src/ui/chat-search-popover.ts` (panel)
  - `src/ui/cli-account-usage-trigger.ts` (menu; it uses `showPopover`, so mark the popover element)
  - `src/ui/dev-server-form-popover.ts` (panel)
  - `src/ui/git-panel-name-popover.ts` (menu, all three openers)
  - `src/ui/model-pool-fields.ts` (menu)
  - `src/ui/models-popover.ts` (panel)
  - `src/ui/preview-browser-menu.ts` (menu)
  - `src/ui/scc-release-workflow.ts` (panel)
  - `src/ui/workspace-recent-menu.ts` (menu)
  - `src/ui/issue-capture-popover.ts` (panel)
- Verify: `RUN_TS test/ui/preview-browser-menu.test.mts test/ui/preview-chrome-popover-panels.test.mts` passes, plus each module's existing test file located with `grep -l "<module-name>" test`. `grep -rn "registerChromePopover" src/os src/ui` lists only the files in step 8 and the alias in `preview-electron-visibility.ts`.

### 8. Migrate dialogs, lightboxes and full panels, then delete the old API
- [ ] Every remaining caller uses the marker, and the old names no longer exist.
- Changes: Migrate the last callers, then remove the aliases and update test imports.
  - **Remaining callers** (kind in parentheses):
    - `src/ui/fork-model-dialog.ts` (dialog)
    - `src/ui/git-activity-overlay.ts` (panel)
    - `src/ui/git-help-lightbox.ts` (dialog)
    - `src/ui/issues-detail-layout.ts` (dialog on the host; the `issues-detail-scrim` is a visible dimmer, so mark it too as `dialog`)
    - `src/ui/issues-page.ts` (menu)
    - `src/ui/memory-saved-toast.ts` (notification)
    - `src/ui/orchestrate-run-help-lightbox.ts` (dialog)
    - `src/ui/settings-agent-center-lightbox.ts` (dialog)
    - `src/ui/shell-keyboard-help.ts` (dialog)
    - `src/ui/workspace-folder-picker.ts` (dialog)
  - **Delete the temporary aliases** from `src/ui/preview-electron-visibility.ts`.
  - **Update remaining test imports.** `test/ui/preview-electron-visibility.test.mts` and `test/ui/preview-popover-snapshot.test.mts` now use the hold API, or marked elements where the test means "a menu is open".
- Verify: All four checks below pass.
  - `grep -rn "registerChromePopover\|unregisterChromePopover\|isChromePopoverOpen\|onChromePopoverChange" src test` returns nothing.
  - `npx tsc --noEmit` passes.
  - `npm run test:check-coverage` passes.
  - `npm test` shows no new failures in `test/ui/**` or `test/electron/**`. AGENTS.md notes a few unrelated failures on `main`; compare against a baseline run.

### 9. Documentation
- [ ] `documentation/context.md` describes the new contract.
- Changes: Update the context reference and the agent gotchas.
  - In the **Preview browser** bullet (around line 1409), replace "or chrome popovers overlap the pane" with a short description:
    - the `mn-occludes-preview` marker and kinds, plus the geometry-then-hit-test check from `src/ui/preview-occlusion.ts`;
    - the force-hide hold for unmeasurable surfaces;
    - the 1 Hz visible-only JPEG frame cache;
    - the main-process deferred zero-bounds capture gate (`electron/preview-capture-gate.ts`);
    - the notification paused message;
    - the rule that marked overlays must receive pointer events.
  - Add one line to `AGENTS.md` **Key gotchas**: new overlays add `markPreviewOccluder(root, kind)`; do not add new hide holds unless the surface's geometry can't be measured.
- Verify: `npm run test:product-wiki` passes, and `grep -n "mn-occludes-preview" documentation/context.md AGENTS.md` shows both entries.

### 10. Electron smoke check
- [ ] Real geometry and timing behave in the desktop shell.
- Changes: none; this is verification only, with a two-minute budget. Run `npm start`, open Code, open the preview on any localhost page, then:
  1. Open the composer model menu while it does not overlap the preview pane. The page stays live: scroll it with the wheel.
  2. Right-click inside the file tree so the context menu stays left of the pane. The page stays live.
  3. Open the preview toolbar menu (`preview-browser-menu`), which drops over the page. The menu is fully readable and the page behind it is a frozen frame, not blank.
  4. Trigger an error toast (for example, open a nonexistent workspace file path via the command palette). The toast is readable over the pane and the paused message shows. Dismiss it and the live page returns.
  5. Open the secondary split with a preview and repeat step 3 against it.
  
  On macOS, also open and close the toolbar menu rapidly about ten times and confirm the app stays responsive.
- Verify: all five observations hold. Record pass or fail per item in the PR description. If a step can't be run (no display, for example), say so rather than marking it passed.

## Acceptance checklist
- [ ] A context menu, model menu or popover that does not overlap the preview pane leaves the live page interactive.
- [ ] Any marked overlay that overlaps the pane is fully visible above it, with a frozen page frame (not blank) behind it.
- [ ] Error toasts over the pane are readable and show "Paused while a notification is open"; dismissing restores the live page.
- [ ] The secondary split and Reef previews follow the same rules for their own hosts.
- [ ] `registerChromePopover` and its siblings no longer exist; `npx tsc --noEmit` passes.
- [ ] New tests in `test/ui/preview-occlusion.test.mts` and `test/electron/preview-capture-gate.test.mts` pass, and the existing preview suites have no new failures.
- [ ] No capture is issued while a guest is hidden, and no 0×0 resize happens while a capture is in flight. The capture-gate tests and the code review of `hidePreviewHostEntry` both cover this.
- [ ] `documentation/context.md` and `AGENTS.md` describe the marker contract.

## Risks and open questions

- **Paused notifications may annoy.** Success toasts last five seconds, but error toasts persist (`src/ui/toast.ts:110`), so the page stays frozen until dismissal. If that's unwelcome, the alternative is offsetting the toast stack away from the preview pane.
- **Animated overlays.** Rects are read once per mutation. A menu that slides in with a CSS transform (no attribute change) may be measured mid-animation. A one-frame-late detection is acceptable; if a surface is consistently missed, invalidate on its `animationend`.
- **One-frame flash.** Detection runs on the next animation frame after the overlay mounts, so the overlay can paint under the page for about one frame. VS Code accepts the same.
- **Pointer-events contract.** A marked overlay with `pointer-events: none` will never be confirmed. Step 6 handles the toast stack; other surfaces must follow the documented rule.
- **Capture cost.** About one JPEG per second per visible guest crosses IPC. That's acceptable per VS Code, but watch the `MINNOW_DEBUG=1` long-task log during step 10. If needed, raise the interval or pause while the window is unfocused.
- **macOS GPU copy.** The gate prevents zero-sizing mid-copy, but a periodic `capturePage` on a visible view is new load on macOS 26 WindowServer. Step 10 includes a rapid-toggle check; if it regresses, drop the loop and keep the on-demand fallback.
