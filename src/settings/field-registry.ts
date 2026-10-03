/**
 * Settings field registry — catalog + storage overlay + dynamic tool-permission keys.
 */

import { BUILT_IN_TOOLS } from '../tools/definitions';
import { resolveSettingsSectionNavigation } from '../ui/settings-section-navigation';
import {
  SETTINGS_FIELD_CATALOG,
  type SettingsFieldEntry,
} from '../ui/settings-catalog';
import {
  DEFAULT_OVERLAY,
  SETTINGS_STORAGE_OVERLAY,
  toolPermissionFieldDef,
} from './storage-overlay';
import type {
  SettingsCatalogEntry,
  SettingsFieldDef,
} from './types';

function overlayForKey(key: string) {
  return SETTINGS_STORAGE_OVERLAY[key] ?? DEFAULT_OVERLAY;
}

/** Build a full registry entry from a catalog row + storage overlay. */
export function catalogEntryToFieldDef(entry: SettingsFieldEntry): SettingsFieldDef {
  const overlay = overlayForKey(entry.key);
  return {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    keywords: entry.keywords,
    category: entry.category,
    area: entry.area,
    storage: overlay.storage ?? 'section',
    path: overlay.path,
    resource: overlay.resource,
    type: overlay.type ?? 'string',
    allowedValues: overlay.allowedValues,
    sensitivity: overlay.sensitivity ?? 'normal',
    writable: overlay.writable ?? false,
    refreshAreas: (overlay.refreshAreas ?? [entry.area]).map((area) =>
      resolveSettingsSectionNavigation(area, entry.key).sectionId),
  };
}

/** Static registry entries from SETTINGS_FIELD_CATALOG. */
export function buildStaticFieldRegistry(): SettingsFieldDef[] {
  return SETTINGS_FIELD_CATALOG.map(catalogEntryToFieldDef);
}

/** Dynamic per-tool permission keys (integrations.tools.permission.<toolId>). */
export function buildDynamicToolPermissionFields(): SettingsFieldDef[] {
  return BUILT_IN_TOOLS.map((tool) => toolPermissionFieldDef(tool.id));
}

/** Full registry: static catalog + dynamic tool permissions. */
export function buildFullFieldRegistry(): SettingsFieldDef[] {
  const staticKeys = new Set(SETTINGS_FIELD_CATALOG.map((e) => e.key));
  const dynamic = buildDynamicToolPermissionFields().filter((d) => !staticKeys.has(d.key));
  return [...buildStaticFieldRegistry(), ...dynamic];
}

let cachedRegistry: SettingsFieldDef[] | null = null;

/** Cached full registry (rebuilt on first access). */
export function getFieldRegistry(): SettingsFieldDef[] {
  if (!cachedRegistry) {
    cachedRegistry = buildFullFieldRegistry();
  }
  return cachedRegistry;
}

/** Reset registry cache (tests). */
export function resetFieldRegistryCache(): void {
  cachedRegistry = null;
}

/** Lookup one field by canonical key. */
export function getFieldByKey(key: string): SettingsFieldDef | undefined {
  return getFieldRegistry().find((field) => field.key === key);
}

/** Catalog metadata for search_settings (no values). */
export function toCatalogEntry(field: SettingsFieldDef): SettingsCatalogEntry {
  return {
    key: field.key,
    label: field.label,
    description: field.description,
    type: field.type,
    category: field.category,
    area: field.area,
    allowedValues: field.allowedValues,
    sensitivity: field.sensitivity,
    writable: field.writable,
  };
}

/** Search registry by label, key, keywords, and optional filters. */
export function searchFieldRegistry(
  query: string,
  filters?: { category?: string; area?: string },
): SettingsCatalogEntry[] {
  const q = query.trim().toLowerCase();
  let fields = getFieldRegistry();

  if (filters?.category) {
    fields = fields.filter((f) => f.category === filters.category);
  }
  if (filters?.area) {
    fields = fields.filter((f) => f.area === filters.area);
  }

  if (!q) {
    return fields.map(toCatalogEntry);
  }

  return fields
    .filter((field) => {
      const hay = [
        field.key,
        field.label,
        field.description ?? '',
        ...(field.keywords ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    })
    .map(toCatalogEntry);
}

/** JSON-serializable manifest for the server registry mirror. */
export function exportRegistryManifest(): SettingsFieldDef[] {
  return buildFullFieldRegistry();
}
