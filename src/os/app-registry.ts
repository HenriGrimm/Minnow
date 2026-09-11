import type { AppId } from './types';

// ── Types ────────────────────────────────────────────────────────────────────

/** Whether users may turn the app off (optional) or it is always on (core). */
export type AppAvailability = 'core' | 'optional';

/**
 * Developer release gate. Hidden apps stay in the codebase but are omitted from
 * onboarding, Settings, dock, shortcuts, notifications, and launches.
 */
export type AppReleaseState = 'released' | 'hidden';

/** Launcher metadata for each Minnow app. */
export interface AppDefinition {
  id: AppId;
  name: string;
  icon: string;
  tag: string;
  description: string;
  availability: AppAvailability;
  releaseState: AppReleaseState;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** Canonical app list — ported from Minnow prototype `data.jsx`. */
export const APPS: readonly AppDefinition[] = [
  {
    id: 'code',
    name: 'Code',
    icon: 'code',
    tag: 'Build & ship in a live workspace',
    description: 'IDE-side editor, dev server, files',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'source-control',
    name: 'Source Control',
    icon: 'sourceControl',
    tag: 'Review changes and manage your repository',
    description: 'Changes, history, branches, worktrees, pull requests, and CI',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'research',
    name: 'Research',
    icon: 'research',
    tag: 'Send a sub-agent to dig deep',
    description: 'Multi-step web + source synthesis',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'experts',
    name: 'Experts',
    icon: 'flask',
    tag: 'Compose & test expert agents',
    description: 'Personas, tools, eval harness',
    availability: 'optional',
    releaseState: 'hidden',
  },
  {
    id: 'bench',
    name: 'Benchmarking',
    icon: 'bench',
    tag: 'Measure models head-to-head',
    description: 'Throughput, latency, quality',
    availability: 'optional',
    releaseState: 'hidden',
  },
  {
    id: 'compare',
    name: 'Compare',
    icon: 'compare',
    tag: 'Blind A/B model preference',
    description: 'Side-by-side votes, reveal, win rates',
    availability: 'optional',
    releaseState: 'hidden',
  },
  {
    id: 'models',
    name: 'Models',
    icon: 'chip',
    tag: 'Download, run & tune models',
    description: 'Local runtimes, providers, recommendations',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'brain',
    name: 'Brain',
    icon: 'brain',
    tag: 'Wiki, memory & knowledge graph',
    description: 'Browse and maintain your local Brain wiki',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'scheduler',
    name: 'Scheduler',
    icon: 'scheduler',
    tag: 'Recurring agent jobs & reminders',
    description: 'Interval and cron schedules while Minnow is running',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'issues',
    name: 'Issues',
    icon: 'issues',
    tag: 'Capture, triage, and track work',
    description: 'Linear-style issues — list, board, and quick capture',
    availability: 'core',
    releaseState: 'released',
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: 'gear',
    tag: 'Appearance, prompts, agents',
    description: 'App, prompting, and integration settings',
    availability: 'core',
    releaseState: 'released',
  },
] as const;

const APP_IDS = new Set<AppId>(APPS.map((a) => a.id));

// ── Queries ──────────────────────────────────────────────────────────────────

/** Type guard for route segments and registry lookups. */
export function isAppId(value: string): value is AppId {
  return APP_IDS.has(value as AppId);
}

/** Lookup launcher metadata by id. */
export function getAppById(id: AppId): AppDefinition | undefined {
  return APPS.find((a) => a.id === id);
}

/** Core apps cannot be disabled by the user. */
export function isCoreApp(id: AppId): boolean {
  return getAppById(id)?.availability === 'core';
}

/** Optional apps may be toggled in onboarding / Settings → Apps. */
export function isOptionalApp(id: AppId): boolean {
  return getAppById(id)?.availability === 'optional';
}

/** Developer-released apps may appear in product surfaces. */
export function isDeveloperReleased(id: AppId): boolean {
  return getAppById(id)?.releaseState === 'released';
}

/** All apps marked released (ignores user preference). */
export function listReleasedApps(): AppDefinition[] {
  return APPS.filter((app) => app.releaseState === 'released');
}

/** Released core apps (always-on group for pickers). */
export function listCoreReleasedApps(): AppDefinition[] {
  return listReleasedApps().filter((app) => app.availability === 'core');
}

/** Released optional apps (selectable group for pickers). */
export function listOptionalReleasedApps(): AppDefinition[] {
  return listReleasedApps().filter((app) => app.availability === 'optional');
}

type AppModuleLoader = () => Promise<{ init: () => void | Promise<void> }>;

/** Dynamic import entry points for each Minnow app page bundle. */
export const APP_MODULE_LOADERS: Partial<Record<AppId, AppModuleLoader>> = {
  settings: () => import('../ui/settings-page').then((m) => ({ init: m.initSettingsPage })),
  bench: () => import('../ui/benchmark-page').then((m) => ({ init: m.initBenchmarkPage })),
  compare: () => import('../ui/compare-page').then((m) => ({ init: m.initComparePage })),
  models: () => import('../ui/models-page').then((m) => ({ init: m.initModelsPage })),
  brain: () => import('../ui/brain-page').then((m) => ({ init: m.initBrainPage })),
  scheduler: () => import('../ui/scheduler-page').then((m) => ({ init: m.initSchedulerPage })),
  issues: () => import('../ui/issues-page').then((m) => ({ init: m.initIssuesPage })),
  research: () => import('../research/panel').then((m) => ({ init: m.initResearchPage })),
  experts: () => import('../ui/experts/experts-hub').then((m) => ({ init: m.initExpertsHub })),
};
