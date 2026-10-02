import { fetchModelsConfig, saveModelsConfig } from '../../models/api-client';
import { setStatus } from '../status';
import { getLocalServerAvailable } from '../../tools/client';
import { openWorkspaceFolderPicker } from '../workspace-folder-picker';
import { el, emptyState, icon, iconButton, textButton } from './dom';
import { refreshModels } from './store';

/** Folders Minnow always scans, shown so the extra list reads as additive. */
const BUILT_IN_ROOTS = [
  { path: '~/.minnow/models', note: 'Downloads started from Discover' },
  { path: '~/.cache/huggingface/hub', note: 'Hugging Face hub cache' },
];

function field(label: string, hint: string, control: HTMLElement): HTMLElement {
  const wrap = el('div', 'models-field-block');
  wrap.append(el('span', 'models-field__label', label), control, el('p', 'models-hint', hint));
  return wrap;
}

/** Render the Storage panel. */
export async function mountModelsSettingsSection(): Promise<void> {
  const mount = document.getElementById('modelsSettingsBody');
  if (!mount) return;
  mount.replaceChildren(el('p', 'models-muted', 'Loading…'));

  let config;
  try {
    config = await fetchModelsConfig();
  } catch (err) {
    mount.replaceChildren(
      emptyState({
        glyph: 'triangle-warning',
        title: 'Could not read storage settings',
        body: err instanceof Error ? err.message : 'Unknown error.',
        action: { label: 'Try again', onClick: () => void mountModelsSettingsSection() },
      }),
    );
    return;
  }

  let dirs = [...config.modelDirs];
  let dirsSaveInFlight = false;

  /** Persist extra scan folders and refresh the library index. */
  const persistDirs = async (okMessage: string): Promise<boolean> => {
    if (dirsSaveInFlight) return false;
    dirsSaveInFlight = true;
    try {
      const next = await saveModelsConfig({ modelDirs: dirs });
      dirs = [...next.modelDirs];
      renderDirs();
      setStatus('ok', okMessage);
      void refreshModels({ fresh: true });
      return true;
    } catch (err: unknown) {
      setStatus('err', err instanceof Error ? err.message : 'Save failed');
      return false;
    } finally {
      dirsSaveInFlight = false;
    }
  };

  const fragment = document.createDocumentFragment();

  const rootsBlock = el('section', 'models-block');
  rootsBlock.appendChild(el('h3', 'models-block__label', 'Always scanned'));
  const roots = el('div', 'models-path-list');
  for (const root of BUILT_IN_ROOTS) {
    const row = el('div', 'models-path-row is-builtin');
    row.append(icon('folder'), el('span', 'models-path-row__path', root.path));
    row.appendChild(el('span', 'models-path-row__note', root.note));
    roots.appendChild(row);
  }
  rootsBlock.appendChild(roots);
  fragment.appendChild(rootsBlock);

  const dirsBlock = el('section', 'models-block');
  dirsBlock.appendChild(el('h3', 'models-block__label', 'Extra folders'));
  const dirsList = el('div', 'models-path-list');

  const renderDirs = () => {
    dirsList.replaceChildren();
    if (!dirs.length) {
      dirsList.appendChild(
        el('p', 'models-muted', 'None yet. Add a folder holding GGUF files to include it in every scan.'),
      );
      return;
    }
    for (const dir of dirs) {
      const row = el('div', 'models-path-row');
      row.append(icon('folder-open'), el('span', 'models-path-row__path', dir));
      row.appendChild(
        iconButton('cross-circle', `Remove ${dir}`, () => {
          dirs = dirs.filter((d) => d !== dir);
          renderDirs();
          void persistDirs('Folder removed.');
        }),
      );
      dirsList.appendChild(row);
    }
  };
  renderDirs();
  dirsBlock.appendChild(dirsList);

  const addRow = el('div', 'models-inline-form');
  const dirInput = el('input', 'models-field__input') as HTMLInputElement;
  dirInput.type = 'text';
  dirInput.placeholder = '~/models or C:\\models';
  dirInput.setAttribute('aria-label', 'Folder to scan');
  const addDirFromPath = (rawPath: string): void => {
    const value = rawPath.trim();
    if (!value) return;
    if (dirs.includes(value)) {
      setStatus('err', 'That folder is already in the list.');
      return;
    }
    dirs = [...dirs, value];
    dirInput.value = '';
    renderDirs();
    void persistDirs('Folder added.');
  };

  const addDir = () => addDirFromPath(dirInput.value);
  dirInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addDir();
    }
  });
  const browseBtn = textButton('Browse…', () => {
    void (async () => {
      if (!getLocalServerAvailable()) {
        setStatus('err', 'Folder browse requires Minnow running locally');
        return;
      }
      const initial = dirInput.value.trim() || dirs[dirs.length - 1];
      const result = await openWorkspaceFolderPicker({
        initialPath: initial || undefined,
      });
      if (result.cancelled || !result.path) return;
      addDirFromPath(result.path);
    })();
  });
  addRow.append(dirInput, browseBtn, textButton('Add', addDir));
  dirsBlock.appendChild(addRow);
  fragment.appendChild(dirsBlock);

  const hfBlock = el('section', 'models-block');
  hfBlock.appendChild(el('h3', 'models-block__label', 'Hugging Face token'));
  const hfInput = el('input', 'models-field__input') as HTMLInputElement;
  hfInput.type = 'password';
  hfInput.autocomplete = 'off';
  hfInput.placeholder = config.hfTokenConfigured
    ? `Stored (${config.hfTokenMasked}) — enter a new one to replace`
    : 'hf_…';
  hfInput.setAttribute('aria-label', 'Hugging Face access token');
  hfBlock.appendChild(
    field(
      'Access token',
      'Only needed for gated repositories and higher download rate limits. Stored encrypted under ~/.minnow.',
      hfInput,
    ),
  );

  const hfActions = el('div', 'models-inline-form');
  const clearHf = textButton(
    'Clear',
    () => {
      void saveModelsConfig({ clearHfToken: true })
        .then(() => {
          hfInput.value = '';
          hfInput.placeholder = 'hf_…';
          clearHf.hidden = true;
          setStatus('ok', 'Hugging Face token cleared.');
        })
        .catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Clear failed');
        });
    },
    'danger',
  );
  clearHf.hidden = !config.hfTokenConfigured;

  // A blank field means "keep the stored token"; Clear removes it. The token
  // saves when the field loses focus, so no explicit Save press is needed.
  hfInput.addEventListener('change', () => {
    const token = hfInput.value.trim();
    if (!token) return;
    void saveModelsConfig({ hfToken: token })
      .then((next) => {
        hfInput.value = '';
        hfInput.placeholder = `Stored (${next.hfTokenMasked}) — enter a new one to replace`;
        clearHf.hidden = !next.hfTokenConfigured;
        setStatus('ok', 'Hugging Face token saved.');
      })
      .catch((err: unknown) => {
        setStatus('err', err instanceof Error ? err.message : 'Save failed');
      });
  });
  hfActions.append(clearHf);
  hfBlock.appendChild(hfActions);
  fragment.appendChild(hfBlock);

  mount.replaceChildren(fragment);
}
