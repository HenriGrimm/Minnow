import { fetchWorkspace, saveProjectLocation } from '../config/workspace-api';
import { appendSettingsOfflineHint, createSettingsInputRow } from './settings-controls';
import { openWorkspaceFolderPicker } from './workspace-folder-picker';

/** Device-wide new-project default. Uses the same picker as the workspace wizard. */
export async function renderProjectLocationSettings(mount: HTMLElement): Promise<void> {
  const info = await fetchWorkspace();
  if (!info?.newProjectParent) {
    appendSettingsOfflineHint(mount, 'Open or restart Minnow to change the default project folder.');
    return;
  }
  let committed = info.newProjectParent;
  const { row, input } = createSettingsInputRow('Default project folder', {
    id: 'defaultProjectLocation',
    value: committed,
    searchKey: 'general.projectLocation',
    description: 'Use an existing folder, or clear this field to restore ~/Projects. Saves when you leave the field.',
    spellcheck: false,
  });
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'settings-inline-btn';
  choose.textContent = 'Choose…';
  const control = row.querySelector<HTMLElement>('.settings-row__control');
  if (control) {
    control.style.flexWrap = 'wrap';
    input.style.minWidth = '0';
    input.style.flex = '1 1 12rem';
    control.appendChild(choose);
  }
  const status = document.createElement('p');
  status.className = 'settings-field-hint';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  mount.append(row, status);

  async function commit(): Promise<void> {
    const next = input.value.trim();
    if (next === committed) return;
    input.disabled = choose.disabled = true;
    status.textContent = 'Saving…';
    try {
      committed = await saveProjectLocation(next);
      input.value = committed;
      status.textContent = 'Saved';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not save project location';
    } finally {
      input.disabled = choose.disabled = false;
    }
  }
  input.addEventListener('change', () => void commit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  choose.addEventListener('click', () => {
    void (async () => {
      choose.disabled = true;
      try {
        const picked = await openWorkspaceFolderPicker({
          initialPath: committed,
          title: 'Choose default project folder',
          confirmVerb: 'Choose',
        });
        if (!picked.cancelled && picked.path) {
          input.value = picked.path;
          await commit();
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not choose project folder';
      } finally {
        choose.disabled = false;
      }
    })();
  });
}
