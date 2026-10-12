import type { AppId, AppInstance, LaunchOptions, OsView } from './types';

export interface InstanceSnapshot {
  view: OsView;
  instances: readonly AppInstance[];
  foregroundId: string | null;
}

type InstanceListener = (snapshot: InstanceSnapshot) => void;

// ── State ────────────────────────────────────────────────────────────────────

const listeners = new Set<InstanceListener>();

let uidCounter = 0;
let view: OsView = 'workspaces';
let instances: AppInstance[] = [];
let foregroundId: string | null = null;

function uid(): string {
  uidCounter += 1;
  return `inst-${uidCounter}`;
}

function snapshot(): InstanceSnapshot {
  return {
    view,
    instances: [...instances],
    foregroundId,
  };
}

function emit(): void {
  const snap = snapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {}
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Current shell view (desktop launcher vs foreground app). */
export function getOsView(): OsView {
  return view;
}

/** Foreground instance id, if any. */
export function getForegroundInstanceId(): string | null {
  return foregroundId;
}

/** Foreground app id for the focused surface, if any. */
export function getForegroundAppId(): AppId | null {
  if (!foregroundId) return null;
  return instances.find((i) => i.id === foregroundId)?.appId ?? null;
}

/**
 * Pick the next foreground after closing `excludeId`.
 * `returnApp` must be captured before the instance is removed from the store.
 */
function pickNextForeground(excludeId: string, returnApp?: AppId): string | null {
  const remaining = instances.filter((i) => i.id !== excludeId);
  if (returnApp) {
    const target = remaining.find((i) => i.appId === returnApp);
    if (target) return target.id;
  }
  if (remaining.length === 0) return null;
  return remaining[remaining.length - 1]?.id ?? null;
}

/** Read-only snapshot for UI renderers. */
export function getInstanceSnapshot(): InstanceSnapshot {
  return snapshot();
}

/** Subscribe to instance/view changes; returns unsubscribe. */
export function subscribeInstances(listener: InstanceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show the workspace gate surface (does not close instances). */
export function showWorkspaces(): void {
  if (view === 'workspaces' && !foregroundId) return;
  view = 'workspaces';
  foregroundId = null;
  emit();
}

/** @deprecated Phase 5 — use showWorkspaces */
export function showDesktop(): void {
  showWorkspaces();
}

/**
 * Code launch intents that app-host acts on once. Merging them into later
 * launches would make every route (e.g. `#/app/code/boards`) replay the old
 * chat switch and bounce the user back to that chat.
 */
const CODE_ONE_SHOT_LAUNCH_KEYS = [
  'chatId',
  'seed',
  'issue',
  'modeId',
  'workspacePath',
  'codeRefs',
  'runTarget',
] as const satisfies readonly (keyof LaunchOptions)[];

function applyLaunchOptionsToInstance(inst: AppInstance, options?: LaunchOptions): void {
  if (!options || Object.keys(options).length === 0) return;
  const previous = { ...inst.launchOptions };
  if (inst.appId === 'code') {
    for (const key of CODE_ONE_SHOT_LAUNCH_KEYS) delete previous[key];
    inst.seed = undefined;
  }
  inst.launchOptions = { ...previous, ...options };
  if (options.seed) inst.seed = options.seed;
}

// ── Launch ───────────────────────────────────────────────────────────────────

/** Ensure an app instance exists without changing the foreground surface. */
export function ensureBackgroundInstance(appId: AppId, options?: LaunchOptions): string {
  const existing = instances.find((i) => i.appId === appId);
  if (existing) {
    if (options && Object.keys(options).length > 0) {
      applyLaunchOptionsToInstance(existing, options);
    }
    emit();
    return existing.id;
  }

  const inst: AppInstance = {
    id: uid(),
    appId,
    seed: options?.seed,
    launchOptions: options ? { ...options } : undefined,
    unread: 0,
    msg: '',
  };
  instances = [...instances, inst];
  emit();
  return inst.id;
}

/** Launch or foreground an app; returns the active instance id. */
export function launchInstance(appId: AppId, options?: LaunchOptions): string {
  const existing = instances.find((i) => i.appId === appId);
  let resolvedOptions = options;
  if (appId === 'settings' && resolvedOptions?.returnToApp == null) {
    const foreground = getForegroundAppId();
    if (foreground === 'code') {
      resolvedOptions = { ...resolvedOptions, returnToApp: 'code' };
    } else if (foreground && foreground !== 'settings') {
      resolvedOptions = { ...resolvedOptions, returnToApp: foreground };
    }
  }

  if (existing) {
    if (resolvedOptions && Object.keys(resolvedOptions).length > 0) {
      applyLaunchOptionsToInstance(existing, resolvedOptions);
    }
    foregroundId = existing.id;
    existing.unread = 0;
    view = 'app';
    emit();
    return existing.id;
  }

  const inst: AppInstance = {
    id: uid(),
    appId,
    seed: resolvedOptions?.seed,
    launchOptions: resolvedOptions ? { ...resolvedOptions } : undefined,
    unread: 0,
    msg: '',
  };
  instances = [...instances, inst];
  foregroundId = inst.id;
  view = 'app';
  emit();
  return inst.id;
}

/** Foreground a running instance without changing launch options. */
export function focusInstance(id: string): boolean {
  const inst = instances.find((i) => i.id === id);
  if (!inst) return false;
  if (foregroundId === id && view === 'app') return true;
  foregroundId = id;
  view = 'app';
  emit();
  return true;
}

/** Foreground a minimized instance and clear its unread badge. */
export function restoreInstance(id: string): boolean {
  const inst = instances.find((i) => i.id === id);
  if (!inst) return false;
  foregroundId = id;
  inst.unread = 0;
  view = 'app';
  emit();
  return true;
}

/** Close an instance; focuses another open surface or returns to desktop. */
export function closeInstance(id: string): boolean {
  const idx = instances.findIndex((i) => i.id === id);
  if (idx < 0) return false;
  const returnApp = instances[idx]?.launchOptions?.returnToApp;
  instances = instances.filter((i) => i.id !== id);
  if (foregroundId === id) {
    foregroundId = pickNextForeground(id, returnApp);
    view = foregroundId ? 'app' : 'workspaces';
  } else if (instances.length === 0) {
    view = 'workspaces';
  }
  emit();
  return true;
}

// ── Unread ───────────────────────────────────────────────────────────────────

/** Increment unread for background instances of the same app (agent notifications). */
export function noteAgentMessage(appId: AppId, msg: string): void {
  let changed = false;
  instances = instances.map((inst) => {
    if (inst.appId !== appId) return inst;
    const isFront = view === 'app' && foregroundId === inst.id;
    if (isFront) return inst;
    changed = true;
    return { ...inst, unread: inst.unread + 1, msg };
  });
  if (changed) emit();
}

/** Total unread count across all instances (menubar badge). */
export function getTotalUnread(): number {
  return instances.reduce((sum, i) => sum + i.unread, 0);
}

/** Drop concierge seed on the foreground instance after it has been consumed. */
export function clearForegroundSeed(): void {
  if (!foregroundId) return;
  const inst = instances.find((i) => i.id === foregroundId);
  if (!inst?.seed && !inst?.launchOptions) return;
  inst.seed = undefined;
  inst.launchOptions = undefined;
  emit();
}

/** Clear unread badges on all instances without changing the foreground app. */
export function clearAllUnread(): void {
  const hasUnread = instances.some((i) => i.unread > 0);
  if (!hasUnread) return;
  instances = instances.map((inst) =>
    inst.unread > 0 ? { ...inst, unread: 0 } : inst,
  );
  emit();
}

/** Reset module state (tests). */
export function resetInstancesForTests(): void {
  uidCounter = 0;
  view = 'workspaces';
  instances = [];
  foregroundId = null;
  listeners.clear();
}
