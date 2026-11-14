import { usesGraphiteModels } from './graphite-chrome';

const STORAGE_KEY = 'minnow.models.inspector';

function modelsRoot(): HTMLElement | null {
  return document.getElementById('modelsView');
}

function isGraphiteServerSection(root: HTMLElement): boolean {
  return root.dataset.modelsSection === 'server' && usesGraphiteModels();
}

/** Whether the right-hand inspector column is visible on workbench sections. */
export function isModelsInspectorOpen(): boolean {
  const root = modelsRoot();
  return Boolean(root && !root.classList.contains('is-inspector-hidden') &&
    (!isGraphiteServerSection(root) || root.classList.contains('is-runtime-inspector')));
}

export function syncModelsInspectorToggle(): void {
  document.getElementById('btnModelsInspector')?.setAttribute('aria-expanded', String(isModelsInspectorOpen()));
}

export function toggleModelsInspector(): void {
  const root = modelsRoot();
  if (!root) return;
  const open = !isModelsInspectorOpen();
  if (isGraphiteServerSection(root)) root.classList.toggle('is-runtime-inspector', open);
  setModelsInspectorOpen(open);
}

/** Show or hide the inspector; syncs the header toggle and localStorage. */
export function setModelsInspectorOpen(open: boolean): void {
  const root = modelsRoot();
  root?.classList.toggle('is-inspector-hidden', !open);
  syncModelsInspectorToggle();
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
  }
}

/** Read persisted preference, or null when unavailable. */
export function readModelsInspectorPreference(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
