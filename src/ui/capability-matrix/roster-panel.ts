import { showToast } from '../toast';
import type { CapabilityMatrixRosterEntry } from '../../benchmark/capabilities/roster-store.ts';
import { groupRosterByHost } from '../../benchmark/capabilities/view-model.ts';
import { fillModelSelect, fillProviderSelect, fetchAllCatalogRosterTargets } from '../settings-model-binding.ts';
import { mountAuxiliaryModelSelectCombobox } from '../model-select-picker.ts';
import { LIBRARY_MODEL_PROVIDER_ID } from '../../models/model-select-library.ts';
import { targetKeyFromTarget } from '../../benchmark/model-key.ts';
import { createSettingsActionsRow, runSettingsAction } from '../settings-controls';
import { setStatus } from '../status';

export type CapabilityRosterPanelOptions = {
  host: HTMLElement;
  roster: CapabilityMatrixRosterEntry[];
  onRosterChange: (next: CapabilityMatrixRosterEntry[]) => void | Promise<void>;
};

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

/** Paint roster groups and add/remove controls. */
export function renderCapabilityRosterPanel(options: CapabilityRosterPanelOptions): void {
  const { host, roster, onRosterChange } = options;
  host.replaceChildren();
  host.className = 'cap-matrix-roster';
  host.dataset.settingsSearchKey = 'advanced.capabilityMatrix.roster';

  const groups = groupRosterByHost(roster);
  if (!groups.length) {
    host.appendChild(el('p', 'cap-matrix-roster__empty', 'No models yet. Add one below.'));
  } else {
    const bands = el('div', 'cap-matrix-roster__bands');
    for (const group of groups) {
      const band = el('div', 'cap-matrix-roster__band');
      band.appendChild(el('p', 'cap-matrix-roster__band-label', group.label));

      const list = el('ul', 'cap-matrix-roster__chips');
      for (const entry of group.entries) {
        const item = el('li', 'cap-matrix-roster__chip');
        const label = entry.label?.trim() || `${entry.providerId} / ${entry.modelId}`;
        const name = el('span', 'cap-matrix-roster__chip-label', label);
        const remove = el('button', 'cap-matrix-roster__chip-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${label}`);
        remove.addEventListener('click', () => {
          const key = targetKeyFromTarget(entry);
          const next = roster.filter((row) => targetKeyFromTarget(row) !== key);
          void onRosterChange(next);
        });
        item.append(name, remove);
        list.appendChild(item);
      }
      band.appendChild(list);
      bands.appendChild(band);
    }
    host.appendChild(bands);
  }

  const addRow = el('div', 'cap-matrix-roster__add');
  const providerSelect = el('select', 'settings-select cap-matrix-roster__provider');
  providerSelect.id = 'capMatrixRosterProvider';
  const modelSelect = el('select', 'settings-select cap-matrix-roster__model');
  modelSelect.id = 'capMatrixRosterModel';

  const providerWrap = el('label', 'settings-field-stack__label cap-matrix-roster__field');
  providerWrap.append('Provider', providerSelect);
  const modelWrap = el('label', 'settings-field-stack__label cap-matrix-roster__field');
  modelWrap.append('Model', modelSelect);
  addRow.append(providerWrap, modelWrap);

  void fillProviderSelect(providerSelect, '', {
    includeEmptyOption: false,
    includeLibraryProvider: true,
  }).then(() => {
    const providerId = providerSelect.value;
    if (providerId) {
      void fillModelSelect(modelSelect, providerId, '', { includeEmptyOption: false }).then(() => {
        mountAuxiliaryModelSelectCombobox(modelSelect);
      });
    } else {
      mountAuxiliaryModelSelectCombobox(modelSelect);
    }
  });

  providerSelect.addEventListener('change', () => {
    void fillModelSelect(modelSelect, providerSelect.value, '', {
      includeEmptyOption: false,
    }).then(() => {
      mountAuxiliaryModelSelectCombobox(modelSelect);
    });
  });

  const actions = createSettingsActionsRow(
    [
      {
        label: 'Add model',
        variant: 'primary',
        onClick: () => {
          const providerId = providerSelect.value.trim();
          const modelId = modelSelect.value.trim();
          if (!providerId || !modelId) return;
          const key = targetKeyFromTarget({ providerId, modelId });
          if (roster.some((row) => targetKeyFromTarget(row) === key)) return;
          const next: CapabilityMatrixRosterEntry[] = [
            ...roster,
            { providerId, modelId, enabled: true },
          ];
          void onRosterChange(next);
        },
      },
      {
        label: 'Add all catalog',
        variant: 'default',
        onClick: () => {
          const button = actions.querySelectorAll<HTMLButtonElement>('button')[1];
          void runSettingsAction(button, 'Loading catalogs…', async () => {
            try {
              const catalog = await fetchAllCatalogRosterTargets();
              const existing = new Set(roster.map((row) => targetKeyFromTarget(row)));
              const additions: CapabilityMatrixRosterEntry[] = [];
              for (const entry of catalog) {
                const row: CapabilityMatrixRosterEntry = {
                  providerId: entry.providerId,
                  modelId: entry.modelId,
                  enabled: true,
                };
                const key = targetKeyFromTarget(row);
                if (existing.has(key)) continue;
                existing.add(key);
                additions.push(row);
              }
              if (!additions.length) {
                showToast('Roster already includes all catalog models');
                return;
              }
              await onRosterChange([...roster, ...additions]);
              const libraryCount = additions.filter(
                (row) => row.providerId === LIBRARY_MODEL_PROVIDER_ID,
              ).length;
              const suffix =
                libraryCount > 0 ? ` (${libraryCount} My Models)` : '';
              setStatus('ok', `Added ${additions.length} model(s) to roster${suffix}`);
            } catch (err) {
              setStatus('err', err instanceof Error ? err.message : 'Bulk add failed');
            }
          });
        },
      },
    ],
    { searchKey: 'advanced.capabilityMatrix.roster.add' },
  );
  actions.classList.add('cap-matrix-roster__actions');

  host.append(addRow, actions);
}

/** Short score chips for column headers (from view-model). */
export function formatColumnScore(score: number | null): string {
  if (score == null) return '—';
  return `${Math.round(score * 100)}%`;
}
