/**
 * Last foreground app route per workspace.
 *
 * Kept in renderer storage because it is shell navigation state, not project
 * data. Entries are workspace-scoped so switching folders restores the surface
 * that was last useful there without leaking one project's context into another.
 */

import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isDeveloperReleased, isAppId } from './app-registry';
import { isAppAvailable } from './app-preferences';
import { CODE_SECTION_IDS, type OsRoute } from './types';
import { MODELS_SECTIONS } from '../ui/models-section-ids';

const STORAGE_KEY = 'minnow.os.lastAppRouteByWorkspace';
const MAX_WORKSPACES = 64;

interface StoredWorkspaceRoute {
  route: OsRoute;
  updatedAt: number;
}

type StoredWorkspaceRoutes = Record<string, StoredWorkspaceRoute>;

function readStorage(): StoredWorkspaceRoutes {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StoredWorkspaceRoutes;
  } catch {
    return {};
  }
}

function writeStorage(entries: StoredWorkspaceRoutes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

function safeSlug(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w-]+$/.test(value) ? value : undefined;
}

/** Keep only a released, currently available app and its stable route context. */
export function normalizeWorkspaceAppRoute(raw: unknown): OsRoute | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const route = raw as Partial<OsRoute>;
  if (route.view !== 'app' || typeof route.appId !== 'string' || !isAppId(route.appId)) {
    return null;
  }
  if (!isDeveloperReleased(route.appId) || !isAppAvailable(route.appId)) return null;

  const normalized: OsRoute = { view: 'app', appId: route.appId };
  if (route.appId === 'code') {
    normalized.codeSection = CODE_SECTION_IDS.includes(route.codeSection as never)
      ? route.codeSection
      : 'chat';
  } else if (route.appId === 'models') {
    normalized.modelsSection = MODELS_SECTIONS.includes(route.modelsSection as never)
      ? route.modelsSection
      : undefined;
  } else if (route.appId === 'brain') {
    normalized.brainSection = safeSlug(route.brainSection);
  } else if (route.appId === 'settings') {
    normalized.settingsSection = safeSlug(route.settingsSection);
  } else if (route.appId === 'issues') {
    if (route.issuesSection === 'projects') normalized.issuesSection = 'projects';
    else normalized.issueId = safeSlug(route.issueId);
  }
  return normalized;
}

/** Persist the current released app route for one workspace. */
export function rememberWorkspaceAppRoute(workspacePath: string, route: OsRoute): void {
  const key = normalizeWorkspacePath(workspacePath);
  const normalized = normalizeWorkspaceAppRoute(route);
  if (!key || !normalized) return;

  const entries = readStorage();
  entries[key] = { route: normalized, updatedAt: Date.now() };
  const ordered = Object.entries(entries).sort(
    ([, left], [, right]) => Number(right?.updatedAt ?? 0) - Number(left?.updatedAt ?? 0),
  );
  writeStorage(Object.fromEntries(ordered.slice(0, MAX_WORKSPACES)));
}

/** Read the last valid released app route for one workspace. */
export function getWorkspaceAppResumeRoute(workspacePath: string): OsRoute | null {
  const key = normalizeWorkspacePath(workspacePath);
  if (!key) return null;
  return normalizeWorkspaceAppRoute(readStorage()[key]?.route);
}

/** Test helper. */
export function resetWorkspaceAppResumeForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
