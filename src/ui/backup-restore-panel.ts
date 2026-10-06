/**
 * Restore-from-backup flow: choose a backup, preview it, unpack it, restart.
 * Shared by Settings → General → Backup and restore and the setup wizard.
 */

import {
  BackupApiError,
  backupFileName,
  backupProgressPercent,
  cancelPendingRestore,
  formatBackupBytes,
  formatBackupWhen,
  inspectBackup,
  listBackups,
  startRestore,
  waitForBackupJob,
  type BackupListEntry,
  type BackupPreview,
  type StagedRestore,
} from '../backup/client';
import { appConfirm } from './app-dialog';
import { createSettingsActionsRow, createSettingsInputRow, createSettingsKvList } from './settings-controls';
import { openWorkspaceFolderPicker } from './workspace-folder-picker';
import '../styles/settings-backup.css';

export interface RestorePanelOptions {
  /** Folder to look in first. */
  initialDir: string;
  /** Installed desktop app, where Minnow can restart itself. */
  canRestartInPlace: boolean;
  /** Opened from the setup wizard: lift overlays above it and skip the confirm. */
  elevated?: boolean;
  /** The user backed out without restoring. */
  onClose?: () => void;
  /** A restore was staged or cancelled; the caller may want to refresh. */
  onChanged?: () => void;
}

export interface RestorePanelHandle {
  destroy(): void;
}

type Step = 'choose' | 'preview' | 'working' | 'staged';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Inline message block: `info`, `warn`, `danger` or `ok`. */
export function backupNote(tone: 'info' | 'warn' | 'danger' | 'ok', text: string): HTMLParagraphElement {
  const note = el('p', 'backup-note', text);
  note.dataset.tone = tone;
  note.setAttribute('role', tone === 'danger' ? 'alert' : 'note');
  return note;
}

/** Progress bar with a caption; reused by export, snapshot and restore. */
export function createBackupProgress(): {
  root: HTMLElement;
  set: (percent: number, caption: string) => void;
} {
  const root = el('div', 'backup-progress');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const track = el('div', 'backup-progress__track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const bar = el('div', 'backup-progress__bar');
  track.appendChild(bar);
  const caption = el('span', 'backup-progress__caption');
  root.append(track, caption);
  return {
    root,
    set(percent, text) {
      bar.style.width = `${percent}%`;
      track.setAttribute('aria-valuenow', String(percent));
      caption.textContent = text;
    },
  };
}

function protectionLabel(backup: { encrypted: boolean; includesCredentials: boolean }): string {
  if (!backup.encrypted) return 'Not encrypted · no credentials';
  return backup.includesCredentials ? 'Encrypted · includes credentials' : 'Encrypted';
}

function looksLikeBackupFile(value: string): boolean {
  return /\.mnbak$/i.test(value.trim());
}

/** Mount the restore flow into `host`. */
export function mountRestorePanel(host: HTMLElement, options: RestorePanelOptions): RestorePanelHandle {
  let destroyed = false;
  let step: Step = 'choose';
  let dir = options.initialDir;
  let backups: BackupListEntry[] = [];
  let preview: BackupPreview | null = null;
  let staged: StagedRestore | null = null;
  let selected = new Set<string>();
  /** Bumped on every folder load so a slow listing cannot overwrite a newer one. */
  let listGeneration = 0;

  const root = el('section', 'backup-restore');
  root.setAttribute('aria-label', 'Restore from a backup');
  host.appendChild(root);

  const render = (): void => {
    if (destroyed) return;
    root.replaceChildren();
    root.dataset.step = step;
    if (step === 'choose') renderChoose();
    else if (step === 'preview') renderPreview();
    else if (step === 'staged') renderStaged();
  };

  // ── Choose ─────────────────────────────────────────────────────────────────

  function renderChoose(): void {
    const { row, input } = createSettingsInputRow('Backup folder', {
      value: dir,
      placeholder: 'Folder with your backups, or the path of a .mnbak file',
      description: 'Choose the folder your backups are in, or paste the path of one backup file.',
      spellcheck: false,
    });
    input.classList.add('backup-path-input');
    const choose = el('button', 'settings-inline-btn', 'Choose…');
    choose.type = 'button';
    choose.addEventListener('click', () => {
      void (async () => {
        const picked = await openWorkspaceFolderPicker({
          initialPath: dir,
          title: 'Choose backup folder',
          confirmVerb: 'Choose',
          elevated: options.elevated,
        });
        if (picked.cancelled || !picked.path) return;
        dir = picked.path;
        input.value = dir;
        void loadFolder(listMount);
      })();
    });
    const control = row.querySelector('.settings-row__control');
    control?.classList.add('backup-inline-control');
    control?.appendChild(choose);
    const commit = (): void => {
      const next = input.value.trim();
      if (next === dir) return;
      dir = next;
      void loadFolder(listMount);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    root.appendChild(row);

    const listMount = el('div', 'backup-restore__list-mount');
    root.appendChild(listMount);

    if (options.onClose) {
      root.appendChild(
        createSettingsActionsRow([{ label: 'Cancel', onClick: () => options.onClose?.() }]),
      );
    }
    void loadFolder(listMount);
  }

  async function loadFolder(mount: HTMLElement): Promise<void> {
    const generation = ++listGeneration;
    mount.replaceChildren(el('p', 'settings-field-hint backup-restore__status', 'Looking for backups…'));
    if (!dir) {
      mount.replaceChildren(el('p', 'settings-field-hint backup-restore__status', 'Choose a folder to look in.'));
      return;
    }
    try {
      if (looksLikeBackupFile(dir)) {
        await openPreview(dir);
        return;
      }
      const found = await listBackups(dir);
      if (destroyed || generation !== listGeneration) return;
      backups = found;
      renderList(mount);
    } catch (err) {
      if (destroyed || generation !== listGeneration) return;
      mount.replaceChildren(
        backupNote('danger', err instanceof Error ? err.message : 'Could not read that folder.'),
      );
    }
  }

  function renderList(mount: HTMLElement): void {
    mount.replaceChildren();
    if (backups.length === 0) {
      mount.appendChild(
        el('p', 'settings-field-hint backup-restore__status', 'No Minnow backups in this folder.'),
      );
      return;
    }
    const list = el('ul', 'backup-restore__list');
    list.setAttribute('aria-label', 'Backups in this folder');
    for (const backup of backups) {
      const item = el('li', 'backup-restore__item');
      const button = el('button', 'backup-restore__pick');
      button.type = 'button';
      const when = el('span', 'backup-restore__when', formatBackupWhen(backup.createdAt));
      const meta = el(
        'span',
        'backup-restore__meta',
        `${formatBackupBytes(backup.archiveBytes)} · ${protectionLabel(backup)}`,
      );
      const name = el('span', 'backup-restore__name', backup.name);
      button.append(when, meta, name);
      button.addEventListener('click', () => void openPreview(backup.file));
      item.appendChild(button);
      list.appendChild(item);
    }
    mount.appendChild(list);
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  async function openPreview(file: string): Promise<void> {
    try {
      const next = await inspectBackup(file);
      if (destroyed) return;
      preview = next;
      selected = new Set(next.categories.filter((row) => row.known).map((row) => row.id));
      step = 'preview';
      render();
    } catch (err) {
      if (destroyed) return;
      step = 'choose';
      render();
      root.appendChild(backupNote('danger', err instanceof Error ? err.message : 'Could not read that backup.'));
    }
  }

  function renderPreview(): void {
    if (!preview) return;
    const backup = preview;

    root.appendChild(
      createSettingsKvList(
        [
          { term: 'Backup', value: backupFileName(backup.file) },
          { term: 'Created', value: formatBackupWhen(backup.createdAt) },
          { term: 'Made with', value: backup.appVersion ? `Minnow ${backup.appVersion}` : 'Unknown version' },
          {
            term: 'Size',
            value: `${formatBackupBytes(backup.archiveBytes)} on disk · ${formatBackupBytes(backup.totals.bytes)} unpacked`,
          },
          { term: 'Protection', value: protectionLabel(backup) },
        ],
        { className: 'settings-kv backup-restore__summary' },
      ),
    );

    let passphraseInput: HTMLInputElement | null = null;
    if (backup.encrypted) {
      const { row, input } = createSettingsInputRow('Passphrase', {
        type: 'password',
        autocomplete: 'off',
        description: 'The passphrase this backup was created with.',
      });
      passphraseInput = input;
      root.appendChild(row);
    }

    const stack = el('div', 'settings-field-stack');
    const labelId = `backupRestoreContents-${backup.createdAt.replace(/\W/g, '')}`;
    const label = el('span', 'settings-field-stack__label', 'What to restore');
    label.id = labelId;
    stack.appendChild(label);
    const list = el('div', 'settings-checklist backup-checklist');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-labelledby', labelId);
    for (const row of backup.categories) {
      const option = el('label', 'settings-checklist__option backup-checklist__option');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = selected.has(row.id);
      input.disabled = !row.known;
      input.addEventListener('change', () => {
        if (input.checked) selected.add(row.id);
        else selected.delete(row.id);
        restoreBtn.disabled = selected.size === 0;
      });
      const text = el('span', 'backup-checklist__text');
      text.appendChild(el('span', 'settings-checklist__label-text', row.label));
      if (row.description) text.appendChild(el('span', 'backup-checklist__desc', row.description));
      const size = el('span', 'backup-checklist__size', formatBackupBytes(row.bytes));
      option.append(input, text, size);
      list.appendChild(option);
    }
    stack.appendChild(list);
    root.appendChild(stack);

    for (const warning of backup.warnings) root.appendChild(backupNote('warn', warning));
    root.appendChild(
      backupNote(
        'info',
        'Minnow unpacks and checks the backup now, then switches to it the next time it starts. The data you have now is set aside, not deleted, and you can undo the restore afterwards.',
      ),
    );

    const feedback = el('div', 'backup-restore__feedback');
    root.appendChild(feedback);

    const actions = createSettingsActionsRow([
      { label: 'Restore', variant: 'primary', id: 'backupRestoreConfirmBtn' },
      {
        label: 'Back',
        onClick: () => {
          step = 'choose';
          // A pasted file path has no folder list to go back to.
          if (looksLikeBackupFile(dir)) dir = dir.replace(/[\\/][^\\/]*$/, '');
          render();
        },
      },
    ]);
    const restoreBtn = actions.querySelector<HTMLButtonElement>('#backupRestoreConfirmBtn')!;
    restoreBtn.addEventListener('click', () => {
      void runRestore(backup, passphraseInput?.value ?? '', feedback, actions);
    });
    root.appendChild(actions);
  }

  async function runRestore(
    backup: BackupPreview,
    passphrase: string,
    feedback: HTMLElement,
    actions: HTMLElement,
  ): Promise<void> {
    feedback.replaceChildren();
    if (backup.encrypted && !passphrase) {
      feedback.appendChild(backupNote('danger', 'Enter the passphrase for this backup.'));
      return;
    }
    if (!options.elevated) {
      const ok = await appConfirm(
        `Restore the backup from ${formatBackupWhen(backup.createdAt)}?\n\nThe parts you selected replace what Minnow has now the next time it starts. Your current data is kept so you can undo this.`,
        { confirmLabel: 'Restore' },
      );
      if (!ok || destroyed) return;
    }

    const buttons = [...actions.querySelectorAll<HTMLButtonElement>('button')];
    for (const button of buttons) button.disabled = true;
    const progress = createBackupProgress();
    progress.set(0, 'Unpacking and checking the backup…');
    feedback.appendChild(progress.root);

    try {
      const job = await startRestore({
        path: backup.file,
        passphrase: passphrase || undefined,
        categories: backup.categories.filter((row) => selected.has(row.id)).map((row) => row.id),
      });
      const finished = await waitForBackupJob(job, (current) => {
        progress.set(
          backupProgressPercent(current.progress),
          `Unpacking and checking the backup… ${current.progress.files.toLocaleString()} of ${current.progress.totalFiles.toLocaleString()} files`,
        );
      });
      if (destroyed) return;
      if (finished.status !== 'done' || !finished.result) {
        throw new BackupApiError(finished.error || 'The restore could not be prepared.', finished.errorCode);
      }
      staged = finished.result;
      step = 'staged';
      render();
      options.onChanged?.();
    } catch (err) {
      if (destroyed) return;
      for (const button of buttons) button.disabled = false;
      feedback.replaceChildren(
        backupNote('danger', err instanceof Error ? err.message : 'The restore could not be prepared.'),
      );
    }
  }

  // ── Staged ─────────────────────────────────────────────────────────────────

  function renderStaged(): void {
    const restart = window.minnow?.app?.restart;
    const canRestart = options.canRestartInPlace && typeof restart === 'function';
    root.appendChild(
      backupNote(
        'ok',
        canRestart
          ? 'The backup is unpacked and checked. Restart Minnow to switch to it.'
          : 'The backup is unpacked and checked. Quit Minnow and start it again to switch to it.',
      ),
    );
    for (const warning of staged?.warnings ?? []) root.appendChild(backupNote('warn', warning));

    const feedback = el('div', 'backup-restore__feedback');
    root.appendChild(
      createSettingsActionsRow([
        ...(canRestart
          ? [
              {
                label: 'Restart Minnow',
                variant: 'primary' as const,
                title: 'Active sessions will close and Minnow will reopen.',
                onClick: () => void restart!(),
              },
            ]
          : []),
        {
          label: 'Cancel restore',
          onClick: () => {
            void (async () => {
              try {
                await cancelPendingRestore();
                staged = null;
                step = 'choose';
                render();
                options.onChanged?.();
              } catch (err) {
                feedback.replaceChildren(
                  backupNote('danger', err instanceof Error ? err.message : 'Could not cancel the restore.'),
                );
              }
            })();
          },
        },
      ]),
    );
    root.appendChild(feedback);
  }

  render();

  return {
    destroy() {
      destroyed = true;
      root.remove();
    },
  };
}
