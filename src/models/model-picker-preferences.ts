/** Device-local picker preferences. Model keys include the connection, not just the model id. */
export type ModelProviderSort = 'smart' | 'name' | 'local';
const STORAGE_KEY = 'minnow.modelPicker.v1';

interface PickerPreferences {
  favorites: string[];
  sort: ModelProviderSort;
  usage: Record<string, number>;
}

export function readModelPickerPreferences(): PickerPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      favorites: Array.isArray(saved?.favorites)
        ? [...new Set<string>(saved.favorites.filter((v: unknown) => typeof v === 'string' && v.trim()))]
        : [],
      sort: saved?.sort === 'name' || saved?.sort === 'local' ? saved.sort : 'smart',
      usage: Object.fromEntries(Object.entries(saved?.usage ?? {}).filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0)),
    };
  } catch {
    return { favorites: [], sort: 'smart', usage: {} };
  }
}

function writePreferences(preferences: PickerPreferences): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Storage can be unavailable. */ }
}

export function toggleModelPickerFavorite(key: string): void {
  const preferences = readModelPickerPreferences();
  preferences.favorites = preferences.favorites.includes(key)
    ? preferences.favorites.filter(value => value !== key)
    : [...preferences.favorites, key];
  writePreferences(preferences);
}

export function setModelProviderSort(sort: ModelProviderSort): void {
  writePreferences({ ...readModelPickerPreferences(), sort });
}

export function recordModelPickerUse(providerId: string): void {
  const preferences = readModelPickerPreferences();
  const usage = new Map(Object.entries(preferences.usage));
  usage.set(providerId, (usage.get(providerId) ?? 0) + 1);
  preferences.usage = Object.fromEntries([...usage].sort((a, b) => b[1] - a[1]).slice(0, 100));
  writePreferences(preferences);
}
