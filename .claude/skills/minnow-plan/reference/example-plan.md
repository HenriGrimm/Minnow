---
name: open-app-in-new-window
overview: Add an "Open in new window" item to the left app rail's right-click context menu that launches the tapped app in its own Electron window (app-only chrome, one window per app, same workspace, Electron-only with graceful fallback in browser).
todos:
  - id: W1-A
    content: "Wave 1: Electron IPC — WINDOW_OPEN_APP channel, preload bridge, openOrFocusAppWindow in main"
    status: pending
  - id: W1-B
    content: "Wave 1: Extend ShellWindowRegistry to track app windows"
    status: pending
  - id: W2-A
    content: "Wave 2: SPA app-window boot mode (viewContext.appId, app-only chrome, hash route)"
    status: pending
  - id: W3-A
    content: "Wave 3: Rail context menu with 'Open in new window' + browser fallback"
    status: pending
isProject: true
---

<!-- Example plan: validates as-is with scripts/validate-plan.mjs. -->
# Open App in New Window

**Date:** 2026-09-06
**Goal:** Right-clicking an app tile on the left app rail offers "Open in new window", launching that app in its own Electron window (app-only chrome, one window per app, same workspace).
**Granularity:** medium

## Context

The left app rail (`src/os/app-rail.ts`) currently binds only `click`, tooltips, and an Issues capture drop target — there is no `contextmenu` handler on rail tiles. The shared menu primitive `openContextMenu` (`src/ui/context-menu.ts`) is already used by sidebar, file tree, and Issues, so the menu UI itself is solved; the work is (a) wiring the rail tile to it and (b) an Electron path for a second window that renders one app.

**Decisions from grilling:**
- The new window shares the current workspace's context (no folder gate).
- The window renders **app-only chrome** — no rail, no chat sidebar.
- **One window per app**: a second "Open in new window" on the same app focuses the existing app window.
- **Electron-only**: in a plain browser the menu item is hidden/disabled and tile click keeps current behavior.
- State is shared via the existing server stores; no cross-window sync code for v1 beyond what stores already do (last-focused window owns interactions).

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `src/os/app-rail.ts` | Left app rail; add per-tile `contextmenu` binding | MODIFY |
| `src/ui/context-menu.ts` | Shared context-menu primitive (`openContextMenu`) | READ ONLY (reuse) |
| `src/os/app-registry.ts` | App definitions (`getAppById`, `releaseState`) | READ ONLY |
| `electron/ipc-channels.ts` | IPC channel constants — add `WINDOW_OPEN_APP` | MODIFY |
| `electron/preload.ts` | Exposes `window.minnow.window` bridge — add `openAppWindow` | MODIFY |
| `electron/main.ts` | Window creation (`createShellWindow`/`openShellWindow`), IPC handlers — add app-window path | MODIFY |
| `electron/shell-window-registry.ts` | Window↔workspace registry — extend to track app windows | MODIFY |
| `src/main.ts` / `src/os/router.ts` | SPA boot + hash routing — support app-window boot mode | MODIFY |
| `src/os/instances.ts` | Foreground-app state (`getForegroundAppId`) | READ ONLY |
| `src/lib/open-workspace-windows.ts` | Pattern to follow for a client-side window bridge helper | READ ONLY (pattern) |
| `test/os/app-rail-context-menu.test.*` | New: rail context menu behavior | CREATE |
| `test/electron/shell-window-registry-app.test.*` | New: registry app-window tracking | CREATE |

## Architectural considerations (from exploration)

1. **One-window-per-workspace invariant.** `ShellWindowRegistry.findByWorkspace` + `openOrFocusWorkspaceWindow` enforce "a folder opens in exactly one view" because `sessions.db` has a single global revision counter — two views owning the same chat rows would 409-thrash. **Mitigation:** the app window is registered as a *second* window on the same workspace, but it must never write session/chat state. App-only chrome (no composer, no sidebar) plus the fact that Issues/Research/etc. use the issues/research stores (separate blobs with their own revision handling) keeps this safe for v1. The plan deliberately restricts app windows to apps whose stores tolerate two readers/writers; **Code is excluded** from "Open in new window" (it *is* the chat surface).
2. **Workspace claim / filesystem allowlist.** `claimWorkspaceOnServer` / `releaseWorkspaceOnServer` register each window's folder with the server's open-workspace registry (the filesystem security boundary). An app window bound to the same workspace must **claim the same folder** so its file/git/tool calls pass the path guard. Releasing must be refcount-aware: closing the app window must not release the workspace while the main window still holds it. Simplest correct v1: app windows claim but their `closed` handler releases only if no other window holds the folder (reuse `findByWorkspace` count), or — simpler still — app windows do **not** claim/release at all and rely on the main window's claim (the folder stays allowlisted as long as the main window lives). Choose the latter; document it.
3. **Window identity via `additionalArguments`.** Workspace reaches the renderer through `webPreferences.additionalArguments` read in preload (`window.minnow.viewContext`). App windows add `--minnow-app-window=<appId>`; `additionalArguments` are fixed at window creation, so no retarget path is needed (one window per app, never re-pointed).
4. **Routing.** The SPA is hash-routed (`#/app/<id>`). An app window loads the same URL with the app hash; boot mode (app-only chrome) comes from the preload-provided `viewContext.appId`, not the hash, so a reload inside the window keeps app-only chrome.
5. **Lifecycle / broadcast.** `broadcastToShellWindows` sends app-wide prefs (zoom, close-to-tray, notifications) to every shell window — app windows must be included (they are, if registered in `shellWindows` or listed by the same helper). Window-state persistence (`window-state.ts` / `loadWindowSet`) currently persists workspace windows; v1 does **not** persist app windows across restarts (note in code).
6. **Browser fallback.** `window.minnow?.window` is undefined in a plain browser; the rail menu item must check availability (same pattern as `canCloseWorkspaceWindows` in `src/lib/open-workspace-windows.ts`).
7. **Release gating.** Only apps with `releaseState: 'released'` in `src/os/app-registry.ts` may open in a window; hidden apps never appear on the rail anyway (`listRailApps`), so this falls out naturally.
8. **Close-to-tray / close prompt.** `ensureTrayManager().wireWindowClose(win)` and the close prompt flow apply to all shell windows; app windows should follow the same path (keep-in-background is fine; they are not workspace owners).

## Wave Breakdown

### Wave 1 — Electron plumbing

#### Task W1-A: IPC channel + preload bridge + openOrFocusAppWindow
- **Build:**
  - `electron/ipc-channels.ts`: add `export const WINDOW_OPEN_APP = 'window:open-app';`
  - `electron/preload.ts`: in the `window.minnow.window` bridge, add `openAppWindow(appId: string): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }>` invoking `WINDOW_OPEN_APP` via `ipcRenderer.invoke`.
  - `electron/main.ts`:
    - Extend `createShellWindow` options with `appId?: string`; when set, append `--minnow-app-window=${appId}` to `additionalArguments` and pass it to `shellWindows.register` (see W1-B).
    - Add `openOrFocusAppWindow(appId: string)`: if `shellWindows.findAppWindow(appId)` exists → `focusWindow` it; else `bootstrap()` then `openShellWindow({ workspacePath: <current focused window's workspacePath>, appId })` and load the SPA at `#/app/<appId>`. Do **not** claim/release the workspace on the server for app windows (main window owns the claim).
    - Register `ipcMain.handle(channels.WINDOW_OPEN_APP, ...)` validating `appId` against the app registry ids (hardcode the released id list or accept-and-validate in renderer; main-side validation = reject unknown ids with `{ ok: false, error }`).
    - In the `closed` handler, unregister app windows the same way (registry handles the rest).
    - Exclude `appId === 'code'` server-side too (defense in depth; renderer also hides the item).
- **Test:** `npx tsc --noEmit` passes. Unit-test the pure validation helper if extracted (e.g. `isAppWindowAllowed`); Electron main itself is covered by manual run: `npm start`, then from devtools `window.minnow.window.openAppWindow('issues')` returns `{ ok: true }` and a second window appears.
- **Accept:** Calling `window.minnow.window.openAppWindow('issues')` from the main window's devtools opens a second Electron window; calling it twice focuses the existing one instead of spawning a third.
- **Touches:** `electron/ipc-channels.ts`, `electron/preload.ts`, `electron/main.ts`
- **Depends on:** W1-B

#### Task W1-B: ShellWindowRegistry app-window tracking
- **Build:**
  - `electron/shell-window-registry.ts`: add optional `appId?: string` to `ShellWindowRecord`; `register(windowId, workspacePath, viewId, appId?)` accepts it; add `findAppWindow(appId: string): ShellWindowRecord | undefined` and exclude app windows from `findByWorkspace` results (app windows must not satisfy the "folder already open" check that gates workspace retargeting).
- **Test:** New suite `test/electron/shell-window-registry-app.test.mjs` (plain `node:test`, no Electron imports — the class is Electron-free by design): register two windows on the same path, one with `appId: 'issues'`; assert `findByWorkspace` returns only the non-app window, `findAppWindow('issues')` returns the app record, `unregister` clears it.
- **Accept:** `npm run test:e2e 2>/dev/null; node --test --test-force-exit test/electron/shell-window-registry-app.test.mjs` passes (or the file runs green under `npm test`).
- **Touches:** `electron/shell-window-registry.ts`, `test/electron/**`
- **Depends on:** (none)

### Wave 2 — SPA app-window boot mode

#### Task W2-A: App-window boot mode in the SPA
- **Build:**
  - `electron/preload.ts`: extend `viewContext` with `appId?: string` parsed from `--minnow-app-window=` in `process.argv`.
  - `src/os/router.ts` (or `src/main.ts` boot): when `window.minnow?.viewContext?.appId` is set, boot directly into that app's hash (`#/app/<id>`) and set an app-window flag (e.g. `document.documentElement.dataset.appWindow = appId`).
  - `src/os/shell.ts` / rail mount path: when the app-window flag is set, **skip mounting the app rail** and any workspace-gate chrome; the app view fills the window. Keep the app's own internal chrome (e.g. Issues peek, Research panel) intact.
  - Guard any code that assumes a single foreground app instance: `src/os/instances.ts` foreground state is per-window (module state in each renderer), so no cross-window coupling is expected — verify `getForegroundAppId` initialization works when boot skips the normal route.
  - Frameless window chrome: app windows reuse the existing frameless titlebar wiring from `createShellWindow` (no extra work expected; verify drag region CSS applies).
- **Test:** New suite `test/os/app-window-boot.test.mts` (tsx + `test/test-loader.mjs`): given a stubbed `window.minnow.viewContext.appId`, the boot helper resolves the correct hash (`#/app/issues`) and sets the app-window flag; without it, behavior is unchanged. Run with `npx tsx --test --import ./test/test-loader.mjs test/os/app-window-boot.test.mts --test-force-exit` (or the project's scoped-runner convention).
- **Accept:** `npm run build` passes and the boot helper test is green; manually, the app window shows only the app (no rail) and reload keeps app-only chrome.
- **Touches:** `electron/preload.ts`, `src/os/router.ts`, `src/os/shell.ts`, `src/main.ts`, `test/os/**`
- **Depends on:** W1-A

### Wave 3 — Rail context menu

#### Task W3-A: Rail right-click menu with "Open in new window"
- **Build:**
  - `src/os/app-rail.ts`: in `buildRailButton`, add `btn.addEventListener('contextmenu', ...)` calling `openContextMenu` (`src/ui/context-menu.ts`) with items:
    - **Open in new window** — enabled only when `window.minnow?.window?.openAppWindow` exists AND `appId !== 'code'`; on click, `void window.minnow.window.openAppWindow(appId)` with error surfaced via `showToast` (`src/ui/toast.ts`).
    - Optional second item: **Open** (same as left click → `launchApp(appId)`) for discoverability parity with other menus.
  - Add a client helper `canOpenAppWindow(): boolean` (new small module `src/os/app-window.ts` following `src/lib/open-workspace-windows.ts`'s availability-check pattern) so the browser build hides the item cleanly.
  - Prevent the browser's native context menu (`event.preventDefault()`) only when the custom menu opens.
  - Match existing menu styling/behavior — reuse the same `openContextMenu({ anchor })` pattern used in `src/ui/issues-page.ts:989`.
- **Test:** New suite `test/os/app-rail-context-menu.test.mts`: build a rail with stubbed DOM (happy-dom, matching existing UI suites), dispatch `contextmenu` on a tile, assert the menu contains "Open in new window"; assert the item is absent when the bridge is missing (browser) or `appId === 'code'`; assert clicking it invokes the stubbed bridge with the right id.
- **Accept:** In the running Electron app, right-clicking any app tile (except Code) shows a context menu with "Open in new window"; choosing it opens that app in its own window; in a plain browser the item does not appear.
- **Touches:** `src/os/app-rail.ts`, `src/os/app-window.ts`, `test/os/**`
- **Depends on:** W1-A, W2-A

## Verification Checklist
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes (or scoped: new suites green)
- [ ] `npm run build` passes
- [ ] Manual: right-click rail tile → "Open in new window" → app opens in its own window, app-only chrome
- [ ] Manual: second "Open in new window" on the same app focuses the existing window
- [ ] Manual: closing the app window does not release/claim the workspace and the main window keeps working
- [ ] Manual: browser build (`MINNOW_BROWSER=1 npm start`) shows no "Open in new window" item

## Notes for Build Agents
- Follow the repo's conventions: `--mn-*` CSS tokens only (no hex literals outside `tokens.css`), match comment density of `app-rail.ts`.
- The registry class must stay Electron-import-free (it is unit-tested plain); inject everything.
- Do not add a third workspace-path normalizer anywhere — reuse the server's.
- App windows must never write to the sessions/chat store; if a task finds an app that would, stop and flag it instead of widening scope.
- Window-state persistence for app windows is explicitly out of scope for v1 — leave a code comment, don't build it.
- `npm test` batches by runner; new `test/**/*.test.{js,mjs,mts,ts}` files are auto-discovered with zero `package.json` edits, but `npm run test:check-coverage` must stay green.
