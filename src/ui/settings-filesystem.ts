import { detectConfigServer } from '../config/storage-mode';
import {
  loadToolSecurityMeta,
  saveToolSecurityMeta,
  type FilesystemAccessMode,
} from '../config/tool-security-meta';
import { appConfirm } from './app-dialog';
import { setStatus } from './status';
import { appendSettingsOfflineHint } from './settings-controls';

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

function dangerBanner(message: string): HTMLElement {
  const p = el('p', 'settings-filesystem-warning');
  p.setAttribute('role', 'note');
  p.textContent = message;
  return p;
}

function createSegmentButton(
  label: string,
  mode: FilesystemAccessMode,
  group: HTMLElement,
  onSelect: (mode: FilesystemAccessMode) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-segment settings-filesystem-segment';
  btn.dataset.fsAccess = mode;
  btn.textContent = label;
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => onSelect(mode));
  group.appendChild(btn);
  return btn;
}

function setActiveSegment(group: HTMLElement, mode: FilesystemAccessMode): void {
  for (const btn of group.querySelectorAll<HTMLButtonElement>('.settings-filesystem-segment')) {
    const active = btn.dataset.fsAccess === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

/** Render filesystem access controls into the General settings mount. */
export async function renderFilesystemAccessSettings(mount: HTMLElement): Promise<void> {
  const serverUp = await detectConfigServer();
  if (serverUp !== 'server') {
    appendSettingsOfflineHint(
      mount,
      'Filesystem access settings are saved on this device. Open Minnow, then reopen Settings.',
    );
    return;
  }

  const meta = await loadToolSecurityMeta();
  let selectedMode: FilesystemAccessMode =
    meta.filesystemAccess === 'full' ? 'full' : 'workspace';

  const section = el('section', 'settings-filesystem');
  section.dataset.settingsSearchKey = 'general.filesystem';

  const segmentGroup = el('div', 'settings-segments settings-filesystem-segments');
  segmentGroup.setAttribute('role', 'group');
  segmentGroup.setAttribute('aria-label', 'Filesystem access');

  const workspaceBtn = createSegmentButton('Workspace only', 'workspace', segmentGroup, (mode) => {
    void applyMode(mode);
  });
  workspaceBtn.id = 'fsAccessWorkspaceSettings';

  const fullBtn = createSegmentButton('Full disk', 'full', segmentGroup, (mode) => {
    void applyMode(mode);
  });
  fullBtn.id = 'fsAccessFullSettings';

  setActiveSegment(segmentGroup, selectedMode);
  section.appendChild(segmentGroup);

  const workspaceHint = el(
    'p',
    'settings-field-hint settings-filesystem-hint',
    'File, git, and related tools stay inside your open project folder. Paths outside the workspace are blocked.',
  );
  workspaceHint.hidden = selectedMode !== 'workspace';
  section.appendChild(workspaceHint);

  const warning = dangerBanner(
    'Full disk lets models read and write anywhere on this computer. A mistaken or untrusted model could touch sensitive files outside your project. Use only when you need paths outside the workspace and accept that risk.',
  );
  warning.hidden = selectedMode !== 'full';
  section.appendChild(warning);

  mount.appendChild(section);

  function refreshHints(mode: FilesystemAccessMode): void {
    workspaceHint.hidden = mode !== 'workspace';
    warning.hidden = mode !== 'full';
  }

  async function applyMode(mode: FilesystemAccessMode): Promise<void> {
    if (mode === selectedMode) return;

    if (mode === 'full') {
      const ok = await appConfirm(
        'Enable full filesystem access?\n\nFile and git tools will resolve paths outside your current workspace. A malicious or mistaken model could read or modify sensitive files anywhere on this computer.\n\nOnly continue if you understand and accept this risk.',
      );
      if (!ok) return;
    }

    const prev = selectedMode;
    selectedMode = mode;
    setActiveSegment(segmentGroup, mode);
    refreshHints(mode);

    try {
      await saveToolSecurityMeta({ filesystemAccess: mode });
    } catch {
      selectedMode = prev;
      setActiveSegment(segmentGroup, prev);
      refreshHints(prev);
      setStatus('err', 'Could not save filesystem access');
    }
  }

  void workspaceBtn;
  void fullBtn;
}
