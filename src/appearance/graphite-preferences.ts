import {
  normalizeAppearanceDensity,
  normalizeColorIntensity,
  normalizeGraphiteAccent,
  type AppearanceDensity,
  type ColorIntensity,
  type GraphiteAccent,
} from '../lib/appearance-choices.mjs';
import { scheduleAppearancePersist } from './persist-schedule';
import { APPEARANCE_STORAGE_KEYS } from './types';

export interface GraphitePreferences {
  colorIntensity: ColorIntensity;
  graphiteAccent: GraphiteAccent;
  density: AppearanceDensity;
  reduceMotion: boolean;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readGraphitePreferences(): GraphitePreferences {
  return {
    colorIntensity: normalizeColorIntensity(readStorage(APPEARANCE_STORAGE_KEYS.colorIntensity)),
    graphiteAccent: normalizeGraphiteAccent(readStorage(APPEARANCE_STORAGE_KEYS.graphiteAccent)),
    density: normalizeAppearanceDensity(readStorage(APPEARANCE_STORAGE_KEYS.density)),
    reduceMotion: readStorage(APPEARANCE_STORAGE_KEYS.reduceMotion) === '1',
  };
}

export function applyGraphitePreferences(prefs = readGraphitePreferences()): void {
  const root = document.documentElement;
  root.dataset.tint = prefs.colorIntensity;
  root.dataset.graphiteAccent = prefs.graphiteAccent;
  root.dataset.density = prefs.density;
  root.toggleAttribute('data-reduce-motion', prefs.reduceMotion);
}

export function setGraphitePreference<Key extends keyof GraphitePreferences>(
  key: Key,
  value: GraphitePreferences[Key],
): void {
  const prefs = { ...readGraphitePreferences(), [key]: value };
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEYS[key], typeof value === 'boolean' ? String(Number(value)) : value);
  } catch {}
  applyGraphitePreferences(prefs);
  scheduleAppearancePersist();
}
