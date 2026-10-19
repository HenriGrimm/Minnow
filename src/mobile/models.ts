/**
 * Model choice as a phone sheet. Reads the same catalog the desktop picker
 * renders (`#modelSelect`), and applies a pick the way the composer chip does.
 */

import { getActiveChat } from '../state/sessions';
import { resolveEffectiveChatModelBinding } from '../models/selection';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { el, icon } from './dom';
import { openSheet } from './sheet';

interface ModelOption {
  value: string;
  label: string;
  group: string;
}

function readCatalog(): ModelOption[] {
  const select = document.getElementById('modelSelect') as HTMLSelectElement | null;
  if (!select) return [];
  const out: ModelOption[] = [];
  for (const option of select.options) {
    if (!option.value || option.disabled) continue;
    const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '';
    let label = option.textContent?.trim() || option.value;
    // The desktop picker suffixes the provider; the sheet already groups by it.
    if (group && label.endsWith(` — ${group}`)) label = label.slice(0, -(group.length + 3));
    out.push({ value: option.value, label, group });
  }
  return out;
}

function isCurrent(value: string, modelId: string, providerId: string | undefined): boolean {
  const decoded = decodeModelSelectKey(value);
  if (decoded) return decoded.modelId === modelId && (!providerId || decoded.providerId === providerId);
  return value === modelId;
}

/** Open the model sheet for the active chat. */
export async function openModelSheet(): Promise<void> {
  const chat = getActiveChat();
  const binding = resolveEffectiveChatModelBinding(chat);
  const currentId = chat.modelId?.trim() || binding.modelId || '';
  const currentProvider = chat.providerId?.trim() || binding.providerId;
  let query = '';

  const input = el('input', {
    className: 'm-field',
    attrs: { type: 'search', placeholder: 'Search models', 'aria-label': 'Search models', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' },
  });
  const list = el('div', { className: 'm-pick', attrs: { role: 'listbox', 'aria-label': 'Models' } });
  const more = el(
    'button',
    { className: 'm-pick__row', attrs: { type: 'button' } },
    el('span', { className: 'm-pick__icon' }, icon('fi-rr-settings-sliders', 18)),
    el('span', { className: 'm-pick__text' },
      el('span', { className: 'm-pick__label', text: 'Reasoning and pools' }),
      el('span', { className: 'm-pick__desc', text: 'The full model menu.' }),
    ),
  );
  const sheet = openSheet(
    [el('div', { className: 'm-prompt' }, input), list, more],
    { title: 'Model', tall: true },
  );
  more.addEventListener('click', async () => {
    sheet.close();
    const { openActiveChatModelSelect } = await import('../ui/composer-model-trigger');
    window.setTimeout(() => openActiveChatModelSelect(), 240);
  });

  const render = () => {
    const options = readCatalog().filter((option) =>
      !query || `${option.label} ${option.group}`.toLowerCase().includes(query),
    );
    const nodes: HTMLElement[] = [];
    let lastGroup: string | null = null;
    for (const option of options) {
      if (option.group !== lastGroup) {
        lastGroup = option.group;
        if (option.group) nodes.push(el('h3', { className: 'm-section-label', text: option.group }));
      }
      const selected = isCurrent(option.value, currentId, currentProvider);
      nodes.push(
        el(
          'button',
          {
            className: 'm-pick__row',
            attrs: { type: 'button', role: 'option', 'aria-selected': String(selected), 'aria-checked': selected ? 'true' : null },
            on: {
              click: async () => {
                sheet.close();
                const { onActiveChatModelChange } = await import('../ui/chat-model-ui');
                onActiveChatModelChange(option.value);
              },
            },
          },
          el('span', { className: 'm-pick__icon' }, icon('fi-rr-microchip', 16)),
          el('span', { className: 'm-pick__text' }, el('span', { className: 'm-pick__label', text: option.label })),
          selected ? el('span', { className: 'm-pick__check' }, icon('fi-rr-check', 16)) : null,
        ),
      );
    }
    if (!nodes.length) {
      nodes.push(el('p', { className: 'm-muted m-pick__empty', text: query ? 'No matching models.' : 'No models available. Add a provider on your computer.' }));
    }
    list.replaceChildren(...nodes);
  };
  input.addEventListener('input', () => {
    query = input.value.trim().toLowerCase();
    render();
  });
  if (readCatalog().length) {
    render();
    return;
  }
  // Open at once and fill in when the catalog arrives.
  list.replaceChildren(el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }));
  const { fetchModels } = await import('../api/models');
  await fetchModels().catch(() => undefined);
  if (sheet.el.isConnected) render();
}
