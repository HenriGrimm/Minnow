import { detectConfigServer } from '../config/storage-mode';
import {
  loadToolSecurityMeta,
  saveToolSecurityMeta,
  type ShellSandboxMode,
} from '../config/tool-security-meta';
import { fetchSandboxStatus } from '../tools/shell-sandbox-client';
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

function createSegmentButton(
  label: string,
  mode: ShellSandboxMode,
  group: HTMLElement,
  onSelect: (mode: ShellSandboxMode) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-network-segment settings-filesystem-segment';
  btn.dataset.shellSandbox = mode;
  btn.textContent = label;
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => onSelect(mode));
  group.appendChild(btn);
  return btn;
}

function setActiveSegment(group: HTMLElement, mode: ShellSandboxMode): void {
  for (const btn of group.querySelectorAll<HTMLButtonElement>('[data-shell-sandbox]')) {
    const active = btn.dataset.shellSandbox === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

/** Render agent shell sandbox controls into the General settings mount. */
export async function renderShellSandboxSettings(mount: HTMLElement): Promise<void> {
  const serverUp = await detectConfigServer();
  if (serverUp !== 'server') {
    appendSettingsOfflineHint(
      mount,
      'Agent shell sandbox settings are saved on this device. Open Minnow, then reopen Settings.',
    );
    return;
  }

  const status = await fetchSandboxStatus(true);
  const requireSupported = status?.requireSupported !== false;

  const meta = await loadToolSecurityMeta();
  let selectedMode: ShellSandboxMode = meta.shellSandbox;
  if (!requireSupported && selectedMode === 'require') {
    selectedMode = 'prefer';
  }

  const section = el('section', 'settings-filesystem');
  section.dataset.settingsSearchKey = 'general.shellSandbox';

  const intro = el(
    'p',
    'settings-field-hint settings-filesystem-hint',
    'Applies to all chats, including orchestrate boards. macOS uses Seatbelt; Linux uses Landlock; Windows uses WSL2 + Landlock inside your distro (not native cmd/PowerShell). On Windows, install node, python3, and git inside WSL — host-only toolchains are not used for sandboxed agent shells.',
  );
  section.appendChild(intro);

  if (!requireSupported) {
    const winNote = el(
      'p',
      'settings-field-hint settings-filesystem-hint',
      'Require is not available on Windows (sandboxed commands run in WSL). Use Prefer or Off; Prefer asks before running unsandboxed when the sandbox cannot apply.',
    );
    section.appendChild(winNote);
  }

  const segmentGroup = el('div', 'settings-network-segments settings-filesystem-segments');
  segmentGroup.setAttribute('role', 'group');
  segmentGroup.setAttribute('aria-label', 'Agent shell sandbox');

  createSegmentButton('Off', 'off', segmentGroup, (mode) => {
    void applyMode(mode);
  }).id = 'shellSandboxOffSettings';
  createSegmentButton('Prefer', 'prefer', segmentGroup, (mode) => {
    void applyMode(mode);
  }).id = 'shellSandboxPreferSettings';
  if (requireSupported) {
    createSegmentButton('Require', 'require', segmentGroup, (mode) => {
      void applyMode(mode);
    }).id = 'shellSandboxRequireSettings';
  }

  setActiveSegment(segmentGroup, selectedMode);
  section.appendChild(segmentGroup);

  const hintOff = el(
    'p',
    'settings-field-hint settings-filesystem-hint',
    'Agent one-shot shells run with the same filesystem authority as Minnow (today’s default).',
  );
  const hintPrefer = el(
    'p',
    'settings-field-hint settings-filesystem-hint',
    'Sandbox when the OS backend is available (macOS Seatbelt; Linux Landlock helper; Windows requires WSL2 + Landlock). If unavailable, Ask before running unsandboxed.',
  );
  const hintRequire = el(
    'p',
    'settings-field-hint settings-filesystem-hint',
    'Fail closed when the sandbox cannot apply — no silent unsandboxed fallback.',
  );

  function refreshHints(mode: ShellSandboxMode): void {
    hintOff.hidden = mode !== 'off';
    hintPrefer.hidden = mode !== 'prefer';
    hintRequire.hidden = mode !== 'require';
  }
  refreshHints(selectedMode);
  section.appendChild(hintOff);
  section.appendChild(hintPrefer);
  if (requireSupported) {
    section.appendChild(hintRequire);
  }

  mount.appendChild(section);

  async function applyMode(mode: ShellSandboxMode): Promise<void> {
    if (!requireSupported && mode === 'require') {
      return;
    }
    if (mode === selectedMode) return;
    const prev = selectedMode;
    selectedMode = mode;
    setActiveSegment(segmentGroup, mode);
    refreshHints(mode);
    try {
      await saveToolSecurityMeta({ shellSandbox: mode });
    } catch {
      selectedMode = prev;
      setActiveSegment(segmentGroup, prev);
      refreshHints(prev);
      setStatus('err', 'Could not save agent shell sandbox');
    }
  }
}
