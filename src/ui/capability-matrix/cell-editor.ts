import { upsertManualVerdict } from '../../benchmark/capabilities/manual-verdicts.ts';
import type { CapabilityVerdict } from '../../benchmark/capabilities/types.ts';
import { getCapabilityById } from '../../benchmark/capabilities/catalog.ts';
import type { MergedCapabilityCell } from '../../benchmark/capabilities/merge.ts';
import { createSettingsSelectRow, createSettingsTextareaRow } from '../settings-controls';
import { setStatus } from '../status';

export type CapabilityCellEditorDispose = () => void;

export type CapabilityCellEditorOptions = {
  host: HTMLElement;
  targetLabel: string;
  onSaved: () => void | Promise<void>;
  /** When true, the editor sits inside the transcript drawer: drop duplicate title / close / transcript actions and do not steal focus. */
  embedded?: boolean;
  /** Disable save while an auto probe is still running. */
  saveDisabled?: boolean;
};

const VERDICT_OPTIONS: { value: CapabilityVerdict; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'partial', label: 'Partial' },
  { value: 'fail', label: 'Fail' },
  { value: 'n-a', label: 'N/A' },
  { value: 'untested', label: 'Untested (clear manual)' },
];

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

/** Mount inline editor for one matrix cell; returns dispose. */
export function mountCapabilityCellEditor(
  cell: MergedCapabilityCell,
  options: CapabilityCellEditorOptions,
): CapabilityCellEditorDispose {
  const { host, targetLabel, onSaved, embedded, saveDisabled } = options;
  host.replaceChildren();
  host.hidden = false;
  host.classList.add('cap-matrix-cell-editor');
  if (embedded) host.classList.add('cap-matrix-cell-editor--embedded');
  else host.classList.remove('cap-matrix-cell-editor--embedded');
  host.dataset.settingsSearchKey = 'advanced.capabilityMatrix.cell';

  const def = getCapabilityById(cell.capabilityId);
  if (!embedded) {
    const title = el(
      'h4',
      'cap-matrix-cell-editor__title',
      def?.header ?? cell.capabilityId,
    );
    host.appendChild(title);
  } else {
    const heading = el('h3', 'cap-matrix-cell-editor__heading', 'Manual verdict');
    host.appendChild(heading);
  }

  const meta = el('p', 'cap-matrix-cell-editor__meta');
  meta.textContent = `${targetLabel} · ${def?.scoreMode === 'manual' ? 'Manual row' : 'Auto row (manual override)'}`;
  host.appendChild(meta);

  if (cell.source === 'auto' || cell.autoVerdict) {
    const autoLine = el('p', 'cap-matrix-cell-editor__auto');
    autoLine.textContent = cell.autoVerdict
      ? `Latest auto: ${cell.autoVerdict}${cell.overridesAuto ? ' (overridden by manual)' : ''}`
      : '';
    if (autoLine.textContent) host.appendChild(autoLine);
  }

  let verdict: CapabilityVerdict = cell.manualVerdict ?? cell.verdict ?? 'untested';
  let note = '';

  const { row: verdictRow, select: verdictSelect } = createSettingsSelectRow('Verdict', {
    options: VERDICT_OPTIONS,
    value: verdict,
    searchKey: 'advanced.capabilityMatrix.cell.verdict',
    onChange: (value) => {
      verdict = value as CapabilityVerdict;
    },
  });
  host.appendChild(verdictRow);

  const { row: noteRow } = createSettingsTextareaRow('Note', {
    value: note,
    rows: embedded ? 2 : undefined,
    searchKey: 'advanced.capabilityMatrix.cell.note',
    onChange: (value) => {
      note = value;
    },
  });
  host.appendChild(noteRow);

  const actions = el('div', 'cap-matrix-cell-editor__actions');
  const saveBtn = el('button', 'settings-action-btn settings-action-btn--primary', 'Save manual verdict');
  saveBtn.type = 'button';
  if (saveDisabled) {
    saveBtn.disabled = true;
    saveBtn.title = 'Wait for the probe to finish before saving a manual verdict.';
  }
  actions.appendChild(saveBtn);

  if (!embedded) {
    const clearBtn = el('button', 'settings-action-btn', 'Close');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      host.hidden = true;
      host.replaceChildren();
    });
    actions.appendChild(clearBtn);
  }

  saveBtn.addEventListener('click', () => {
    void (async () => {
      try {
        saveBtn.disabled = true;
        saveBtn.setAttribute('aria-busy', 'true');
        saveBtn.textContent = 'Saving verdict…';
        await upsertManualVerdict({
          targetKey: cell.targetKey,
          capabilityId: cell.capabilityId,
          verdict,
          note: note.trim() || undefined,
          updatedAt: new Date().toISOString(),
        });
        setStatus('ok', 'Manual verdict saved');
        await onSaved();
      } catch (err) {
        setStatus('err', err instanceof Error ? err.message : 'Save failed');
      } finally {
        saveBtn.disabled = false;
        saveBtn.removeAttribute('aria-busy');
        saveBtn.textContent = 'Save manual verdict';
      }
    })();
  });

  host.appendChild(actions);

  if (!embedded) {
    verdictSelect.focus();
  }

  return () => {
    host.replaceChildren();
    host.hidden = true;
  };
}
