/**
 * Left app rail — fixed roster for workspace-first shell navigation.
 *
 * The rail is the shell's only navigation column. Clicking any tile launches
 * or focuses that app; chat panel visibility is toggled from Code view chrome.
 */

import { getAppById } from './app-registry';
import { listRailApps, subscribeAppPreferences } from './app-preferences';
import { createAppIcon } from './icons';
import {
  getForegroundAppId,
  getOsView,
  subscribeInstances,
} from './instances';
import {
  dataTransferLooksCapturable,
  subscribeCaptureDrag,
} from '../ui/capture-drag';
import {
  computeIssuesDockBadge,
  issuesDockBadgeLabel,
  issuesDockBadgeText,
} from '../issues/dock-badge';
import { isClosedStatus } from '../issues/taxonomy';
import { subscribeIssuesChanges } from '../state/issues-events';
import { isCoarsePointer } from '../ui/mobile-layout';
import { isResearchPanelOpen, subscribeResearchPanel } from '../ui/research-panel';
import { launchApp } from './router';
import type { AppId } from './types';
import { openContextMenu } from '../ui/context-menu';
import {
  appWindowMenuLabel,
  canOpenAppWindow,
  hasOpenAppWindow,
  isAppWindowEligible,
  openOrFocusAppWindow,
} from './app-window';

// ── Tooltip ──────────────────────────────────────────────────────────────────

const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_GAP_PX = 10;
const TOOLTIP_EDGE_PAD_PX = 8;

function isRailAppActive(appId: AppId): boolean {
  return getForegroundAppId() === appId;
}

function isRailAppHosting(appId: AppId): boolean {
  return appId === 'code' && isResearchPanelOpen() && getForegroundAppId() === 'code';
}

let tooltipEl: HTMLDivElement | null = null;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
/** Button waiting on TOOLTIP_DELAY_MS; cleared on leave so labels do not pop in late. */
let scheduledTooltipAnchor: HTMLElement | null = null;
let tooltipAnchor: HTMLElement | null = null;
let tooltipTextFor: (() => string) | null = null;

function clearTooltipTimer(): void {
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
  scheduledTooltipAnchor = null;
}

function isTooltipAnchorHovered(anchor: HTMLElement): boolean {
  return anchor.matches(':hover') || document.activeElement === anchor;
}

/** Body portal so labels paint above chat/code side rails (stack above #minnowOsRoot). */
function ensureTooltipLayer(): HTMLDivElement {
  if (tooltipEl?.isConnected) return tooltipEl;
  tooltipEl?.remove();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'mn-os-app-rail__tooltip';
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function hideRailTooltip(): void {
  clearTooltipTimer();
  tooltipAnchor = null;
  tooltipTextFor = null;
  if (tooltipEl) tooltipEl.hidden = true;
}

function positionRailTooltip(anchor: HTMLElement, layer: HTMLDivElement): void {
  const anchorBox = anchor.getBoundingClientRect();
  const isBottomRail = document.documentElement.classList.contains('mn-narrow');

  layer.style.left = '';
  layer.style.top = '';
  layer.style.bottom = '';
  layer.style.right = '';
  layer.style.transform = '';
  layer.dataset.side = isBottomRail ? 'top' : 'right';

  if (isBottomRail) {
    const centerX = anchorBox.left + anchorBox.width / 2;
    layer.style.left = `${centerX}px`;
    layer.style.bottom = `${window.innerHeight - anchorBox.top + TOOLTIP_GAP_PX}px`;
    layer.style.transform = 'translateX(-50%)';
    return;
  }

  const height = layer.offsetHeight;
  const centerY = anchorBox.top + anchorBox.height / 2;
  const minY = TOOLTIP_EDGE_PAD_PX + height / 2;
  const maxY = window.innerHeight - TOOLTIP_EDGE_PAD_PX - height / 2;
  const clampedY = Math.min(Math.max(centerY, minY), Math.max(minY, maxY));

  layer.style.left = `${anchorBox.right + TOOLTIP_GAP_PX}px`;
  layer.style.top = `${clampedY}px`;
  layer.style.transform = 'translateY(-50%)';
  layer.style.setProperty('--rail-tooltip-arrow-y', `${centerY - clampedY + height / 2}px`);
}

function showRailTooltip(anchor: HTMLElement, getText: () => string): void {
  if (isCoarsePointer()) return;
  const layer = ensureTooltipLayer();
  layer.textContent = getText();
  layer.hidden = false;
  tooltipAnchor = anchor;
  tooltipTextFor = getText;
  positionRailTooltip(anchor, layer);
}

function scheduleRailTooltip(anchor: HTMLElement, getText: () => string): void {
  if (isCoarsePointer()) return;
  clearTooltipTimer();
  scheduledTooltipAnchor = anchor;
  tooltipTimer = setTimeout(() => {
    tooltipTimer = null;
    scheduledTooltipAnchor = null;
    if (!isTooltipAnchorHovered(anchor)) return;
    showRailTooltip(anchor, getText);
  }, TOOLTIP_DELAY_MS);
}

/** Refresh a visible tooltip in place after the panel state changes under it. */
function refreshRailTooltip(): void {
  if (!tooltipAnchor || !tooltipTextFor || !tooltipEl || tooltipEl.hidden) return;
  tooltipEl.textContent = tooltipTextFor();
  positionRailTooltip(tooltipAnchor, tooltipEl);
}

function bindRailTooltip(btn: HTMLButtonElement, getText: () => string): void {
  const onEnter = (): void => {
    if (tooltipAnchor && tooltipAnchor !== btn) hideRailTooltip();
    scheduleRailTooltip(btn, getText);
  };
  const onLeave = (): void => {
    if (scheduledTooltipAnchor === btn) clearTooltipTimer();
    if (tooltipAnchor === btn) hideRailTooltip();
  };
  const onFocus = (): void => showRailTooltip(btn, getText);
  const onBlur = (): void => {
    if (tooltipAnchor === btn) hideRailTooltip();
  };

  btn.addEventListener('mouseenter', onEnter);
  btn.addEventListener('mouseleave', onLeave);
  btn.addEventListener('focus', onFocus);
  btn.addEventListener('blur', onBlur);
}

// ── Buttons ──────────────────────────────────────────────────────────────────

function handleRailClick(appId: AppId): void {
  launchApp(appId);
}

/** Suppress the native menu on every tile; custom items only when eligible. */
function bindRailTileContextMenu(btn: HTMLButtonElement, appId: AppId): void {
  const openMenu = (clientX: number, clientY: number): void => {
    hideRailTooltip();
    void showRailAppWindowMenu(btn, appId, clientX, clientY);
  };

  btn.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  });
  btn.addEventListener('keydown', (event) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const rect = btn.getBoundingClientRect();
    openMenu(rect.left + 8, rect.bottom + 4);
  });
}

async function showRailAppWindowMenu(
  btn: HTMLButtonElement,
  appId: AppId,
  clientX: number,
  clientY: number,
): Promise<void> {
  if (!canOpenAppWindow() || !isAppWindowEligible(appId)) return;
  const alreadyOpen = await hasOpenAppWindow(appId);
  openContextMenu({
    clientX,
    clientY,
    restoreFocus: btn,
    label: 'App actions',
    items: [
      {
        id: 'open-app-window',
        label: appWindowMenuLabel(alreadyOpen),
        onSelect: () => {
          void openOrFocusAppWindow(appId).then((result) => {
            if (result.ok) return;
            void import('../ui/toast').then((m) => {
              m.showToast(result.error, 'error');
            });
          });
        },
      },
    ],
  });
}

const RAIL_DROP_CLASS = 'is-drop-target';

/**
 * The Issues tile doubles as a capture drop target.
 *
 * `dragover` cannot read the transfer payload (see `file-tree-dnd.ts`), so the
 * decision is made from `DataTransfer.types` alone and the "something is in
 * flight" highlight comes from the shell drag layer's module-level descriptor.
 */
function bindRailCaptureDrop(btn: HTMLButtonElement): () => void {
  const onDragOver = (event: DragEvent): void => {
    if (!dataTransferLooksCapturable(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    btn.classList.add(RAIL_DROP_CLASS);
  };
  const onDragLeave = (): void => btn.classList.remove(RAIL_DROP_CLASS);
  const onDrop = (event: DragEvent): void => {
    btn.classList.remove(RAIL_DROP_CLASS);
    if (!dataTransferLooksCapturable(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void import('../ui/issue-capture').then((m) => {
      m.openCaptureFromDrop(event.dataTransfer, { anchor: btn });
    });
  };

  btn.addEventListener('dragover', onDragOver);
  btn.addEventListener('dragleave', onDragLeave);
  btn.addEventListener('drop', onDrop);

  const unsubscribe = subscribeCaptureDrag((payload) => {
    btn.classList.toggle('is-drop-armed', payload !== null);
    if (!payload) btn.classList.remove(RAIL_DROP_CLASS);
  });

  return () => {
    unsubscribe();
    btn.removeEventListener('dragover', onDragOver);
    btn.removeEventListener('dragleave', onDragLeave);
    btn.removeEventListener('drop', onDrop);
  };
}

function buildRailButton(
  appId: AppId,
  label: string,
  disposers: Array<() => void>,
): HTMLButtonElement {
  const def = getAppById(appId);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mn-os-app-rail__btn';
  btn.dataset.appId = appId;
  btn.setAttribute('aria-label', label);
  const icon = createAppIcon((def?.icon ?? 'code') as 'code');
  btn.appendChild(icon);
  bindRailTooltip(btn, () => label);
  btn.addEventListener('click', () => handleRailClick(appId));
  bindRailTileContextMenu(btn, appId);
  if (appId === 'issues') {
    btn.classList.add('mn-capture-target');
    disposers.push(bindRailCaptureDrop(btn));
    disposers.push(bindIssuesDockBadge(btn, label));
  }
  return btn;
}

/**
 * Badge the Issues tile with its two draining queues.
 *
 * Loaded lazily and failing silently: the rail mounts before the issues store
 * does, and a rail that throws is a shell with no navigation.
 */
function bindIssuesDockBadge(btn: HTMLButtonElement, appLabel: string): () => void {
  const badge = document.createElement('span');
  badge.className = 'mn-os-app-rail__badge';
  badge.hidden = true;
  btn.appendChild(badge);

  const sync = (): void => {
    let issues: ReturnType<typeof import('../state/issues-store').listIssues> = [];
    try {
      if (issuesStore?.isIssuesStoreLoaded() === true) {
        issues = issuesStore.listIssues();
      }
    } catch {}
    // No taxonomy yet means no status catalog to judge closed-ness by; the
    // store lands a tick later and re-syncs.
    const taxonomy = issuesTaxonomyStore?.getIssuesTaxonomySync();
    const state = computeIssuesDockBadge(issues, {
      isClosed: taxonomy ? (issue) => isClosedStatus(taxonomy, issue.status) : undefined,
    });
    const text = issuesDockBadgeText(state);
    badge.hidden = text === '';
    badge.textContent = text;
    badge.classList.toggle('is-urgent', state.urgent);
    const detail = issuesDockBadgeLabel(state);
    badge.title = detail;
    btn.dataset.badgeLabel = detail;
    btn.setAttribute('aria-label', detail ? `${appLabel} — ${detail}` : appLabel);
  };

  sync();
  const unsubscribe = subscribeIssuesChanges(sync);

  void import('../state/issues-store')
    .then((module) => {
      issuesStore = module;
      sync();
    })
    .catch(() => {
    });

  void import('../state/issues-taxonomy-store')
    .then((module) => {
      issuesTaxonomyStore = module;
      sync();
    })
    .catch(() => {
    });

  return () => {
    unsubscribe();
    badge.remove();
  };
}

/** Resolved once, shared by every rebuild of the tile. */
let issuesStore: typeof import('../state/issues-store') | null = null;
let issuesTaxonomyStore: typeof import('../state/issues-taxonomy-store') | null = null;

function syncRailButtons(tileByAppId: Map<AppId, HTMLButtonElement>): void {
  for (const [appId, btn] of tileByAppId) {
    const hosting = isRailAppHosting(appId);
    const active = isRailAppActive(appId);
    btn.classList.toggle('is-active', active);
    btn.classList.toggle('is-hosting', hosting);
    btn.classList.remove('is-panel-closed');
    btn.setAttribute('aria-current', active ? 'page' : hosting ? 'true' : 'false');
    btn.removeAttribute('aria-expanded');
    const label = getAppById(appId)?.name;
    const badgeLabel = btn.dataset.badgeLabel;
    if (label) btn.setAttribute('aria-label', badgeLabel ? `${label} — ${badgeLabel}` : label);
  }
  refreshRailTooltip();
}

/** Hide the rail only on the workspace gate; keep it visible in fullscreen apps. */
function syncRailVisibility(root: HTMLElement): void {
  root.hidden = getOsView() === 'workspaces';
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Mount the left app rail (`--sidebar-rail`) inside `#osAppRail`.
 * Returns cleanup for shell teardown.
 */
export function initAppRail(root: HTMLElement): () => void {
  root.replaceChildren();
  root.setAttribute('role', 'navigation');
  root.setAttribute('aria-label', 'Apps');

  const nav = document.createElement('div');
  nav.className = 'mn-os-app-rail__nav';

  const tileByAppId = new Map<AppId, HTMLButtonElement>();
  /** Per-tile listener disposers; cleared on every rebuild. */
  let tileDisposers: Array<() => void> = [];

  function rebuild(): void {
    hideRailTooltip();
    for (const dispose of tileDisposers) dispose();
    tileDisposers = [];
    nav.replaceChildren();
    tileByAppId.clear();
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }

    for (const app of listRailApps()) {
      const btn = buildRailButton(app.id, app.name, tileDisposers);
      tileByAppId.set(app.id, btn);
      nav.appendChild(btn);
    }

    syncRailButtons(tileByAppId);
  }

  const onNavPointerLeave = (): void => {
    clearTooltipTimer();
    hideRailTooltip();
  };
  nav.addEventListener('pointerleave', onNavPointerLeave);

  root.appendChild(nav);
  rebuild();

  const onInstances = (): void => {
    syncRailButtons(tileByAppId);
    syncRailVisibility(root);
  };

  const unsubInstances = subscribeInstances(onInstances);
  const unsubPrefs = subscribeAppPreferences(rebuild);
  const unsubResearch = subscribeResearchPanel(onInstances);
  syncRailVisibility(root);

  const onLayoutChange = (): void => {
    if (tooltipAnchor && tooltipEl && !tooltipEl.hidden) {
      positionRailTooltip(tooltipAnchor, tooltipEl);
    }
  };

  window.addEventListener('resize', onLayoutChange, { passive: true });
  window.addEventListener('scroll', onLayoutChange, { passive: true, capture: true });

  return () => {
    nav.removeEventListener('pointerleave', onNavPointerLeave);
    window.removeEventListener('resize', onLayoutChange);
    window.removeEventListener('scroll', onLayoutChange, true);
    unsubInstances();
    unsubPrefs();
    unsubResearch();
    for (const dispose of tileDisposers) dispose();
    tileDisposers = [];
    hideRailTooltip();
    tooltipEl?.remove();
    tooltipEl = null;
    root.replaceChildren();
  };
}
