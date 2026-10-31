/**
 * Tray-facing local model status and bulk unload helpers.
 */

import { unloadModel } from '../api/models';
import { isModelLoaded } from '../api/model-loaded-state';
import { listModelServes, stopModelServe } from '../models/api-client';
import { providerSupportsModelLoadUnload } from '../providers/capabilities';
import { fetchModelsForAllProviders } from '../providers/fetch-all-models';
import { listProviders } from '../providers/store';
import { formatModelLabel } from '../lib/format-model-label';
import type { LmModelRecord } from '../types';

export interface LocalModelTrayRow {
  id: string;
  providerId: string;
  label: string;
  source: 'lm-studio' | 'minnow-serve';
}

export interface LocalModelTraySnapshot {
  count: number;
  names: string[];
  rows: LocalModelTrayRow[];
}

export interface UnloadAllLocalModelsResult {
  unloaded: number;
  failures: Array<{ label: string; message: string }>;
}

const INVENTORY_TTL_MS = 30_000;
let inventory: LocalModelTraySnapshot | undefined;
let inventoryAt = 0;
let inventoryRevision = 0;
let inventoryPending: Promise<LocalModelTraySnapshot> | undefined;
let pendingRevision = 0;

export function invalidateLocalModelTraySnapshot(): void {
  inventoryRevision += 1;
  inventoryAt = 0;
}

function labelForModel(providerLabel: string, model: LmModelRecord): string {
  const formatted = formatModelLabel({ id: model.id, quantization: model.quantization });
  const primary = formatted.primary || model.id;
  return providerLabel ? `${primary} (${providerLabel})` : primary;
}

/** Collect loaded LM Studio rows and active Minnow-managed serves. */
export async function collectLocalModelTraySnapshot(
  signal?: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<LocalModelTraySnapshot> {
  // Explicit audit/unload reads remain fresh and retain their caller's cancellation scope.
  if (signal || options.fresh) return readLocalModelTraySnapshot(signal);
  if (inventory && inventoryAt > 0 && Date.now() - inventoryAt < INVENTORY_TTL_MS) return inventory;
  if (!inventoryPending) {
    pendingRevision = inventoryRevision;
    const revision = inventoryRevision;
    const task = readLocalModelTraySnapshot().then(snapshot => {
      if (revision === inventoryRevision) { inventory = snapshot; inventoryAt = Date.now(); }
      return snapshot;
    });
    inventoryPending = task.finally(() => { inventoryPending = undefined; });
  }
  const revision = pendingRevision;
  const snapshot = await inventoryPending;
  if (revision !== inventoryRevision) return collectLocalModelTraySnapshot();
  return snapshot;
}

async function readLocalModelTraySnapshot(signal?: AbortSignal): Promise<LocalModelTraySnapshot> {
  const rows: LocalModelTrayRow[] = [];
  const seen = new Set<string>();

  const { providers } = await listProviders();
  const enabled = providers.filter((p) => p.enabled !== false && providerSupportsModelLoadUnload(p));
  const controller = new AbortController();
  const abortSignal = signal ?? controller.signal;

  const [providerResults, serves] = await Promise.all([
    fetchModelsForAllProviders(enabled, abortSignal),
    listModelServes().catch(() => []),
  ]);

  for (const result of providerResults) {
    if (!providerSupportsModelLoadUnload(result.provider)) continue;
    for (const model of result.models) {
      if (!isModelLoaded(model.state)) continue;
      const key = `lm:${result.provider.id}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: model.id,
        providerId: result.provider.id,
        label: labelForModel(result.provider.label, model),
        source: 'lm-studio',
      });
    }
  }

  for (const serve of serves) {
    if (serve.status !== 'starting' && serve.status !== 'running') continue;
    const key = `serve:${serve.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = serve.modelLabel?.trim() || serve.modelPath || serve.id;
    rows.push({
      id: serve.id,
      providerId: serve.providerId,
      label,
      source: 'minnow-serve',
    });
  }

  const names = rows.map((row) => row.label);
  return { count: rows.length, names, rows };
}

/** Unload every controllable local model; aggregate partial failures. */
export async function unloadAllLocalModels(
  rows: LocalModelTrayRow[],
): Promise<UnloadAllLocalModelsResult> {
  const failures: Array<{ label: string; message: string }> = [];
  let unloaded = 0;

  for (const row of rows) {
    try {
      if (row.source === 'minnow-serve') {
        await stopModelServe(row.id);
      } else {
        await unloadModel(row.id, row.providerId);
      }
      unloaded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ label: row.label, message });
    }
  }

  return { unloaded, failures };
}
