import '../styles/settings-general.css';
import '../styles/settings-sampler.css';

import { isServerStorageMode } from '../config/storage-mode';
import { loadSamplerMeta, saveSamplerMeta } from '../config/sampler-meta';
import { detectLocalServer } from '../tools/client';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { appendSettingsOfflineHint } from './settings-controls';
import { buildSamplerFieldInputs } from './settings-sampler-fields';
import { setStatus } from './status';

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

/** Render Settings → Sampler section. */
export async function renderSamplerSettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Temperature, penalties, and token limits for main chat. Per-model overrides live in the Models app inspector (Inference tab); per-role overrides live under ',
    linkToSettingsSection('Routing', 'model-routing'),
    '. Changes apply as soon as you edit a field.',
  );
  shell.appendChild(lead);

  const serverUp = await detectLocalServer();
  if (!isServerStorageMode() || !serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Open Minnow to persist sampler defaults to <code>~/.minnow/config.json</code>. Values below use browser storage until then.',
      { searchKey: 'models.sampler' },
    );
  }

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const body = appendSettingsGroup(
    content,
    'Global defaults',
    'Baseline sampling for new chats and roles that inherit global settings.',
    'models.sampler',
    { emphasis: true },
  );

  const meta = await loadSamplerMeta();
  const globalFields = buildSamplerFieldInputs(meta, {
    includeMaxTokens: true,
    emptyPlaceholder: '',
    searchKeyPrefix: 'models.sampler',
  });

  body.appendChild(globalFields.root);

  let skipAutoSave = true;

  const persistGlobalSampler = async (): Promise<void> => {
    const patch = globalFields.readPatch();
    if (!patch) return;
    try {
      const next = await saveSamplerMeta(patch);
      globalFields.setValues(next);
    } catch {
      setStatus('err', 'Could not save sampler defaults');
    }
  };

  globalFields.root.addEventListener('change', () => {
    if (skipAutoSave) return;
    void persistGlobalSampler();
  });

  skipAutoSave = false;
}
