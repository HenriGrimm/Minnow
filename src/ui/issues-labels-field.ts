/**
 * Inline labels editor for list rows and the issue peek.
 *
 * List rows stay one line: three chips, a caret overflow popover, and a + add
 * control. The dashed placeholder no longer lives in the row. Peek wraps.
 */

import {
  normalizeIssueLabelsList,
  splitIssueLabelsForList,
} from '../issues/label-catalog';
import { collectIssueLabelSuggestions, isIssuesStoreLoaded, normalizeIssueLabel } from '../state/issues-store';
import {
  applyIssueLabelSwatch,
  closeIssueLabelPopovers,
  createIssueLabelChip,
  createIssueLabelMoreButton,
  isIssuesLabelPopoverFocused,
  mountIssueLabelFlyout,
  openIssueLabelOverflow,
  positionIssueLabelPopover,
} from './issues-label-chip';

export type IssuesLabelsFieldOptions = {
  issueId: string;
  /** Unsaved forms resolve their current destination when the flyout opens. */
  workspacePath?: string | (() => string);
  labels: string[];
  /** Legacy severity chip shown read-only beside labels. */
  severity?: string;
  variant: 'detail' | 'row' | 'form';
  onChange: (labels: string[]) => void;
  /** Focus left the field and every labels popover (add flyout mounts on body). */
  onBlur?: () => void;
};

// ── Focus ────────────────────────────────────────────────────────────────────

/** True when focus is inside a labels field or its flyouts. */
export function isIssuesLabelsFieldFocused(): boolean {
  const active = document.activeElement;
  if (!active || typeof (active as { closest?: unknown }).closest !== 'function') return false;
  if (isIssuesLabelPopoverFocused()) return true;
  return Boolean((active as { closest: (s: string) => Element | null }).closest('.issues-labels-field'));
}

/** Filter workspace label suggestions for the inline editor menu. */
export function filterIssueLabelSuggestions(
  allSuggestions: readonly string[],
  currentLabels: readonly string[],
  query: string,
): string[] {
  const applied = new Set(currentLabels.map((label) => label.toLowerCase()));
  const needle = query.trim().toLowerCase();
  const out: string[] = [];
  for (const suggestion of allSuggestions) {
    if (applied.has(suggestion.toLowerCase())) continue;
    if (needle && !suggestion.toLowerCase().includes(needle)) continue;
    out.push(suggestion);
  }
  return out;
}

export { closeIssueLabelPopovers as closeIssuesLabelsSuggestionsMenu };
export { normalizeIssueLabelsList };

// ── Field ────────────────────────────────────────────────────────────────────

/** Build an interactive labels field for list rows or the detail sticky header. */
export function createIssuesLabelsField(options: IssuesLabelsFieldOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = `issues-labels-field issues-labels-field--${options.variant}`;
  if (options.variant === 'detail') {
    root.classList.add('issues-detail__labels');
  } else if (options.variant === 'row') {
    root.classList.add('issues-row__labels');
  }
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Labels');

  let currentLabels = normalizeIssueLabelsList(options.labels);

  const chipsHost = document.createElement('div');
  chipsHost.className = 'issues-labels-field__chips';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'issues-label issues-labels-field__add';
  if (options.variant === 'form') {
    addButton.textContent = 'Add label';
    addButton.classList.add('issues-labels-field__add--text');
  } else {
    addButton.textContent = '+';
  }
  addButton.setAttribute('aria-label', 'Add label');
  addButton.setAttribute('aria-haspopup', 'listbox');
  addButton.setAttribute('aria-expanded', 'false');

  let moreButton: HTMLButtonElement | null = null;
  let severityChip: HTMLElement | null = null;

  const popover = document.createElement('div');
  popover.className = 'issues-labels-popover issues-labels-add-popover';
  popover.hidden = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'issues-labels-field__input';
  input.placeholder = 'Add label';
  input.setAttribute('aria-label', 'Add label');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  const suggestionsListId = `issues-labels-suggestions-${options.issueId}`;
  input.setAttribute('aria-controls', suggestionsListId);

  const suggestionsMenu = document.createElement('ul');
  suggestionsMenu.className = 'issues-labels-suggestions';
  suggestionsMenu.id = suggestionsListId;
  suggestionsMenu.setAttribute('role', 'listbox');

  popover.append(input, suggestionsMenu);

  let visibleSuggestions: string[] = [];
  let activeSuggestionIndex = -1;
  let createName: string | null = null;
  let addOpen = false;

  const commit = (labels: string[]): void => {
    currentLabels = normalizeIssueLabelsList(labels);
    paint();
    options.onChange(currentLabels);
  };

  const removeLabel = (label: string): void => {
    const key = label.toLowerCase();
    commit(currentLabels.filter((entry) => entry.toLowerCase() !== key));
  };

  const closeAddPopover = (): void => {
    if (!addOpen) return;
    addOpen = false;
    input.value = '';
    visibleSuggestions = [];
    activeSuggestionIndex = -1;
    createName = null;
    addButton.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-expanded', 'false');
    closeIssueLabelPopovers();
  };

  // After a successful (or duplicate) add, keep the typeahead up so the next
  // name can be typed immediately. Click-away and Escape still dismiss it.
  const keepAddPopoverReady = (): void => {
    input.value = '';
    refreshSuggestions();
    if (!addOpen) return;
    positionIssueLabelPopover(addButton, popover);
    input.focus();
  };

  const addLabel = (raw: string): void => {
    const label = normalizeIssueLabel(raw);
    if (!label) return;
    const key = label.toLowerCase();
    if (currentLabels.some((entry) => entry.toLowerCase() === key)) {
      keepAddPopoverReady();
      return;
    }
    commit([...currentLabels, label]);
    keepAddPopoverReady();
  };

  const chooseSuggestion = (label: string): void => {
    addLabel(label);
  };

  const paintSuggestionsMenu = (): void => {
    suggestionsMenu.replaceChildren();
    visibleSuggestions.forEach((label, index) => {
      const item = document.createElement('li');
      item.className = 'issues-labels-suggestions__item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === activeSuggestionIndex));
      item.classList.toggle('is-active', index === activeSuggestionIndex);
      const swatch = document.createElement('span');
      swatch.className = 'issues-labels-suggestions__swatch';
      applyIssueLabelSwatch(swatch, label);
      const text = document.createElement('span');
      text.textContent = label;
      item.append(swatch, text);
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        chooseSuggestion(label);
      });
      suggestionsMenu.appendChild(item);
    });

    if (createName) {
      const createIndex = visibleSuggestions.length;
      const item = document.createElement('li');
      item.className = 'issues-labels-suggestions__item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(createIndex === activeSuggestionIndex));
      item.classList.toggle('is-active', createIndex === activeSuggestionIndex);
      item.textContent = `Create "${createName}"`;
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        chooseSuggestion(createName as string);
      });
      suggestionsMenu.appendChild(item);
    }

    const optionCount = visibleSuggestions.length + (createName ? 1 : 0);
    input.setAttribute('aria-expanded', String(optionCount > 0));
  };

  const refreshSuggestions = (): void => {
    const workspacePath = typeof options.workspacePath === 'function'
      ? options.workspacePath() : options.workspacePath;
    const suggestions = isIssuesStoreLoaded()
      ? collectIssueLabelSuggestions(options.issueId, workspacePath) : [];
    visibleSuggestions = filterIssueLabelSuggestions(suggestions, currentLabels, input.value);
    const typed = normalizeIssueLabel(input.value);
    const typedKey = typed?.toLowerCase() ?? '';
    const alreadyOnIssue = typedKey
      ? currentLabels.some((entry) => entry.toLowerCase() === typedKey)
      : false;
    const alreadySuggested = typedKey
      ? visibleSuggestions.some((entry) => entry.toLowerCase() === typedKey)
      : false;
    createName = typed && !alreadyOnIssue && !alreadySuggested ? typed : null;
    const optionCount = visibleSuggestions.length + (createName ? 1 : 0);
    activeSuggestionIndex = optionCount > 0 ? 0 : -1;
    paintSuggestionsMenu();
  };

  const optionAt = (index: number): string | null => {
    if (index < 0) return null;
    if (index < visibleSuggestions.length) return visibleSuggestions[index];
    if (createName && index === visibleSuggestions.length) return createName;
    return null;
  };

  const optionCount = (): number => visibleSuggestions.length + (createName ? 1 : 0);

  const openAddPopover = (): void => {
    if (addOpen) {
      input.focus();
      return;
    }
    addOpen = true;
    addButton.setAttribute('aria-expanded', 'true');
    popover.hidden = false;
    mountIssueLabelFlyout(addButton, popover, () => {
      addOpen = false;
      addButton.setAttribute('aria-expanded', 'false');
      input.value = '';
    });
    refreshSuggestions();
    input.focus();
  };

  const paint = (): void => {
    chipsHost.replaceChildren();
    const collapsed = options.variant === 'row';
    const { visible, hidden, hiddenCount } = collapsed
      ? splitIssueLabelsForList(currentLabels)
      : { visible: currentLabels, hidden: [], hiddenCount: 0 };

    for (const label of visible) {
      chipsHost.appendChild(
        createIssueLabelChip({
          name: label,
          removable: true,
          onRemove: () => removeLabel(label),
        }),
      );
    }

    moreButton?.remove();
    moreButton = null;
    if (hiddenCount > 0) {
      moreButton = createIssueLabelMoreButton(hiddenCount, hidden, (button) => {
        openIssueLabelOverflow(button, hidden, {
          removable: true,
          onRemove: removeLabel,
        });
      });
      root.insertBefore(moreButton, addButton);
    }

    severityChip?.remove();
    severityChip = null;
    if (options.severity) {
      severityChip = document.createElement('span');
      severityChip.className = 'issues-label issues-label--readonly';
      severityChip.textContent = options.severity;
      root.insertBefore(severityChip, addButton);
    }
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    // Escape must close even when the suggestion list is empty (all names already applied).
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAddPopover();
      addButton.focus();
      return;
    }
    const count = optionCount();
    if (count > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex + 1) % count;
        paintSuggestionsMenu();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeSuggestionIndex = activeSuggestionIndex <= 0 ? count - 1 : activeSuggestionIndex - 1;
        paintSuggestionsMenu();
        return;
      }
      if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
        const chosen = optionAt(activeSuggestionIndex);
        if (chosen) {
          event.preventDefault();
          chooseSuggestion(chosen);
          return;
        }
      }
    }
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addLabel(input.value);
      return;
    }
    if (event.key === 'Backspace' && input.value === '' && currentLabels.length > 0) {
      removeLabel(currentLabels[currentLabels.length - 1]);
    }
  });

  input.addEventListener('input', () => {
    refreshSuggestions();
  });

  addButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (addOpen) closeAddPopover();
    else openAddPopover();
  });

  for (const eventName of ['click', 'mousedown'] as const) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }

  root.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target?.closest('.issues-label-chip, .issues-labels-field__more, .issues-labels-field__add')) {
      return;
    }
    openAddPopover();
  });

  // The add flyout mounts on document.body, so "left the field" must also
  // exclude focus inside that popover before firing onBlur. relatedTarget is
  // required: activeElement is already body during focusout.
  root.addEventListener('focusout', (event) => {
    const related = event.relatedTarget as Node | null;
    if (related && root.contains(related)) return;
    if (isIssuesLabelPopoverFocused(event.relatedTarget)) return;
    options.onBlur?.();
  });

  root.append(chipsHost, addButton);
  paint();
  return root;
}
