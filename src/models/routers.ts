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
/** The model that judges a chat in an Auto pool. */
export interface RouterEvaluator { providerId: string; modelId: string }
export interface ModelRouter { id: string; name: string; enabled: boolean; policy: 'priority' | 'balance' | 'evaluate'; evaluator?: RouterEvaluator; entries: RouterEntry[] }
/** The saved chat choice and the reasoning actually applied to the selected model. */
export interface RouterDecision {
  tier: RouterTier | null;
  effort: string | null;
  requestedEffort?: string | null;
  reasoningStatus?: 'applied' | 'unsupported' | 'default';
  confidence: number;
  reason: string;
  judgedBy: string;
  /** evaluator · kept (low confidence) · fallback · override */
  source: string;
  modelLabel: string;
}
/** Live Auto-pool state for one chat, driven by the generation stream. */
export interface RouterRouteState {
  phase: 'deciding' | 'decided';
  judgedBy: string;
  /** First evaluation in this chat. */
  first: boolean;
  candidates: string[];
  decision?: RouterDecision;
  /** When the real evaluation started (performance.now()). */
  startedAt: number;
  reevaluate?: boolean;
}
interface SavedRouterDecision { chatId: string; routerId: string; reevaluate?: boolean; display?: RouterDecision }
export interface RouterConfig { routers: ModelRouter[]; defaultRouterId: string | null; revision: number; aliases?: Record<string, string>; legacyAliases?: Record<string, string>; assignments?: RouterActivity['assignments']; decisions?: SavedRouterDecision[] }
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
const aliasesByWorkspace = new Map<string, Record<string, string>>();
const assignments = new Map<string, string>();
const assignedModels = new Map<string, { providerId: string; modelId: string }>();
const routeStates = new Map<string, RouterRouteState>();
const routeKey = (routerId: string, chatId: string): string => JSON.stringify([routerId, chatId]);
const notifyRoute = (): void => { window.dispatchEvent(new window.Event('minnow-router-assignment')); };
const workspaceKey = (_root?: string): string => 'global-v2';

export function getRouterConfigSync(root?: string): RouterConfig {
  const key = workspaceKey(root);
  if (cache.has(key)) return cache.get(key)!;
  try {
    const stored = JSON.parse(localStorage.getItem(`minnow.routers:${key}`) || 'null') as RouterConfig | null;
    if (stored && Array.isArray(stored.routers)) { cache.set(key, stored); return stored; }
  } catch {}
  return empty();
}
export function canonicalRouterBinding<T extends { providerId?: string; modelId?: string }>(binding: T): T {
  if (binding.providerId !== ROUTER_PROVIDER_ID || !binding.modelId) return binding;
  const modelId = aliasesByWorkspace.get(getWorkspacePath())?.[binding.modelId] || binding.modelId;
  return { ...binding, modelId };
}
export function routerAssignmentLabel(chatId: string, routerId: string): string { return assignments.get(JSON.stringify([routerId, chatId])) || ''; }
export function routerChatModelLabel(chat: { providerId?: string; modelId?: string }): string {
  if (chat.providerId !== ROUTER_PROVIDER_ID) return chat.modelId || '';
  const router = getRouterConfigSync().routers.find((r) => r.id === canonicalRouterBinding(chat).modelId);
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
  const key = JSON.stringify([routerId, chatId]);
  assignments.set(key, `${providerId} / ${modelId}`);
  assignedModels.set(key, { providerId, modelId });
  window.dispatchEvent(new window.Event('minnow-router-assignment'));
}

/** The model the task evaluator picked for a chat's pool, as provider and model ids. */
export function routerAssignedModel(chatId: string, routerId: string): { providerId: string; modelId: string } | undefined {
  return assignedModels.get(JSON.stringify([routerId, chatId]));
}

export function routerRouteState(chatId: string, routerId: string): RouterRouteState | undefined {
  return routeStates.get(routeKey(routerId, chatId));
}

export async function requestRouterReevaluation(chatId: string, routerId: string): Promise<void> {
  const activity = await routerApi<RouterActivity>(`/${encodeURIComponent(routerId)}/reevaluate`, { chatId }, 'POST');
  const saved = activity.decisions?.find((d) => d.chatId === chatId);
  const previous = routerRouteState(chatId, routerId);
  if (previous && saved) routeStates.set(routeKey(routerId, chatId), { ...previous, reevaluate: true });
  notifyRoute();
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
 * deciding state so no spinner keeps running — a live CSS animation costs
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
  const root = getWorkspacePath();
  const key = workspaceKey();
  const config = await routerApi<RouterConfig>();
  cache.set(key, config);
  aliasesByWorkspace.set(root, config.legacyAliases || {});
  for (const assignment of config.assignments || []) {
    const entry = config.routers.find((r) => r.id === assignment.routerId)?.entries.find((e) => e.id === assignment.assignedEntryId);
    if (!entry) continue;
    const key = JSON.stringify([assignment.routerId, assignment.chatId]);
    assignments.set(key, `${entry.providerId} / ${entry.modelId}`);
    assignedModels.set(key, { providerId: entry.providerId, modelId: entry.modelId });
  }
  for (const saved of config.decisions || []) {
    if (!saved.display || routerRouteState(saved.chatId, saved.routerId)?.phase === 'deciding') continue;
    const assignment = config.assignments?.find((a) => a.chatId === saved.chatId && a.routerId === saved.routerId);
    const pinned = assignment?.assignmentMode === 'override';
    const entry = pinned ? config.routers.find((r) => r.id === saved.routerId)?.entries.find((e) => e.id === assignment.assignedEntryId) : undefined;
    const display: RouterDecision = pinned ? {
      tier: null, effort: null, requestedEffort: null, confidence: 1, reason: 'Pinned to a model for this chat',
      judgedBy: '', source: 'override', modelLabel: entry?.modelId || 'Unavailable model',
    } : saved.display;
    routeStates.set(routeKey(saved.routerId, saved.chatId), {
      phase: 'decided', judgedBy: display.judgedBy, first: false, candidates: [],
      decision: display, startedAt: 0, reevaluate: !pinned && saved.reevaluate === true,
    });
  }
  notifyRoute();
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
    select.value = previous;
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
