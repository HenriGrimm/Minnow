
import '../styles/settings-general.css';
import '../styles/settings-thinking.css';

import { isServerStorageMode } from '../config/storage-mode';
import { loadThinkingMeta, saveThinkingMeta } from '../config/thinking-meta';
import { detectLocalServer } from '../tools/client';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { appendSettingsOfflineHint, createSettingsRadioRow } from './settings-controls';
import { buildThinkingBudgetFieldInputs } from './settings-thinking-budget-fields';
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

/** Render Settings → Thinking section. */
export async function renderThinkingSettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Whether models show extended reasoning by default. Per-role overrides live under ',
    linkToSettingsSection('Routing', 'model-routing'),
    '; toggle per message in the composer. Changes apply immediately.',
  );
  shell.appendChild(lead);

  const serverUp = await detectLocalServer();
  if (!isServerStorageMode() || !serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Open Minnow to persist thinking defaults to <code>~/.minnow/config.json</code>. Values below use browser storage until then.',
      { searchKey: 'models.thinking' },
    );
  }

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const body = appendSettingsGroup(
    content,
    'Global default',
    'Applies to new chats and roles that inherit global settings.',
    'models.thinking',
    { emphasis: true },
  );

  const budgetFields = buildThinkingBudgetFieldInputs(null, {
    layout: 'row',
    label: 'Thinking budget',
    description:
      'Optional cap on reasoning tokens (approximate: characters ÷ 4). Leave empty for no global cap; 0 turns the cap off.',
    searchKey: 'models.thinking.budget',
  });

  let skipAutoSave = true;

  const persistThinking = async (): Promise<void> => {
    try {
      const mode = getValue() === 'off' ? 'off' : 'on';
      const budgetRead = budgetFields.readValue();
      await saveThinkingMeta({
        defaultMode: mode,
        thinkingBudgetTokens: budgetRead === undefined ? null : budgetRead,
      });
    } catch {
      setStatus('err', 'Could not save thinking default');
    }
  };

  const syncBudgetField = (mode: string): void => {
    budgetFields.setDisabled(mode === 'off');
  };

  const { row, getValue, setValue } = createSettingsRadioRow('Default thinking', {
    name: 'thinkingGlobal',
    searchKey: 'models.thinking.mode',
    description: 'When on, models that support reasoning expose chain-of-thought when the provider allows it.',
    options: [
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
    onChange: (mode) => {
      syncBudgetField(mode);
      if (!skipAutoSave) void persistThinking();
    },
  });
  body.appendChild(row);
  body.appendChild(budgetFields.root);

  const meta = await loadThinkingMeta();
  const initialMode = meta.defaultMode === 'off' ? 'off' : 'on';
  setValue(initialMode);
  syncBudgetField(initialMode);
  budgetFields.setValue(meta.thinkingBudgetTokens);

  const budgetInput = budgetFields.root.querySelector('input');
  budgetInput?.addEventListener('change', () => {
    if (!skipAutoSave) void persistThinking();
  });

  skipAutoSave = false;
}
