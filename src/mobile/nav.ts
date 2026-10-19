/**
 * Tab + stack navigation for the phone app.
 *
 * Each tab keeps its own stack, so switching tabs and back returns to the same
 * screen. Pushes add a history entry without touching the hash (the OS router
 * owns the hash), so the phone's back gesture pops the top screen.
 */

import { el } from './dom';

export type MobileTabId = 'chats' | 'boards' | 'issues' | 'files';

export interface MobileScreen {
  /** Stable key, e.g. `chat:<id>`; pushing the top screen's key again is a no-op. */
  key: string;
  el: HTMLElement;
  /** Became the visible screen (first show and every return). */
  onShow?: () => void;
  /** Another screen covered it or its tab was hidden. */
  onHide?: () => void;
  /** Popped for good. */
  dispose?: () => void;
}

interface TabStack {
  host: HTMLElement;
  screens: MobileScreen[];
}

const HISTORY_MARK = 'minnowMobile';

const stacks = new Map<MobileTabId, TabStack>();
const tabListeners = new Set<(tab: MobileTabId) => void>();
let activeTab: MobileTabId = 'chats';
let installed = false;
/** Pops already applied in-app that the next popstate must not repeat. */
let skipPopstate = 0;

function top(tab: MobileTabId): MobileScreen | undefined {
  const stack = stacks.get(tab);
  return stack?.screens[stack.screens.length - 1];
}

function setScreenVisible(screen: MobileScreen, visible: boolean): void {
  screen.el.hidden = !visible;
  screen.el.inert = !visible;
}

function animateIn(screen: MobileScreen): void {
  screen.el.classList.add('m-screen--entering');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => screen.el.classList.remove('m-screen--entering'));
  });
}

function onPopState(): void {
  if (skipPopstate > 0) {
    skipPopstate -= 1;
    return;
  }
  popScreen({ fromHistory: true });
}

/** Register a tab's host and root screen. */
export function registerTab(tab: MobileTabId, host: HTMLElement, root: MobileScreen): void {
  host.append(root.el);
  stacks.set(tab, { host, screens: [root] });
  setScreenVisible(root, tab === activeTab);
  if (!installed) {
    installed = true;
    window.addEventListener('popstate', onPopState);
  }
}

export function getActiveTab(): MobileTabId {
  return activeTab;
}

/** Subscribe to tab changes (the tab bar's selection). */
export function onTabChange(listener: (tab: MobileTabId) => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

/** Show a tab. Re-selecting the active tab pops it to its root. */
export function selectTab(tab: MobileTabId, options: { popToRoot?: boolean } = {}): void {
  if (tab === activeTab) {
    if (options.popToRoot !== false) popToRoot(tab);
    return;
  }
  const previous = top(activeTab);
  if (previous) {
    previous.onHide?.();
    stacks.get(activeTab)!.host.hidden = true;
  }
  activeTab = tab;
  const stack = stacks.get(tab);
  if (stack) {
    stack.host.hidden = false;
    const current = top(tab);
    if (current) {
      setScreenVisible(current, true);
      current.onShow?.();
    }
  }
  for (const listener of tabListeners) listener(tab);
}

/** Push a screen on the active tab (or the given one, switching to it). */
export function pushScreen(screen: MobileScreen, tab: MobileTabId = activeTab): void {
  if (tab !== activeTab) selectTab(tab, { popToRoot: false });
  const stack = stacks.get(tab);
  if (!stack) return;
  const current = top(tab);
  if (current?.key === screen.key) {
    screen.dispose?.();
    current.onShow?.();
    return;
  }
  if (current) {
    current.onHide?.();
    setScreenVisible(current, false);
  }
  stack.screens.push(screen);
  stack.host.append(screen.el);
  setScreenVisible(screen, true);
  animateIn(screen);
  screen.onShow?.();
  try {
    history.pushState({ [HISTORY_MARK]: stack.screens.length }, '');
  } catch {}
}

/** Pop the active tab's top screen. A no-op at the root. */
export function popScreen(options: { fromHistory?: boolean } = {}): void {
  const stack = stacks.get(activeTab);
  if (!stack || stack.screens.length <= 1) return;
  const leaving = stack.screens.pop()!;
  leaving.onHide?.();
  leaving.el.remove();
  leaving.dispose?.();
  const current = top(activeTab);
  if (current) {
    setScreenVisible(current, true);
    current.onShow?.();
  }
  if (!options.fromHistory && (history.state as Record<string, unknown> | null)?.[HISTORY_MARK]) {
    skipPopstate += 1;
    history.back();
  }
}

/** Pop everything above a tab's root. */
export function popToRoot(tab: MobileTabId = activeTab): void {
  const stack = stacks.get(tab);
  while (stack && stack.screens.length > 1) {
    if (tab === activeTab) popScreen();
    else {
      const leaving = stack.screens.pop()!;
      leaving.el.remove();
      leaving.dispose?.();
    }
  }
}

/** The screen currently on top of the active tab. */
export function getTopScreen(): MobileScreen | undefined {
  return top(activeTab);
}

/** Standard screen frame: header + scrolling body (+ optional footer). */
export function screenFrame(options: {
  key: string;
  className?: string;
  header: HTMLElement;
  body: HTMLElement;
  footer?: HTMLElement | null;
}): HTMLElement {
  return el(
    'section',
    { className: `m-screen ${options.className ?? ''}`.trim(), dataset: { screen: options.key } },
    options.header,
    options.body,
    options.footer ?? null,
  );
}

/** Test hook. */
export function resetMobileNavForTests(): void {
  stacks.clear();
  tabListeners.clear();
  activeTab = 'chats';
  skipPopstate = 0;
  if (installed) window.removeEventListener('popstate', onPopState);
  installed = false;
}
