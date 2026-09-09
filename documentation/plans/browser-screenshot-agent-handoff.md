# Agent handoff: `browser_screenshot` fails unless the preview pane is painted

## Goal

Make `browser_screenshot` reliable for agents even when the in-app browser pane is closed, covered, 0×0, or not painting. Today Chromium `webContents.capturePage()` needs a compositor surface. Hidden / never-shown guests return empty PNGs, hit the 3s timeout, or (macOS) can freeze WindowServer.

Do **not** treat this as “screenshot is unimplemented.” Navigate / eval / snapshot can still work on a hidden guest. Only raster capture is the broken path.

Related analysis: [`browser-screenshot-macos-freeze.md`](browser-screenshot-macos-freeze.md). Timeout + vision follow-up already shipped; hidden/0×0 refusal, paint-before-capture, capture mutex, and Design Mode skip are still open.

## Todos

- [ ] Confirm repro matrix (below) on Electron desktop: pane closed, Code overlay, Issues/Settings, Design Mode, wiki, chrome popover, happy path
- [ ] Fail closed: never call `capturePage` on destroyed / hidden / 0×0 guests — return a clear tool error
- [ ] Before capture, use the same reveal path as `browser_navigate` (`revealPreviewPanelForAgentNavigation` / `canAgentRevealPreviewPanel`), then wait for paint (or `webContents` `paint` / bounded rAF **after** show)
- [ ] Stop same-tick show-and-grab in `PREVIEW_CAPTURE_PAGE` (`electron/preview-host.ts`)
- [ ] Capture mutex: do not 0×0 / hide the view while capture is in flight
- [ ] Skip native capture in Design Mode for `browser_screenshot` and before/after diffs (region-capture already does this)
- [ ] Prefer compositor-safe capture if reveal is impossible: `capturePage(undefined, { stayHidden: true })` + `incrementCapturerCount`, or CDP `Page.captureScreenshot` after a paint
- [ ] Tests: hidden/0×0 short-circuit; no capture without paint; Design Mode skip; navigate-then-screenshot still works
- [ ] Update `documentation/context.md` Preview browser paragraph with the new capture contract

## What is true

`browser_screenshot` screenshots Minnow’s Electron `WebContentsView` preview guest, not the system browser and not an offscreen Playwright session.

Capture chain:

1. Renderer tool: [`src/tools/browser-preview-tools.ts`](../../src/tools/browser-preview-tools.ts) `browserPreviewScreenshot`
2. Prep: [`src/ui/preview-capture-ready.ts`](../../src/ui/preview-capture-ready.ts) `prepareElectronPreviewForCapture` → `showPreviewSplit()` + `syncElectronPreviewHostLayout()`
3. IPC: `window.minnow.preview.capturePage` → [`electron/preview-host.ts`](../../electron/preview-host.ts) `PREVIEW_CAPTURE_PAGE`
4. Native: [`electron/preview-guest-actions.ts`](../../electron/preview-guest-actions.ts) `previewCapturePageBase64` → `wc.capturePage()` (3s timeout, 3 empty-PNG retries)

`prepareElectronPreviewForCapture` is weaker than navigate. `browser_navigate` calls [`revealPreviewPanelForAgentNavigation`](../../src/ui/preview-panel.ts), which respects `canAgentRevealPreviewPanel()`. Screenshot only toggles the split. If Code is not foreground, `#previewBody` has no size, Design Mode is using the iframe guest, or an overlay covers the pane, [`shouldShowElectronPreviewHost()`](../../src/ui/preview-electron-visibility.ts) is false and layout sync **hides** the guest, then capture still runs.

If the guest was not visible, the IPC handler restores `lastBounds`, `addChildView`, `setVisible(true)`, then `capturePage` **on the same turn** — no paint wait. Missing `lastBounds` (pane never opened this session) captures a hidden 0×0 view. After capture, a temporarily shown guest is re-hidden (`shouldKeepPreviewGuestVisibleAfterCapture`).

Empty result maps to: *“Screenshot capture returned no image. Navigate with browser_navigate first, or ensure the preview guest is loaded in the Minnow desktop shell.”*

DOM tools (`browser_eval`, `browser_snapshot`, click, fill) use `executeJavaScript` and do not need a painted surface. A tool-surface test with the pane already open will pass screenshot and hide this bug.

## Repro matrix (expect fail unless noted)

| Setup | Expected today |
|---|---|
| Code workspace, preview pane open and painting, page loaded | **Pass** |
| Preview pane closed / never opened this session | Empty PNG or timeout |
| Pane open but 0×0 (collapsed split, chat overlay eating the column) | Empty / hang risk |
| User on Issues, Settings, wiki overlay, or a chrome popover | Guest hidden; capture still invoked |
| Design Mode on (iframe guest; native `WebContentsView` hidden) | Native `capturePage` on hidden view — region-capture already skips this; `browser_screenshot` does not |
| `browser_navigate` then `browser_screenshot` while still on Code with pane visible | Usually **pass** |

## Proposed contract (what “fixed” means)

1. **Fail closed** if the guest is destroyed, bounds width/height ≤ 0, or there is no compositor surface. Never `capturePage` a 0×0 view.
2. **Reveal when allowed** (Code / Orchestrate, no fullscreen overlay, wiki closed) using the navigate reveal path, wait for stable `#previewBody` bounds **and** a paint, then capture.
3. **If reveal is not allowed** (other app layer, Design Mode, wiki): return a specific error, or capture via stayHidden/CDP — do not show-and-grab on the same tick.
4. **Do not stall the tool loop.** Timeout already exists (3s). A timeout must not retry the hung `capturePage`.
5. **Mutex:** `PREVIEW_HIDE` / layout sync must not 0×0 a view with an in-flight capture.
6. Agents should not need the user to manually open the browser pane for a screenshot after a successful `browser_navigate` on Code.

## Do not

- Shell out to OS `screencapture` / desktop screenshot APIs.
- Capture the Minnow chrome instead of the preview guest.
- Raise Electron only for this unless 43.x is missing a known `capturePage` fix; the hang is our hidden/0×0/race usage.
- Treat a timeout as a complete fix if hide-during-copy continues.

## Verification

- Unit: hidden/0×0 short-circuit; retries do not follow a timeout; Design Mode skip for `browser_screenshot` / before-after.
- Manual Electron: screenshot with pane visible; pane collapsed; Design Mode on; wiki/overlay open; Issues app foreground; navigate-then-screenshot without the user opening the pane. Tool returns PNG or a clear error. App stays interactive (especially macOS).
- Update [`documentation/context.md`](../context.md) Preview browser bullet when the capture contract changes.
