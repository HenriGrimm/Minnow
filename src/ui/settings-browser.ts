import '../styles/settings-general.css';

import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import {
  getBrowserMetaCached,
  loadBrowserMeta,
  saveBrowserMeta,
  type BrowserMeta,
} from '../config/browser-meta';
import {
  appendSettingsCrosslinks,
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import { createSettingsToggleRow } from './settings-switch';
import {
  appendSettingsOfflineHint,
  createSettingsRadioRow,
  createSettingsTextareaRow,
} from './settings-controls';
import { setStatus } from './status';
import { getFilePanelState, patchFilePanelState } from '../state/file-panel';
import { syncPreviewDevToolsDockToHost } from './preview-panel';

// ── Patterns ─────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Mount browser automation controls into #settingsBrowserBody. */
export async function renderBrowserSettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Control how agents use the built-in browser preview. Choose what they can do in ',
    linkToSettingsSection('Tools', 'tools'),
    '.',
  );
  shell.appendChild(lead);

  if (!isServerStorageMode()) {
    appendSettingsOfflineHint(
      shell,
      'Browser settings are saved on this device. Open Minnow to edit them.',
    );
    return;
  }

  const mode = await detectConfigServer();
  if (mode !== 'server') {
    appendSettingsOfflineHint(
      shell,
      'Open Minnow to edit browser settings.',
    );
    return;
  }

  const meta = await loadBrowserMeta();
  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const behaviorGroup = appendSettingsGroup(
    content,
    'Navigation & tabs',
    'browser_navigate only opens URLs matching your allowlist. Localhost dev hosts are included by default.',
    'integrations.browser',
    { emphasis: true },
  );

  const { row: allowNavRow, input: allowNavCb } = createSettingsToggleRow('Allow navigation', {
    id: 'settingsBrowserAllowNavigate',
    checked: meta.allowNavigate,
    searchKey: 'integrations.browser.allowNavigate',
  });
  behaviorGroup.appendChild(allowNavRow);
  if (window.minnow?.window?.openAgentBrowserViewer) {
    const { row, input } = createSettingsToggleRow('Use native browser for new agent tabs', {
      id: 'settingsBrowserNativeAgentTabs', checked: Boolean(meta.nativeAgentTabs),
      searchKey: 'integrations.browser.nativeAgentTabs',
    });
    behaviorGroup.appendChild(row);
    input.addEventListener('change', async () => {
      input.disabled = true;
      try { await saveBrowserMeta({ nativeAgentTabs: input.checked }); }
      catch { input.checked = !input.checked; setStatus('err', 'Could not save browser settings'); }
      finally { input.disabled = false; }
    });
  }

  const { row: restoreTabsRow, input: restoreTabsCb } = createSettingsToggleRow(
    'Restore browser tabs',
    {
      id: 'settingsBrowserRestoreTabs',
      checked: meta.restoreBrowserTabs,
      searchKey: 'integrations.browser.restoreTabs',
    },
  );
  behaviorGroup.appendChild(restoreTabsRow);

  const devToolsGroup = appendSettingsGroup(
    content,
    'DevTools dock',
    'Where Chromium DevTools opens in the preview browser (Electron desktop shell only).',
    'integrations.browser.devtoolsDock',
    { emphasis: true },
  );

  const { row: devToolsDockRow, inputs: devToolsDockInputs, setValue: setDevToolsDockValue } =
    createSettingsRadioRow('DevTools dock position', {
      name: 'minnow-preview-devtools-dock',
      searchKey: 'integrations.browser.devtoolsDock',
      options: [
        { value: 'bottom', label: 'Bottom' },
        { value: 'side', label: 'Side' },
        { value: 'popout', label: 'Pop out' },
      ],
    });
  const [dockBottom, dockSide, dockPopout] = devToolsDockInputs;
  dockBottom.id = 'settingsBrowserDevToolsDockBottom';
  dockSide.id = 'settingsBrowserDevToolsDockSide';
  dockPopout.id = 'settingsBrowserDevToolsDockPopout';
  setDevToolsDockValue(getFilePanelState().previewDevToolsDock);
  devToolsGroup.appendChild(devToolsDockRow);

  for (const input of devToolsDockInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const dock =
        input.value === 'side' ? 'side' : input.value === 'popout' ? 'popout' : 'bottom';
      patchFilePanelState({ previewDevToolsDock: dock });
      void syncPreviewDevToolsDockToHost();
    });
  }

  allowNavCb.addEventListener('change', () => {
    void (async () => {
      try {
        await saveBrowserMeta({ allowNavigate: allowNavCb.checked });
      } catch {
        setStatus('err', 'Could not save browser settings');
        allowNavCb.checked = !allowNavCb.checked;
      }
    })();
  });

  restoreTabsCb.addEventListener('change', () => {
    void (async () => {
      try {
        await saveBrowserMeta({ restoreBrowserTabs: restoreTabsCb.checked });
      } catch {
        setStatus('err', 'Could not save browser settings');
        restoreTabsCb.checked = !restoreTabsCb.checked;
      }
    })();
  });

  appendSettingsCrosslinks(content, [
    { label: 'Permissions', sectionId: 'access' },
    { label: 'Skills catalog', sectionId: 'skills' },
  ]);
}

/** Cached meta for settings consumers (after loadBrowserMeta). */
export function getBrowserSettingsMeta(): BrowserMeta {
  return getBrowserMetaCached();
}

/** @deprecated Use renderBrowserSettingsSection. */
export async function renderBrowserAllowlistSettings(
  mount: HTMLElement,
  initialMeta?: BrowserMeta,
): Promise<void> {
  void initialMeta;
  await renderBrowserSettingsSection(mount);
}
