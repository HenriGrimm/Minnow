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
  let busy = false;
  const { row, input } = createSettingsInputRow('Default project folder', {
    id: 'defaultProjectLocation',
    value: committed,
    searchKey: 'general.projectLocation',
    description: 'Choose an existing folder or enter its full path. Changes save automatically.',
    autocomplete: 'off',
    spellcheck: false,
  });
  row.classList.add('settings-project-location');
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'settings-inline-btn';
  choose.textContent = 'Browse…';
  const control = row.querySelector<HTMLElement>('.settings-row__control')!;
  const pathRow = document.createElement('div');
  pathRow.className = 'settings-project-location__path';
  pathRow.append(input, choose);
  const status = document.createElement('p');
  status.className = 'settings-field-hint';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.id = 'defaultProjectLocation-status';
  input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby')} ${status.id}`);
  control.append(pathRow, status);
  mount.append(row);

  function updateControls(): void {
    input.disabled = choose.disabled = busy;
    row.setAttribute('aria-busy', String(busy));
  }

  function feedback(message: string, invalid = false): void {
    status.textContent = message;
    status.classList.toggle('settings-project-location__error', invalid);
    input.setAttribute('aria-invalid', String(invalid));
  }

  async function commit(next = input.value.trim()): Promise<void> {
    if (busy) return;
    if (next === committed) {
      input.value = committed;
      return;
    }
    busy = true;
    updateControls();
    feedback('Saving…');
    try {
      committed = await saveProjectLocation(next);
      input.value = committed;
      feedback(next ? 'Saved' : 'Default restored');
    } catch (error) {
      feedback(error instanceof Error ? error.message : 'Could not save project location. Try again.', true);
    } finally {
      busy = false;
      updateControls();
    }
  }
  input.addEventListener('input', () => {
    feedback('');
    updateControls();
  });
  input.addEventListener('blur', (event) => {
    if (event.relatedTarget === choose) return;
    void commit();
  });
  choose.addEventListener('blur', () => void commit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      event.stopPropagation();
      input.value = committed;
      feedback('');
      updateControls();
    }
  });
  choose.addEventListener('click', () => {
    if (busy) return;
    void (async () => {
      busy = true;
      updateControls();
      try {
        const picked = await openWorkspaceFolderPicker({
          initialPath: committed,
          title: 'Choose default project folder',
          confirmVerb: 'Choose',
        });
        if (!picked.cancelled && picked.path) {
          input.value = picked.path;
          feedback('');
          busy = false;
          await commit();
        }
      } catch (error) {
        feedback(error instanceof Error ? error.message : 'Could not choose project folder. Try again.');
      } finally {
        busy = false;
        updateControls();
        if (mount.isConnected) choose.focus();
      }
    })();
  });
  updateControls();
}
