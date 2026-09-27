/**
 * Workspace gate — full-stage picker until a workspace is chosen (workspace-first shell).
 * After pick, the gate stays up as a cover until Code chrome finishes its first paint
 * so the shell does not assemble piece-by-piece under the user.
 */

import '../styles/workspace-gate.css';

import { markChromeReady, waitForStablePaint } from '../boot/app-ready';
import { isPageReload } from '../boot/page-navigation';
import { loadWorkspaceFromServer } from '../state/workspace';
import { isOsShellEnabled } from './page-bridge';
import { getOsView, subscribeInstances } from './instances';
import { launchApp, resumeWorkspaceApp } from './router';
import { hasViewWorkspace } from '../state/view-workspace';
import { getAppWindowId, isAppWindowRenderer } from './app-window';

// ── Session ──────────────────────────────────────────────────────────────────

let gateMounted = false;
let gateOpen = false;
/** Keep the gate covering Code until initApp finishes first paint after a cold pick. */
let holdGateUntilAppReady = false;
let bootGatePromise: Promise<void> | null = null;
let resolveBootGate: (() => void) | null = null;

const WORKSPACE_GATE_SESSION_KEY = 'minnow:workspace-gate-passed';

/** User completed the workspace gate earlier in this browser/Electron session. */
export function hasWorkspaceGatePassedThisSession(): boolean {
  try {
    return sessionStorage.getItem(WORKSPACE_GATE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markWorkspaceGatePassedThisSession(): void {
  try {
    sessionStorage.setItem(WORKSPACE_GATE_SESSION_KEY, '1');
  } catch {}
}

function getGateRoot(): HTMLElement | null {
  return document.getElementById('osWorkspaceGate');
}

function getWelcomeRoot(): HTMLElement | null {
  return document.getElementById('welcomeView');
}

/** Whether the boot gate is blocking initApp (default workspace, shell on). */
export function isWorkspaceGateBlockingBoot(): boolean {
  return Boolean(bootGatePromise);
}

/** True when the workspace gate surface is visible. */
export function isWorkspaceGateOpen(): boolean {
  return gateOpen;
}

/** True while Code is painting under the gate cover after a cold pick. */
export function isHoldingWorkspaceGateForAppReady(): boolean {
  return holdGateUntilAppReady;
}

function setGateOpening(opening: boolean): void {
  getGateRoot()?.classList.toggle('workspace-gate--opening', opening);
}

function setHoldingGateCover(holding: boolean): void {
  holdGateUntilAppReady = holding;
  document.documentElement.classList.toggle('os-workspace-gate-holding', holding);
  if (holding) setGateOpening(true);
}

// ── Mount ────────────────────────────────────────────────────────────────────

/** Mount #welcomeView inside #osWorkspaceGate and wire welcome module once. */
export function mountWorkspaceGateDom(): void {
  if (!isOsShellEnabled()) return;

  const gate = getGateRoot();
  const welcome = getWelcomeRoot();
  if (!gate || !welcome) return;

  if (welcome.parentElement !== gate) {
    gate.appendChild(welcome);
  }

  if (!gateMounted) {
    gateMounted = true;
    void import('../ui/welcome-page').then((m) => m.initWelcomePage());
  }
}

function showGateElement(): void {
  const gate = getGateRoot();
  const welcome = getWelcomeRoot();
  if (!gate || !welcome) return;

  gate.hidden = false;
  welcome.hidden = false;
  welcome.classList.add('is-open');
  welcome.classList.add('welcome-page--os-overlay');
  gateOpen = true;
  document.documentElement.classList.add('os-workspace-gate-open');
}

function hideGateElement(): void {
  const gate = getGateRoot();
  const welcome = getWelcomeRoot();
  gateOpen = false;
  setGateOpening(false);
  if (gate) gate.hidden = true;
  welcome?.classList.remove('is-open', 'welcome-page--os-overlay');
  if (welcome) welcome.hidden = true;
  document.documentElement.classList.remove('os-workspace-gate-open');
}

/**
 * Open the workspace picker (boot or menubar switch).
 * Reuses welcome-page UI inside #osWorkspaceGate.
 */
export function openWorkspaceGate(options?: { switch?: boolean }): void {
  if (!isOsShellEnabled()) return;
  mountWorkspaceGateDom();
  showGateElement();
  void import('../ui/welcome-page').then((m) => {
    if (options?.switch) {
      m.onWorkspaceGateOpenedForSwitch();
    } else {
      m.resetWorkspaceGateSwitchMode();
    }
    m.refreshWorkspaceGateUi();
  });
}

/** Close the gate without changing workspace. */
export function closeWorkspaceGate(): void {
  if (!gateOpen) return;
  hideGateElement();
}

/**
 * Called after PUT /api/workspace succeeds.
 * Launches the chosen workspace target behind the gate and releases the boot
 * wait — the gate stays up until `revealAppAfterWorkspaceGate()` after paint.
 */
export async function onWorkspaceGateChosen(options?: { resume?: boolean }): Promise<void> {
  // Route sync can reopen the picker after reload, when initApp has already
  // completed and there is no boot waiter to cover. Use the switch path in
  // that case instead of reintroducing an opaque cold-boot cover.
  const waitingForBootHandoff = Boolean(bootGatePromise);
  markWorkspaceGatePassedThisSession();
  if (!waitingForBootHandoff) {
    if (getOsView() === 'workspaces' || window.location.hash.startsWith('#/workspaces')) {
      if (options?.resume) resumeWorkspaceApp();
      else launchApp('home');
    }
    await finishWorkspaceGateSwitch();
    return;
  }

  setHoldingGateCover(true);
  showGateElement();
  resolveBootGate?.();
  resolveBootGate = null;
  bootGatePromise = null;

  if (getOsView() === 'workspaces' || window.location.hash.startsWith('#/workspaces')) {
    if (options?.resume) resumeWorkspaceApp();
    else launchApp('home');
  }
}

/** Drop the gate cover once Code chrome has painted (cold-boot transition). */
export async function revealAppAfterWorkspaceGate(): Promise<void> {
  if (!holdGateUntilAppReady && !gateOpen) return;
  await waitForStablePaint();
  setHoldingGateCover(false);
  setGateOpening(false);
  closeWorkspaceGate();
}

/**
 * Close the gate after an in-session workspace switch. Code is already booted and
 * `applyWorkspaceSwitch` has refreshed chrome — unlike cold pick, initApp will not run again.
 */
export async function finishWorkspaceGateSwitch(): Promise<void> {
  if (!isOsShellEnabled()) return;
  await waitForStablePaint();
  setHoldingGateCover(false);
  setGateOpening(false);
  closeWorkspaceGate();
}

/** Hold opening UI until the workspace PUT finishes. */
export function markWorkspaceGateOpening(opening: boolean): void {
  if (holdGateUntilAppReady && !opening) return;
  if (!gateOpen && opening) return;
  setGateOpening(opening);
}

/** Sync gate visibility with router + workspace state. */
export function syncWorkspaceGateFromRoute(): void {
  if (!isOsShellEnabled()) return;
  if (getOsView() !== 'workspaces') {
    if (holdGateUntilAppReady) return;
    if (gateOpen) closeWorkspaceGate();
    return;
  }
  if (hasViewWorkspace()) {
    resumeWorkspaceApp();
    return;
  }
  if (isPageReload() && hasWorkspaceGatePassedThisSession()) {
    resumeWorkspaceApp();
    return;
  }
  openWorkspaceGate();
}

function ensureBootGatePromise(): void {
  if (!isOsShellEnabled()) return;
  if (bootGatePromise) return;
  bootGatePromise = new Promise<void>((resolve) => {
    resolveBootGate = resolve;
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Whether initApp should block on the workspace gate (cold launch only).
 *
 * A window opened *on* a folder already knows which one it is — its
 * `viewContext.workspacePath` was fixed at window creation — so it must not
 * stop at the picker. The "New window" case (no folder) still gets the gate.
 */
export function shouldBlockBootOnWorkspaceGate(): boolean {
  if (!isOsShellEnabled()) return false;
  if (isPageReload()) return false;
  if (hasViewWorkspace()) return false;
  return true;
}

/**
 * Open the cold-boot workspace picker and dismiss the app loader so the user can pick.
 * Returns a handle whose `whenChosen` resolves when a workspace is selected (gate stays
 * covering), or null when boot should not block (reload / shell off).
 *
 * Note: do not return a bare Promise from an async function — TypeScript/JS flatten
 * nested thenables and would resolve as soon as the gate opens.
 */
export async function beginWorkspaceGateForBoot(): Promise<{ whenChosen: Promise<void> } | null> {
  if (!isOsShellEnabled()) return null;

  await loadWorkspaceFromServer();

  if (!shouldBlockBootOnWorkspaceGate()) {
    // A window bound to a folder resolves the gate immediately.
    // App windows stay bound; workspace windows resume their last released app.
    // Preserve explicit deep links.
    if (hasViewWorkspace()) {
      markWorkspaceGatePassedThisSession();
      if (getAppWindowId()) launchApp(getAppWindowId()!);
      else if (!window.location.hash.startsWith('#/app/')) resumeWorkspaceApp();
    }
    return null;
  }

  if (isAppWindowRenderer()) {
    markWorkspaceGatePassedThisSession();
    if (getAppWindowId()) launchApp(getAppWindowId()!);
    return null;
  }

  ensureBootGatePromise();
  mountWorkspaceGateDom();
  openWorkspaceGate();
  markChromeReady();
  return { whenChosen: bootGatePromise ?? Promise.resolve() };
}

/**
 * @deprecated Prefer beginWorkspaceGateForBoot + revealAppAfterWorkspaceGate.
 * Kept for callers that still await the full gate before any init.
 */
export async function awaitWorkspaceGateBeforeAppInit(): Promise<void> {
  const handle = await beginWorkspaceGateForBoot();
  if (handle) await handle.whenChosen;
}

/** Subscribe gate to shell view changes. */
export function initWorkspaceGate(): void {
  if (!isOsShellEnabled()) return;
  mountWorkspaceGateDom();
  subscribeInstances(() => {
    syncWorkspaceGateFromRoute();
  });
}

/** Reset module state (tests). */
export function resetWorkspaceGateForTests(): void {
  gateOpen = false;
  gateMounted = false;
  holdGateUntilAppReady = false;
  bootGatePromise = null;
  resolveBootGate = null;
  setGateOpening(false);
  document.documentElement.classList.remove('os-workspace-gate-open');
  document.documentElement.classList.remove('os-workspace-gate-holding');
  try {
    sessionStorage.removeItem(WORKSPACE_GATE_SESSION_KEY);
  } catch {}
}
