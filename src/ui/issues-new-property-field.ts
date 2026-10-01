/**
 * Type and priority pickers for the new-issue form — icon chips with context menus.
 */

import { sortedPriorities, sortedTypes } from '../issues/taxonomy';
import {
  createIssuePriorityChip,
  createIssueTypeChip,
  resolveIssueTypeIcon,
  resolveIssuePriorityIcon,
} from '../issues/type-icons';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import type { IssuePriority, IssueType } from '../types';
import { createIcon } from './icon';
import { openIssuesContextMenu } from './issues-context-menu';

const TYPE_FIELD_ID = 'issuesNewType';
const PRIORITY_FIELD_ID = 'issuesNewPriority';
const TYPE_HOST_ID = 'issuesNewTypeHost';
const PRIORITY_HOST_ID = 'issuesNewPriorityHost';

/** Insert icon pickers into an existing or new new-issue form. */
export function ensureNewIssuePropertyFields(form: HTMLElement): void {
  ensureField(form, TYPE_FIELD_ID, TYPE_HOST_ID, 'task');
  ensureField(form, PRIORITY_FIELD_ID, PRIORITY_HOST_ID, 'none');
}

function ensureField(
  form: HTMLElement,
  fieldId: string,
  hostId: string,
  fallback: string,
): void {
  if (document.getElementById(hostId)) return;

  const label = form.querySelector(`label:has(#${fieldId}), label:has(select#${fieldId})`);
  if (!label) return;

  label.classList.add('issues-new-form__prop');

  const existing = document.getElementById(fieldId);
  let value = fallback;
  if (existing instanceof HTMLSelectElement || existing instanceof HTMLInputElement) {
    value = existing.value.trim() || fallback;
    existing.remove();
  }

  const input = document.createElement('input');
  input.type = 'hidden';
  input.id = fieldId;
  input.value = value;

  const host = document.createElement('div');
  host.id = hostId;
  host.className = 'issues-new-form__prop-host';

  label.append(input, host);
}

function readFieldValue(fieldId: string, fallback: string): string {
  const node = document.getElementById(fieldId);
  if (node instanceof HTMLInputElement) return node.value.trim() || fallback;
  if (node instanceof HTMLSelectElement) return node.value.trim() || fallback;
  return fallback;
}

function writeFieldValue(fieldId: string, value: string): void {
  const node = document.getElementById(fieldId);
  if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) {
    node.value = value;
  }
}

function bindPropertyChip(
  chip: HTMLElement,
  ariaLabel: string,
  open: (anchor: HTMLElement) => void,
): void {
  chip.classList.add('issues-new-form__prop-btn');
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-label', ariaLabel);
  chip.appendChild(
    createIcon('chevronDown', { size: 10, className: 'issues-new-form__prop-chevron' }),
  );

  const show = (): void => open(chip);
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    show();
  });
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    show();
  });
}

function paintTypeField(host: HTMLElement, value: IssueType): void {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.types.find((entry) => entry.id === value);
  const label = item?.label ?? value;
  const chip = createIssueTypeChip(value, item, { labeled: true });
  bindPropertyChip(chip, `Type: ${label}`, (anchor) => {
    openIssuesContextMenu({
      anchor,
      restoreFocus: anchor,
      label: 'Type',
      items: sortedTypes(taxonomy).map((entry) => ({
        id: entry.id,
        label: entry.label,
        iconClass: resolveIssueTypeIcon(entry.id, entry),
        onSelect: () => {
          writeFieldValue(TYPE_FIELD_ID, entry.id);
          syncNewIssuePropertyFields();
        },
      })),
    });
  });
  host.replaceChildren(chip);
}

function paintPriorityField(host: HTMLElement, value: IssuePriority): void {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.priorities.find((entry) => entry.id === value);
  const label = item?.label ?? (value === 'none' ? 'None' : value);
  const chip = createIssuePriorityChip(value, item);
  bindPropertyChip(chip, `Priority: ${label}`, (anchor) => {
    openIssuesContextMenu({
      anchor,
      restoreFocus: anchor,
      label: 'Priority',
      items: sortedPriorities(taxonomy).map((entry) => ({
        id: entry.id,
        label: entry.label,
        iconClass: resolveIssuePriorityIcon(entry.id, entry),
        onSelect: () => {
          writeFieldValue(PRIORITY_FIELD_ID, entry.id);
          syncNewIssuePropertyFields();
        },
      })),
    });
  });
  host.replaceChildren(chip);
}

/** Repaint type and priority chips from hidden field values and taxonomy. */
export function syncNewIssuePropertyFields(): void {
  const form = document.getElementById('issuesNewForm');
  if (!form) return;
  ensureNewIssuePropertyFields(form);

  const typeHost = document.getElementById(TYPE_HOST_ID);
  const priorityHost = document.getElementById(PRIORITY_HOST_ID);
  if (!(typeHost instanceof HTMLElement) || !(priorityHost instanceof HTMLElement)) return;

  const taxonomy = getIssuesTaxonomySync();
  const typeValue = readFieldValue(TYPE_FIELD_ID, 'task');
  const priorityValue = readFieldValue(PRIORITY_FIELD_ID, 'none');

  const typeIds = sortedTypes(taxonomy).map((entry) => entry.id);
  const priorityIds = sortedPriorities(taxonomy).map((entry) => entry.id);
  const nextType = typeIds.includes(typeValue) ? typeValue : 'task';
  const nextPriority = priorityIds.includes(priorityValue) ? priorityValue : 'none';

  if (nextType !== typeValue) writeFieldValue(TYPE_FIELD_ID, nextType);
  if (nextPriority !== priorityValue) writeFieldValue(PRIORITY_FIELD_ID, nextPriority);

  paintTypeField(typeHost, nextType as IssueType);
  paintPriorityField(priorityHost, nextPriority as IssuePriority);
}
