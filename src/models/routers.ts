import { formatModelLabel } from '../lib/format-model-label';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import type { LibraryModel } from './library';
import {
  isLibraryModelBinding,
  isLocalRuntimeCatalogProviderId,
  LIBRARY_MODEL_OPTGROUP_LABEL,
  LIBRARY_MODEL_PROVIDER_ID,
  resolveLibraryModelIdForChatBinding,
} from './model-select-library';
import { getWorkspacePath } from '../state/workspace';
import type { RouterTier } from './router-tiers.mjs';

export const ROUTER_PROVIDER_ID = 'minnow-router';
/** `tier` only matters to Auto pools; unset means guessed from the model id. */
export interface RouterEntry { id: string; providerId: string; modelId: string; enabled: boolean; concurrencyLimit: number; tier?: RouterTier }
/** The model that judges each turn in an Auto pool. */
export interface RouterEvaluator { providerId: string; modelId: string }
export interface ModelRouter { id: string; name: string; enabled: boolean; policy: 'priority' | 'balance' | 'evaluate'; evaluator?: RouterEvaluator; entries: RouterEntry[] }
/** What the task evaluator chose for a turn (the `decision` in a `minnow_router` payload). */
export interface RouterDecision {
  tier: RouterTier | null;
  effort: string | null;
  confidence: number;
  reason: string;
  judgedBy: string;
  /** evaluator · turn (tool round kept it) · kept (low confidence) · fallback · override */
  source: string;
  modelLabel: string;
}
/** Live Auto-pool state for one chat, driven by the generation stream. */
export interface RouterRouteState {
  phase: 'deciding' | 'decided';
  judgedBy: string;
  /** First decision in this chat: the composer plays the full pick animation. */
  first: boolean;
  candidates: string[];
  decision?: RouterDecision;
  /** When deciding started (performance.now()), so a fast answer still reads as a pick. */
  startedAt: number;
}
export interface RouterConfig { routers: ModelRouter[]; defaultRouterId: string | null; revision: number; assignments?: RouterActivity['assignments'] }
export interface RouterActivity {
  assignments: { chatId: string; routerId: string; assignmentMode: 'router' | 'override'; assignedEntryId: string; overrideEntryId?: string }[];
  requests: { chatId: string; entryId: string; status: string; requestId: string }[];
  entries: { entryId: string; active: number; queued: number; telemetry: { completed: number; errors: number; latencyMs: number; tokens: number; promptTokens: number; completionTokens: number; usageSamples: number } | null }[];
  availability: Record<string, { available: boolean; reason: string }>;
  events: { chatId: string; entryId?: string; status: string; timestamp: string; error?: string }[];
  decisions?: (Omit<RouterDecision, 'modelLabel'> & { chatId: string; routerId: string; decidedAt: string })[];
}
const empty = (): RouterConfig => ({ routers: [], defaultRouterId: null, revision: 0 });
const cache = new Map<string, RouterConfig>();
const assignments = new Map<string, string>();
const routeStates = new Map<string, RouterRouteState>();
const routeKey = (routerId: string, chatId: string): string => JSON.stringify([routerId, chatId]);
const notifyRoute = (): void => { window.dispatchEvent(new window.Event('minnow-router-assignment')); };
const workspaceKey = (root = getWorkspacePath()): string => {
  const normalized = root.replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export function getRouterConfigSync(root?: string): RouterConfig {
  const key = workspaceKey(root);
  if (cache.has(key)) return cache.get(key)!;
  try {
    const stored = JSON.parse(localStorage.getItem(`minnow.routers:${key}`) || 'null') as RouterConfig | null;
    if (stored && Array.isArray(stored.routers)) { cache.set(key, stored); return stored; }
  } catch {}
  return empty();
}
export function routerAssignmentLabel(chatId: string, routerId: string): string { return assignments.get(JSON.stringify([routerId, chatId])) || ''; }
export function routerChatModelLabel(chat: { providerId?: string; modelId?: string }): string {
  if (chat.providerId !== ROUTER_PROVIDER_ID) return chat.modelId || '';
  const router = getRouterConfigSync().routers.find((r) => r.id === chat.modelId);
  return router ? `${router.name} · Model pool` : 'Unavailable model pool';
}
/** Provider label for a router entry (My Models instead of llama.cpp / mlx-lm). */
export function routerEntryProviderLabel(
  entry: RouterEntry,
  providers: Array<{ id: string; label: string }>,
): string {
  if (
    entry.providerId === LIBRARY_MODEL_PROVIDER_ID ||
    isLibraryModelBinding(entry.providerId, entry.modelId) ||
    isLocalRuntimeCatalogProviderId(entry.providerId)
  ) {
    return LIBRARY_MODEL_OPTGROUP_LABEL;
  }
  return providers.find((p) => p.id === entry.providerId)?.label || entry.providerId;
}

/** Human model name for a router entry (library display name when known). */
export function routerEntryModelLabel(entry: RouterEntry, library: LibraryModel[]): string {
  if (entry.providerId === LIBRARY_MODEL_PROVIDER_ID || isLibraryModelBinding(entry.providerId, entry.modelId)) {
    const row = library.find((model) => model.id === entry.modelId);
    if (row) {
      return formatModelLabel({
        id: row.name,
        quantization: row.quant || undefined,
      }).optionText;
    }
  }
  return entry.modelId;
}

/** Rewrite llama-cpp-local / mlx-lm-local entries onto minnow-library ids when they match My Models. */
export function remapRouterEntriesToLibrary(
  entries: RouterEntry[],
  library: LibraryModel[],
): boolean {
  let changed = false;
  for (const entry of entries) {
    if (isLibraryModelBinding(entry.providerId, entry.modelId)) continue;
    const libraryId = resolveLibraryModelIdForChatBinding(entry.providerId, entry.modelId, library);
    if (!libraryId) continue;
    entry.providerId = LIBRARY_MODEL_PROVIDER_ID;
    entry.modelId = libraryId;
    changed = true;
  }
  return changed;
}

export function noteRouterAssignment(chatId: string, providerId: string, modelId: string, routerId: string): void {
  assignments.set(JSON.stringify([routerId, chatId]), `${providerId} / ${modelId}`);
  window.dispatchEvent(new window.Event('minnow-router-assignment'));
}

export function routerRouteState(chatId: string, routerId: string): RouterRouteState | undefined {
  return routeStates.get(routeKey(routerId, chatId));
}

export function noteRouterDeciding(
  chatId: string,
  routerId: string,
  info: { judgedBy?: string; first?: boolean; candidates?: unknown },
): void {
  const previous = routeStates.get(routeKey(routerId, chatId));
  routeStates.set(routeKey(routerId, chatId), {
    phase: 'deciding',
    judgedBy: typeof info.judgedBy === 'string' ? info.judgedBy : '',
    first: info.first === true,
    candidates: Array.isArray(info.candidates) ? info.candidates.filter((c): c is string => typeof c === 'string') : [],
    ...(previous?.decision ? { decision: previous.decision } : {}),
    startedAt: performance.now(),
  });
  notifyRoute();
}

export function noteRouterDecision(chatId: string, routerId: string, decision: RouterDecision): void {
  const previous = routeStates.get(routeKey(routerId, chatId));
  routeStates.set(routeKey(routerId, chatId), {
    phase: 'decided',
    judgedBy: decision.judgedBy || previous?.judgedBy || '',
    first: previous?.first ?? false,
    candidates: previous?.candidates ?? [],
    decision,
    startedAt: previous?.startedAt ?? performance.now(),
  });
  notifyRoute();
}

/**
 * A generation ended before the decision arrived (stop, error): drop the
 * deciding state so no shimmer keeps running — a live CSS animation costs
 * local tokens per second.
 */
export function settleRouterDeciding(chatId: string): void {
  let changed = false;
  for (const [key, route] of routeStates) {
    if (route.phase !== 'deciding' || JSON.parse(key)[1] !== chatId) continue;
    if (route.decision) routeStates.set(key, { ...route, phase: 'decided' });
    else routeStates.delete(key);
    changed = true;
  }
  if (changed) notifyRoute();
}

export async function routerApi<T>(suffix = '', body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/generations/routers${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Model pool request failed (${response.status})`);
  return value as T;
}
export async function loadRouterConfig(): Promise<RouterConfig> {
  const key = workspaceKey();
  const config = await routerApi<RouterConfig>();
  cache.set(key, config);
  for (const assignment of config.assignments || []) {
    const entry = config.routers.find((r) => r.id === assignment.routerId)?.entries.find((e) => e.id === assignment.assignedEntryId);
    if (entry) assignments.set(JSON.stringify([assignment.routerId, assignment.chatId]), `${entry.providerId} / ${entry.modelId}`);
  }
  try { localStorage.setItem(`minnow.routers:${key}`, JSON.stringify(config)); } catch {}
  return config;
}
export async function saveRouterConfig(config: RouterConfig): Promise<RouterConfig> {
  const key = workspaceKey();
  const saved = await routerApi<RouterConfig>('', config, 'PUT');
  cache.set(key, saved);
  try { localStorage.setItem(`minnow.routers:${key}`, JSON.stringify(saved)); } catch {}
  const select = document.getElementById('modelSelect') as HTMLSelectElement | null;
  if (select) {
    const previous = select.value;
    routerOptions(select, saved);
    let desired = saved.defaultRouterId ? encodeModelSelectKey(ROUTER_PROVIDER_ID, saved.defaultRouterId) : previous;
    if (!saved.defaultRouterId && decodeModelSelectKey(previous)?.providerId === ROUTER_PROVIDER_ID) {
      desired = [...select.options].find((o) => o.value && decodeModelSelectKey(o.value)?.providerId !== ROUTER_PROVIDER_ID)?.value || '';
    }
    select.value = desired;
    const { persistDefaultModelValue } = await import('../ui/default-model');
    if (desired !== previous) await persistDefaultModelValue(desired);
    const { syncModelSelectPicker } = await import('../ui/model-select-picker');
    syncModelSelectPicker();
    const { syncComposerModelTriggers } = await import('../ui/composer-model-trigger');
    syncComposerModelTriggers();
  }
  window.dispatchEvent(new window.Event('minnow-routers-changed'));
  return saved;
}
export function routerOptions(select: HTMLSelectElement, config: RouterConfig): void {
  select.querySelector('[data-router-group]')?.remove();
  const group = document.createElement('optgroup'); group.label = 'Model pools'; group.dataset.routerGroup = 'true';
  for (const router of config.routers.filter((r) => r.enabled)) {
    const option = document.createElement('option');
    option.textContent = `${router.name} — Model pool`;
    option.value = encodeModelSelectKey(ROUTER_PROVIDER_ID, router.id);
    option.dataset.providerId = ROUTER_PROVIDER_ID;
    group.append(option);
  }
  if (group.children.length) select.append(group);
}
