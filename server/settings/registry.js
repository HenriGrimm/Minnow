/**
 * Server-side settings field registry — loads generated manifest + dynamic keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(__dirname, 'registry-manifest.json');

/** @type {import('../../src/settings/types.ts').SettingsFieldDef[] | null} */
let cachedManifest = null;

/**
 * @returns {import('../../src/settings/types.ts').SettingsFieldDef[]}
 */
export function loadRegistryManifest() {
  if (cachedManifest) return cachedManifest;
  const raw = fs.readFileSync(manifestPath, 'utf8');
  cachedManifest = JSON.parse(raw).filter(field => !field.key.startsWith('integrations.tools.permission.') && field.key !== 'integrations.tools.bulk');
  return cachedManifest;
}

/** @param {string} key */
export function getFieldByKey(key) {
  return loadRegistryManifest().find((field) => field.key === key);
}

/**
 * @param {string} query
 * @param {{ category?: string; area?: string }} [filters]
 */
export function searchFieldRegistry(query, filters) {
  const q = String(query ?? '').trim().toLowerCase();
  let fields = loadRegistryManifest();

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
      const hay = [field.key, field.label, field.description ?? '', ...(field.keywords ?? [])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    })
    .map(toCatalogEntry);
}

/** @param {import('../../src/settings/types.ts').SettingsFieldDef} field */
function toCatalogEntry(field) {
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
