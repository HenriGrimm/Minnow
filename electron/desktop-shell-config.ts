import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importServerModule } from './server-import.js';
import {
  clampShellZoomPercent,
  DEFAULT_SHELL_ZOOM_PERCENT,
} from './shell-zoom.js';
import {
  DEFAULT_WINDOW_CLOSE_ACTION,
  normalizeWindowCloseAction,
  type WindowCloseAction,
} from './tray-close.js';

const CONFIG_FILE = 'config.json';

export const DEFAULT_CLOSE_TO_TRAY = true;

export const DEFAULT_HARDWARE_ACCELERATION = true;

export { DEFAULT_SHELL_ZOOM_PERCENT };

function readDesktopShell(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const shell = (raw as Record<string, unknown>).desktopShell;
  return shell && typeof shell === 'object' ? (shell as Record<string, unknown>) : null;
}

function normalizeCloseToTray(raw: unknown): boolean {
  const shell = readDesktopShell(raw);
  if (!shell) return DEFAULT_CLOSE_TO_TRAY;
  const value = shell.closeToTray;
  return typeof value === 'boolean' ? value : DEFAULT_CLOSE_TO_TRAY;
}

function normalizeWindowCloseActionPref(raw: unknown): WindowCloseAction {
  const shell = readDesktopShell(raw);
  if (!shell) return DEFAULT_WINDOW_CLOSE_ACTION;
  return normalizeWindowCloseAction(shell.windowCloseAction);
}

function normalizeHardwareAcceleration(raw: unknown): boolean {
  const shell = readDesktopShell(raw);
  if (!shell) return DEFAULT_HARDWARE_ACCELERATION;
  const value = shell.hardwareAcceleration;
  return typeof value === 'boolean' ? value : DEFAULT_HARDWARE_ACCELERATION;
}

function normalizeShellZoomPercent(raw: unknown): number {
  const shell = readDesktopShell(raw);
  if (!shell) return DEFAULT_SHELL_ZOOM_PERCENT;
  return clampShellZoomPercent(shell.zoomPercent);
}

async function resolveConfigPath(): Promise<string> {
  const { getMinnowHome } = await importServerModule<{ getMinnowHome: () => string }>(
    'config/home.js',
  );
  return path.join(getMinnowHome(), CONFIG_FILE);
}

export async function readShellZoomPercent(): Promise<number> {
  try {
    const configPath = await resolveConfigPath();
    const raw = await fs.readFile(configPath, 'utf8');
    const meta = JSON.parse(raw) as unknown;
    return normalizeShellZoomPercent(meta);
  } catch {
    return DEFAULT_SHELL_ZOOM_PERCENT;
  }
}

async function updateDesktopShell(patch: Record<string, unknown>): Promise<void> {
  const { updateConfigJson } = await importServerModule<{
    updateConfigJson: (rel: string, mutate: (current: unknown) => unknown) => Promise<unknown>;
  }>('config/store.js');
  const { mergeConfigMeta } = await importServerModule<{
    mergeConfigMeta: (current: unknown, fields: Record<string, unknown>) => Record<string, unknown>;
  }>('config/validators.js');
  await updateConfigJson(CONFIG_FILE, current => mergeConfigMeta(current, { desktopShell: patch }));
}

export async function writeShellZoomPercent(percent: number): Promise<number> {
  const next = clampShellZoomPercent(percent);
  await updateDesktopShell({ zoomPercent: next });
  return next;
}

export async function readCloseToTrayPreference(): Promise<boolean> {
  try {
    const configPath = await resolveConfigPath();
    const raw = await fs.readFile(configPath, 'utf8');
    const meta = JSON.parse(raw) as unknown;
    return normalizeCloseToTray(meta);
  } catch {
    return DEFAULT_CLOSE_TO_TRAY;
  }
}

export async function writeCloseToTrayPreference(enabled: boolean): Promise<boolean> {
  await updateDesktopShell({ closeToTray: enabled });
  return enabled;
}

export async function readWindowCloseAction(): Promise<WindowCloseAction> {
  try {
    const configPath = await resolveConfigPath();
    const raw = await fs.readFile(configPath, 'utf8');
    return normalizeWindowCloseActionPref(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_WINDOW_CLOSE_ACTION;
  }
}

export async function writeWindowCloseAction(
  action: WindowCloseAction,
): Promise<WindowCloseAction> {
  const next = normalizeWindowCloseAction(action);
  await updateDesktopShell({ windowCloseAction: next });
  return next;
}

// Read-only home lookup; skip the ~/.speedchat rename from server/config/home.js.
function resolveMinnowHomeSync(): string {
  const override =
    (typeof process.env.MINNOW_HOME === 'string' && process.env.MINNOW_HOME.trim()) ||
    (typeof process.env.SPEEDCHAT_HOME === 'string' && process.env.SPEEDCHAT_HOME.trim());
  if (override) return path.resolve(override);

  const home = path.join(os.homedir(), '.minnow');
  if (fsSync.existsSync(home)) return home;
  const legacy = path.join(os.homedir(), '.speedchat');
  if (fsSync.existsSync(legacy)) return legacy;
  return home;
}

// Must run before Electron ready; disableHardwareAcceleration is a no-op after that.
export function readHardwareAccelerationSync(): boolean {
  try {
    const configPath = path.join(resolveMinnowHomeSync(), CONFIG_FILE);
    const raw = fsSync.readFileSync(configPath, 'utf8');
    return normalizeHardwareAcceleration(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_HARDWARE_ACCELERATION;
  }
}

export async function readHardwareAccelerationPreference(): Promise<boolean> {
  try {
    const configPath = await resolveConfigPath();
    const raw = await fs.readFile(configPath, 'utf8');
    const meta = JSON.parse(raw) as unknown;
    return normalizeHardwareAcceleration(meta);
  } catch {
    return DEFAULT_HARDWARE_ACCELERATION;
  }
}

export async function writeHardwareAccelerationPreference(enabled: boolean): Promise<boolean> {
  await updateDesktopShell({ hardwareAcceleration: enabled });
  return enabled;
}
