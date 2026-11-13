/**
 * Taxonomy pickers shared by New issue and thread capture.
 */

import {
  defaultIssuePriorityId,
  defaultIssueStatusId,
  defaultIssueTypeId,
  sortedPriorities,
  sortedStatuses,
  sortedTypes,
  type TaxonomyItem,
} from '../issues/taxonomy';
import {
  createIssuePriorityChip,
  createIssueStatusChip,
  createIssueTypeChip,
  resolveIssueStatusIcon,
  resolveIssueTypeIcon,
  resolveIssuePriorityIcon,
} from '../issues/type-icons';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
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

const PROPERTY_FIELDS = {
  type: {
    label: 'Type',
    options: sortedTypes,
    fallback: defaultIssueTypeId,
    chip: (id: string, item?: TaxonomyItem) => createIssueTypeChip(id, item, { labeled: true }),
    icon: resolveIssueTypeIcon,
  },
  priority: {
    label: 'Priority',
    options: sortedPriorities,
    fallback: defaultIssuePriorityId,
    chip: createIssuePriorityChip,
    icon: resolveIssuePriorityIcon,
  },
  status: {
    label: 'Status',
    options: sortedStatuses,
    fallback: defaultIssueStatusId,
    chip: createIssueStatusChip,
    icon: resolveIssueStatusIcon,
  },
};

export function paintIssuePropertyField(
  host: HTMLElement,
  property: keyof typeof PROPERTY_FIELDS,
  value: string | undefined,
  onChange: (value: string) => void,
): void {
  const field = PROPERTY_FIELDS[property];
  const taxonomy = getIssuesTaxonomySync();
  const options = field.options(taxonomy);
  const id = options.find((entry) => entry.id === value)?.id ?? field.fallback(taxonomy);
  const item = options.find((entry) => entry.id === id);
  const chip = field.chip(id, item);
  const restoreFocus = host.contains(document.activeElement);
  onChange(id);
  bindPropertyChip(chip, `${field.label}: ${item?.label ?? id}`, (anchor) => {
    openIssuesContextMenu({
      anchor,
      restoreFocus: anchor,
      label: field.label,
      items: options.map((entry) => ({
        id: entry.id,
        label: entry.label,
        iconClass: field.icon(entry.id, entry),
        onSelect: () => paintIssuePropertyField(host, property, entry.id, onChange),
      })),
    });
  });
  host.replaceChildren(chip);
  if (restoreFocus) chip.focus();
}

/** Repaint type and priority chips from hidden field values and taxonomy. */
export function syncNewIssuePropertyFields(): void {
  const form = document.getElementById('issuesNewForm');
  if (!form) return;
  ensureNewIssuePropertyFields(form);

  const typeHost = document.getElementById(TYPE_HOST_ID);
  const priorityHost = document.getElementById(PRIORITY_HOST_ID);
  if (!(typeHost instanceof HTMLElement) || !(priorityHost instanceof HTMLElement)) return;

  paintIssuePropertyField(typeHost, 'type', readFieldValue(TYPE_FIELD_ID, 'task'), (id) => writeFieldValue(TYPE_FIELD_ID, id));
  paintIssuePropertyField(priorityHost, 'priority', readFieldValue(PRIORITY_FIELD_ID, 'none'), (id) => writeFieldValue(PRIORITY_FIELD_ID, id));
}
