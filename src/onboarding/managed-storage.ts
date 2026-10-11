import { fetchCachedModels, fetchModelsConfig, saveModelsConfig } from '../models/api-client';
import { buildLibrary, type LibraryModel } from '../models/library';
import { openWorkspaceFolderPicker } from '../ui/workspace-folder-picker';
import { el } from './ui-helpers';

/** Add an existing model folder and select weights without leaving setup. */
export function mountManagedStorage(
  host: HTMLElement,
  onLoad: (model: LibraryModel) => Promise<void>,
): { setBusy(busy: boolean): void; destroy(): void } {
  let active = true;
  let busy = false;
  let scanning = false;
  let generation = 0;
  const root = el('details', 'mn-onboarding-storage');
  const summary = el('summary', undefined, 'Use existing model storage');
  const description = el('p', 'mn-onboarding-muted', 'Already have models? Choose their folder. Minnow reads them in place and keeps the folder in your library.');
  const form = el('div', 'mn-onboarding-storage__form');
  const input = el('input', 'mn-onboarding-field');
  input.placeholder = 'Path to your model folder';
  input.setAttribute('aria-label', 'Existing model folder');
  const browse = el('button', 'mn-onboarding-secondary-btn', 'Choose folder…');
  browse.type = 'button';
  const scan = el('button', 'mn-onboarding-secondary-btn', 'Scan folder');
  scan.type = 'button';
  const status = el('p', 'mn-onboarding-muted');
  status.setAttribute('role', 'status');
  const list = el('div', 'mn-onboarding-model-list');
  form.append(input, browse, scan);
  root.append(summary, description, form, status, list);
  host.append(root);

  function sync(): void {
    input.disabled = browse.disabled = scan.disabled = busy || scanning;
    list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || scanning; });
  }

  async function scanFolder(path?: string): Promise<void> {
    if (!active || busy || scanning) return;
    const current = ++generation;
    scanning = true;
    sync();
    status.textContent = 'Looking for models…';
    try {
      if (path?.trim()) {
        const config = await fetchModelsConfig();
        await saveModelsConfig({ modelDirs: [...new Set([...config.modelDirs, path.trim()])] });
      }
      const models = (await buildLibrary(await fetchCachedModels())).filter(model =>
        model.format === 'GGUF' && model.path && !model.incomplete);
      if (!active || current !== generation) return;
      list.replaceChildren();
      for (const model of models) {
        const button = el('button', 'mn-onboarding-model-row');
        button.type = 'button';
        const copy = el('span', 'mn-onboarding-managed-model-row__main');
        copy.append(el('span', 'mn-onboarding-model-row__name', model.name),
          el('span', 'mn-onboarding-managed-model-row__meta', `${model.quant} · ${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB`));
        button.append(copy, el('span', 'mn-onboarding-chip', 'Load model'));
        button.addEventListener('click', () => {
          if (!busy && !scanning) void onLoad(model);
        });
        list.append(button);
      }
      status.textContent = models.length ? `${models.length} model${models.length === 1 ? '' : 's'} found. Choose one to start.`
        : 'No complete GGUF models found. Choose another folder or download a model below.';
    } catch (error) {
      if (active) status.textContent = error instanceof Error ? error.message : 'Could not scan this folder. Try again.';
    } finally {
      scanning = false;
      if (active) sync();
    }
  }

  browse.addEventListener('click', () => {
    void (async () => {
      try {
        const result = await openWorkspaceFolderPicker({
          initialPath: input.value || undefined, title: 'Choose model storage', confirmVerb: 'Choose', elevated: true,
        });
        if (!active || result.cancelled || !result.path) return;
        input.value = result.path;
        await scanFolder(result.path);
      } catch (error) {
        if (active) status.textContent = error instanceof Error ? error.message : 'Could not open the folder picker.';
      }
    })();
  });
  scan.addEventListener('click', () => void scanFolder(input.value));
  root.addEventListener('toggle', () => { if (root.open && !list.childElementCount) void scanFolder(); });
  return {
    setBusy(value) { busy = value; sync(); },
    destroy() { active = false; generation += 1; },
  };
}
