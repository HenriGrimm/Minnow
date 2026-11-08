import { initComposerSkillHighlight } from './composer-skill-highlight';
import { isUserPromptLocked } from './user-prompt-lock';
import {
  listSlashPickerRows,
  recordSlashRecent,
  slashPickerRowId,
  type SlashPickerRow,
  type SlashPickerSection,
} from '../chat/slash-commands/picker-catalog';
import type { SlashCommandListItem, SlashSubmenuItem } from '../chat/slash-commands/registry';
import { createIcon } from './icon';
import { markPreviewOccluder } from './preview-occlusion';
import { getSkillCatalog } from '../skills/client';
import {
  buildSkillPickerInsertion,
  hasSkillPickerOptions,
  listSkillPickerOptions,
  type SkillPickerOption,
} from '../skills/picker-insertion';

type PickerPhase = 'list' | 'options' | 'submenu';

let pickerEl: HTMLDivElement | null = null;
let headerEl: HTMLDivElement | null = null;
let listEl: HTMLUListElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let filterQuery = '';
let activeIndex = 0;
let open = false;
let slashStart = -1;
let pickerPhase: PickerPhase = 'list';
let pendingSkill: { id: string; label: string } | null = null;
let pendingCommand: SlashCommandListItem | null = null;
let fishEl: HTMLSpanElement | null = null;
let repositionHandler: (() => void) | null = null;

/** Skills confirmed via picker selection (not manual typing), keyed by element. */
const pickerApplied = new WeakMap<HTMLTextAreaElement, string>();
/** True while applySkill() is dispatching its synthetic input event. */
let applyingSkill = false;

function ensurePicker(): void {
  if (pickerEl) return;

  pickerEl = document.createElement('div');
  pickerEl.className = 'skill-picker hidden';
  pickerEl.setAttribute('role', 'listbox');
  pickerEl.id = 'skillPicker';

  headerEl = document.createElement('div');
  headerEl.className = 'skill-picker__header hidden';
  headerEl.setAttribute('role', 'presentation');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'skill-picker__back';
  backBtn.textContent = 'Back';
  backBtn.setAttribute('aria-label', 'Back');
  backBtn.prepend(createIcon('chevronLeft'));
  backBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    backToSkillList();
  });

  const headerTitle = document.createElement('span');
  headerTitle.className = 'skill-picker__header-title';

  headerEl.appendChild(backBtn);
  headerEl.appendChild(headerTitle);

  listEl = document.createElement('ul');
  listEl.className = 'skill-picker__list';

  // Minnow touch: a small fish marks the active row and swims to it.
  fishEl = document.createElement('span');
  fishEl.className = 'skill-picker__fish';
  fishEl.setAttribute('aria-hidden', 'true');
  fishEl.appendChild(createIcon('fish'));

  pickerEl.appendChild(headerEl);
  pickerEl.appendChild(listEl);
  pickerEl.appendChild(fishEl);
  markPreviewOccluder(pickerEl, 'menu');
}

/** Move the fish beside the active row (CSS animates unless reduced motion). */
function swimFishToActive(): void {
  if (!fishEl || !pickerEl || !listEl) return;
  const active = listEl.querySelector<HTMLElement>('.skill-picker__item--active');
  if (!active) {
    fishEl.classList.remove('is-visible');
    return;
  }
  // The fish scrolls with the picker's content, so no scrollTop correction.
  const y = listEl.offsetTop + active.offsetTop + active.offsetHeight / 2;
  fishEl.style.transform = `translateY(${Math.round(y)}px) translateY(-50%)`;
  fishEl.classList.add('is-visible');
  active.scrollIntoView?.({ block: 'nearest' });
}

/** Composer row used for viewport anchoring (input-wrap, chat-app-input, desktop wrap). */
function pickerAnchor(el: HTMLTextAreaElement): HTMLElement {
  return el.parentElement ?? el;
}

/** Mount the shared picker on body so scroll/overflow containers cannot clip it. */
function mountPickerPortal(): void {
  ensurePicker();
  if (!pickerEl || pickerEl.parentElement === document.body) return;
  document.body.appendChild(pickerEl);
}

function attachRepositionListeners(): void {
  if (repositionHandler) return;
  repositionHandler = () => {
    if (open) positionPicker();
  };
  window.addEventListener('resize', repositionHandler);
  window.addEventListener('scroll', repositionHandler, true);
}

function detachRepositionListeners(): void {
  if (!repositionHandler) return;
  window.removeEventListener('resize', repositionHandler);
  window.removeEventListener('scroll', repositionHandler, true);
  repositionHandler = null;
}

/** Place the picker above the active composer, flipping below when there is no room. */
function positionPicker(): void {
  if (!pickerEl || !inputEl || !open) return;

  const anchor = pickerAnchor(inputEl);
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const viewportW = window.innerWidth > 0 ? window.innerWidth : 1024;
  const viewportH = window.innerHeight > 0 ? window.innerHeight : 768;
  const width = Math.min(Math.max(rect.width, 280), viewportW - margin * 2);

  pickerEl.style.width = `${width}px`;

  let left = rect.left;
  left = Math.max(margin, Math.min(left, viewportW - width - margin));

  const pickerHeight = pickerEl.offsetHeight;
  let top = rect.top - pickerHeight - gap;
  if (top < margin) {
    top = rect.bottom + gap;
  }
  top = Math.max(margin, Math.min(top, viewportH - pickerHeight - margin));

  pickerEl.style.top = `${top}px`;
  pickerEl.style.left = `${left}px`;
}

function bindActiveInput(el: HTMLTextAreaElement): void {
  inputEl = el;
}

function filteredPickerRows(): SlashPickerRow[] {
  return listSlashPickerRows(filterQuery);
}

function filteredSkillOptions(): SkillPickerOption[] {
  if (!pendingSkill) return [];
  const options = listSkillPickerOptions(pendingSkill.id) ?? [];
  const q = filterQuery.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (option) =>
      option.id.toLowerCase().includes(q) ||
      option.label.toLowerCase().includes(q) ||
      (option.description?.toLowerCase().includes(q) ?? false) ||
      (option.group?.toLowerCase().includes(q) ?? false),
  );
}

function resolveSkillLabel(skillId: string): string {
  return getSkillCatalog().find((skill) => skill.id === skillId)?.label ?? skillId;
}

/** Match `/impeccable`, `/impeccable `, or `/impeccable polish` while the caret is in the token. */
function matchSkillSubOptionContext(before: string): {
  skillId: string;
  filter: string;
  slashStart: number;
} | null {
  const match =
    before.match(/(?:^|\s)\/(impeccable|ui-designer|caveman)\s+([a-z0-9-]*)$/i) ??
    before.match(/(?:^|\s)\/(impeccable|ui-designer|caveman)\s*$/i);
  if (!match || match.index == null) return null;

  const skillId = match[1].toLowerCase();
  if (!hasSkillPickerOptions(skillId)) return null;

  const leadingWs = match[0].startsWith(' ') ? 1 : 0;
  return {
    skillId,
    filter: (match[2] ?? '').toLowerCase(),
    slashStart: match.index + leadingWs,
  };
}

function showPickerSurface(): void {
  ensurePicker();
  mountPickerPortal();
  open = true;
  if (pickerEl) pickerEl.classList.remove('hidden');
  if (inputEl) inputEl.setAttribute('aria-expanded', 'true');
  attachRepositionListeners();
}

function enterSkillOptionsPhase(skillId: string, label: string, start: number, query = ''): void {
  slashStart = start;
  pendingSkill = { id: skillId, label };
  pickerPhase = 'options';
  filterQuery = query;
  activeIndex = 0;
  showPickerSurface();
  renderList();
}

function pickerRowId(row: SlashPickerRow): string {
  return slashPickerRowId(row).replace(':', '-');
}

const SECTION_LABELS: Record<SlashPickerSection, string> = {
  recent: 'Recent',
  commands: 'Commands',
  skills: 'Skills',
};

function appendSectionLabel(list: HTMLUListElement, text: string): void {
  const li = document.createElement('li');
  li.className = 'skill-picker__group';
  li.setAttribute('role', 'presentation');
  li.textContent = text;
  list.appendChild(li);
}

/** Icon · label · description · value · chevron — one row of the menu. */
function buildRow(parts: {
  domId: string;
  active: boolean;
  icon?: Parameters<typeof createIcon>[0];
  label: string;
  hint?: string;
  description: string;
  value?: string;
  selected?: boolean;
  chevron?: boolean;
  disabled?: boolean;
}): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'skill-picker__item';
  li.setAttribute('role', 'option');
  li.id = parts.domId;
  li.setAttribute('aria-selected', parts.active ? 'true' : 'false');
  if (parts.disabled) li.setAttribute('aria-disabled', 'true');
  if (parts.active) {
    li.classList.add('skill-picker__item--active');
    pickerEl?.setAttribute('aria-activedescendant', li.id);
  }

  const icon = document.createElement('span');
  icon.className = 'skill-picker__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(createIcon(parts.icon ?? 'sparkles'));

  const text = document.createElement('span');
  text.className = 'skill-picker__text';
  const label = document.createElement('span');
  label.className = 'skill-picker__label';
  label.textContent = parts.label;
  text.appendChild(label);
  if (parts.hint) {
    const id = document.createElement('code');
    id.className = 'skill-picker__id';
    id.textContent = parts.hint;
    text.appendChild(id);
  }
  const desc = document.createElement('span');
  desc.className = 'skill-picker__desc';
  desc.textContent = parts.description;
  text.appendChild(desc);

  li.append(icon, text);

  if (parts.value || parts.selected) {
    const value = document.createElement('span');
    value.className = 'skill-picker__value';
    if (parts.selected) value.appendChild(createIcon('check'));
    if (parts.value) value.appendChild(document.createTextNode(parts.value));
    li.appendChild(value);
  }
  if (parts.chevron) {
    const chevron = document.createElement('span');
    chevron.className = 'skill-picker__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.appendChild(createIcon('chevronRight'));
    li.appendChild(chevron);
    li.classList.add('skill-picker__item--has-options');
  }
  return li;
}

function commandValue(command: SlashCommandListItem): string {
  try {
    return command.value?.() ?? '';
  } catch {
    return '';
  }
}

function setHeaderTitle(text: string): void {
  if (!headerEl) return;
  const title = headerEl.querySelector('.skill-picker__header-title');
  if (title) title.textContent = text;
}

function renderSkillList(): void {
  const list = listEl;
  const picker = pickerEl;
  const header = headerEl;
  if (!list || !picker || !header) return;

  header.classList.add('hidden');
  const items = filteredPickerRows();
  list.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'skill-picker__empty';
    empty.textContent = 'No matching skills or commands';
    list.appendChild(empty);
    activeIndex = 0;
    if (open) positionPicker();
    return;
  }

  if (activeIndex >= items.length) activeIndex = items.length - 1;
  if (activeIndex < 0) activeIndex = 0;

  let lastSection: SlashPickerSection | null = null;
  items.forEach((row, i) => {
    if (row.section !== lastSection) {
      lastSection = row.section;
      appendSectionLabel(list, SECTION_LABELS[row.section]);
    }
    const isSkill = row.kind === 'skill';
    const li = buildRow({
      domId: `skill-opt-${pickerRowId(row)}`,
      active: i === activeIndex,
      icon: isSkill ? row.icon ?? 'sparkles' : row.command.icon ?? 'tools',
      label: isSkill ? `/${row.skill.id}` : row.command.label,
      hint: isSkill || !row.command.insertion ? undefined : row.command.insertion.trim(),
      description: isSkill ? row.skill.description : row.command.description,
      value: isSkill ? (row.skill.source === 'user' ? 'Custom' : undefined) : commandValue(row.command),
      chevron: isSkill ? hasSkillPickerOptions(row.skill.id) : Boolean(row.command.submenu),
    });
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyPickerRow(row);
    });
    li.addEventListener('mousemove', () => {
      if (activeIndex === i) return;
      activeIndex = i;
      renderList();
    });
    list.appendChild(li);
  });

  swimFishToActive();
  if (open) positionPicker();
}

function renderOptionRows(): void {
  const list = listEl;
  const picker = pickerEl;
  const header = headerEl;
  const skill = pendingSkill;
  if (!list || !picker || !header || !skill) return;

  header.classList.remove('hidden');
  setHeaderTitle(skill.label);

  const options = filteredSkillOptions();
  list.innerHTML = '';

  if (options.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'skill-picker__empty';
    empty.textContent = 'No matching options';
    list.appendChild(empty);
    activeIndex = 0;
    if (open) positionPicker();
    return;
  }

  if (options.length === 0) {
    activeIndex = 0;
  } else {
    if (activeIndex >= options.length) activeIndex = options.length - 1;
    if (activeIndex < 0) activeIndex = 0;
  }

  let lastGroup = '';

  options.forEach((option, i) => {
    if (option.group && option.group !== lastGroup) {
      lastGroup = option.group;
      const group = document.createElement('li');
      group.className = 'skill-picker__group';
      group.setAttribute('role', 'presentation');
      group.textContent = option.group;
      list.appendChild(group);
    }

    const li = buildRow({
      domId: `skill-opt-${skill.id}-${option.id}`,
      active: i === activeIndex,
      icon: 'sparkles',
      label: option.label,
      hint: option.id,
      description: option.description ?? '',
    });
    li.classList.add('skill-picker__item--option');

    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySkillOption(option.id);
    });

    list.appendChild(li);
  });

  swimFishToActive();
  if (open) positionPicker();
}

function filteredSubmenuItems(): SlashSubmenuItem[] {
  if (!pendingCommand?.submenu) return [];
  let items: SlashSubmenuItem[] = [];
  try {
    items = pendingCommand.submenu();
  } catch {
    items = [];
  }
  const q = filterQuery.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => `${item.id} ${item.label} ${item.description ?? ''}`.toLowerCase().includes(q));
}

function renderSubmenuRows(): void {
  const list = listEl;
  const header = headerEl;
  const command = pendingCommand;
  if (!list || !header || !command) return;

  header.classList.remove('hidden');
  setHeaderTitle(command.label);
  const items = filteredSubmenuItems();
  list.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'skill-picker__empty';
    empty.textContent = 'Nothing to choose here';
    list.appendChild(empty);
    activeIndex = 0;
    swimFishToActive();
    if (open) positionPicker();
    return;
  }
  if (activeIndex >= items.length) activeIndex = items.length - 1;
  if (activeIndex < 0) activeIndex = 0;
  items.forEach((item, i) => {
    const li = buildRow({
      domId: `skill-opt-${command.id}-${item.id}`,
      active: i === activeIndex,
      icon: item.icon ?? command.icon,
      label: item.label,
      description: item.description ?? '',
      selected: item.selected,
      disabled: item.disabled,
    });
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySubmenuItem(item);
    });
    li.addEventListener('mousemove', () => {
      if (activeIndex === i) return;
      activeIndex = i;
      renderList();
    });
    list.appendChild(li);
  });
  swimFishToActive();
  if (open) positionPicker();
}

function renderList(): void {
  if (pickerPhase === 'submenu') {
    renderSubmenuRows();
    return;
  }
  if (pickerPhase === 'options') {
    renderOptionRows();
    return;
  }
  renderSkillList();
}

function resetPickerState(): void {
  pickerPhase = 'list';
  pendingSkill = null;
  pendingCommand = null;
}

function closePicker(): void {
  open = false;
  slashStart = -1;
  filterQuery = '';
  activeIndex = 0;
  resetPickerState();
  detachRepositionListeners();
  if (pickerEl) {
    pickerEl.classList.add('hidden');
    pickerEl.style.removeProperty('top');
    pickerEl.style.removeProperty('left');
    pickerEl.style.removeProperty('width');
  }
  if (headerEl) headerEl.classList.add('hidden');
  fishEl?.classList.remove('is-visible');
  if (inputEl) inputEl.setAttribute('aria-expanded', 'false');
}

function openPickerAt(start: number, query: string): void {
  ensurePicker();
  mountPickerPortal();
  open = true;
  slashStart = start;
  filterQuery = query;
  activeIndex = 0;
  resetPickerState();
  if (pickerEl) pickerEl.classList.remove('hidden');
  if (inputEl) inputEl.setAttribute('aria-expanded', 'true');
  renderList();
  attachRepositionListeners();
}

function insertAtSlashStart(insertion: string): void {
  if (!inputEl || slashStart < 0) return;

  const before = inputEl.value.slice(0, slashStart);
  const after = inputEl.value.slice(inputEl.selectionEnd);
  inputEl.value = `${before}${insertion}${after.trimStart()}`;
  const caret = before.length + insertion.length;
  inputEl.setSelectionRange(caret, caret);
  applyingSkill = true;
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  applyingSkill = false;
}

function openSkillOptions(skillId: string, label: string): void {
  if (!inputEl || slashStart < 0) return;

  insertAtSlashStart(`/${skillId} `);
  const nextStart = inputEl.value.lastIndexOf(`/${skillId}`);
  enterSkillOptionsPhase(skillId, label, nextStart >= 0 ? nextStart : slashStart);
  inputEl.focus();
}

function backToSkillList(): void {
  if (!inputEl || slashStart < 0) {
    closePicker();
    return;
  }

  const before = inputEl.value.slice(0, slashStart);
  const after = inputEl.value.slice(inputEl.selectionEnd);
  const token = pickerPhase === 'submenu' ? '/' : filterQuery ? `/${filterQuery}` : '/';
  inputEl.value = `${before}${token}${after}`;
  const caret = before.length + token.length;
  inputEl.setSelectionRange(caret, caret);

  resetPickerState();
  activeIndex = 0;
  renderList();
  inputEl.focus();
}

/** Insert a picker row into the composer and close the popover. */
function applyPickerRow(row: SlashPickerRow): void {
  if (!inputEl || slashStart < 0) {
    closePicker();
    return;
  }

  recordSlashRecent(row);

  if (row.kind === 'command') {
    const command = row.command;
    if (command.submenu) {
      // Drop the typed `/token`; the submenu replaces it in place.
      insertAtSlashStart('');
      pendingCommand = command;
      pickerPhase = 'submenu';
      filterQuery = '';
      activeIndex = Math.max(0, (command.submenu?.() ?? []).findIndex((item) => item.selected));
      showPickerSurface();
      renderList();
      inputEl.focus();
      return;
    }
    if (command.run) {
      insertAtSlashStart('');
      closePicker();
      inputEl.focus();
      void Promise.resolve(command.run()).catch(() => undefined);
      return;
    }
    insertAtSlashStart(command.insertion);
    closePicker();
    inputEl.focus();
    return;
  }

  const skillId = row.skill.id;
  if (hasSkillPickerOptions(skillId)) {
    openSkillOptions(skillId, row.skill.label);
    return;
  }

  insertAtSlashStart(buildSkillPickerInsertion(skillId));
  pickerApplied.set(inputEl, skillId);
  closePicker();
  inputEl.focus();
}

function applySubmenuItem(item: SlashSubmenuItem): void {
  if (item.disabled) return;
  const el = inputEl;
  if (item.insertion && el && slashStart >= 0) {
    insertAtSlashStart(item.insertion);
  }
  closePicker();
  el?.focus();
  if (item.run) void Promise.resolve(item.run()).catch(() => undefined);
}

function applySkillOption(optionId: string): void {
  if (!inputEl || slashStart < 0 || !pendingSkill) {
    closePicker();
    return;
  }

  insertAtSlashStart(buildSkillPickerInsertion(pendingSkill.id, optionId));
  pickerApplied.set(inputEl, pendingSkill.id);
  closePicker();
  inputEl.focus();
}

function detectSlashContext(): void {
  if (!inputEl || isUserPromptLocked()) {
    closePicker();
    return;
  }

  const value = inputEl.value;
  const pos = inputEl.selectionStart;
  const before = value.slice(0, pos);

  const subOptionContext = matchSkillSubOptionContext(before);
  if (subOptionContext) {
    const label =
      pendingSkill?.id === subOptionContext.skillId
        ? pendingSkill.label
        : resolveSkillLabel(subOptionContext.skillId);
    slashStart = subOptionContext.slashStart;
    pendingSkill = { id: subOptionContext.skillId, label };
    pickerPhase = 'options';
    filterQuery = subOptionContext.filter;
    activeIndex = 0;
    if (!open) showPickerSurface();
    renderList();
    return;
  }

  if (pickerPhase === 'submenu' && pendingCommand && slashStart >= 0) {
    // Typing inside a submenu filters its items (the token was removed).
    filterQuery = value.slice(slashStart, pos).trim();
    activeIndex = 0;
    renderList();
    return;
  }

  if (pickerPhase === 'options') {
    resetPickerState();
  }

  const slashMatch = before.match(/(?:^|\s)\/([a-z0-9-]*)$/);

  if (!slashMatch || slashMatch.index == null) {
    closePicker();
    return;
  }

  const leadingWs = slashMatch[0].startsWith(' ') ? 1 : 0;
  const start = slashMatch.index + leadingWs;
  if (!open || slashStart !== start || pickerPhase !== 'list') {
    openPickerAt(start, slashMatch[1] ?? '');
    return;
  }

  filterQuery = slashMatch[1] ?? '';
  renderList();
}

/** Whether picker is open (Enter should select, not send). */
export function isSkillPickerOpen(): boolean {
  return open;
}

/** Returns the skill ID confirmed via picker for this element, or null if typed manually. */
export function getPickerAppliedSkillId(el: HTMLTextAreaElement): string | null {
  return pickerApplied.get(el) ?? null;
}

/** Handle keyboard while picker is open. Returns true if consumed. */
export function handleSkillPickerKeydown(e: KeyboardEvent): boolean {
  if (!open) return false;

  if (pickerPhase === 'submenu') {
    const items = filteredSubmenuItems();
    const atStart = !filterQuery;
    if (e.key === 'Escape' || e.key === 'ArrowLeft' || (e.key === 'Backspace' && atStart)) {
      e.preventDefault();
      backToSkillList();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      activeIndex = Math.min(Math.max(activeIndex + delta, 0), Math.max(0, items.length - 1));
      renderList();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowRight') {
      const selected = items[activeIndex];
      if (selected) {
        e.preventDefault();
        applySubmenuItem(selected);
        return true;
      }
    }
    return false;
  }

  if (pickerPhase === 'options') {
    const options = filteredSkillOptions();
    if (e.key === 'Escape') {
      e.preventDefault();
      backToSkillList();
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, Math.max(0, options.length - 1));
      renderList();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderList();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const selected = options[activeIndex];
      if (selected) {
        e.preventDefault();
        applySkillOption(selected.id);
        return true;
      }
    }
    return false;
  }

  const items = filteredPickerRows();
  if (e.key === 'Escape') {
    e.preventDefault();
    closePicker();
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, Math.max(0, items.length - 1));
    renderList();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    renderList();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (items.length > 0) {
      e.preventDefault();
      applyPickerRow(items[activeIndex]);
      return true;
    }
  }
  if (e.key === 'ArrowRight') {
    const row = items[activeIndex];
    const opens = row && (row.kind === 'command' ? Boolean(row.command.submenu) : hasSkillPickerOptions(row.skill.id));
    if (opens) {
      e.preventDefault();
      applyPickerRow(row);
      return true;
    }
  }
  return false;
}

/** @internal Reset module singleton between happy-dom document swaps in tests. */
export function __resetSkillPickerForTests(): void {
  closePicker();
  pickerEl = null;
  headerEl = null;
  listEl = null;
  fishEl = null;
  inputEl = null;
}

/** Mount slash picker listeners on one composer textarea (idempotent). */
export function initComposerSlashPicker(composerInput: HTMLTextAreaElement): void {
  if (composerInput.dataset.slashPickerBound === '1') return;
  composerInput.dataset.slashPickerBound = '1';
  initComposerSkillHighlight(composerInput);

  composerInput.setAttribute('aria-autocomplete', 'list');
  mountPickerPortal();
  composerInput.setAttribute('aria-controls', 'skillPicker');

  composerInput.addEventListener('focus', () => {
    bindActiveInput(composerInput);
  });

  composerInput.addEventListener('input', () => {
    bindActiveInput(composerInput);
    if (applyingSkill) return;

    const storedSkill = pickerApplied.get(composerInput);
    if (storedSkill && !new RegExp(`(?:^|\\s)/${storedSkill}(?:\\s|$)`).test(composerInput.value)) {
      pickerApplied.delete(composerInput);
    }
    if (!open) {
      const pos = composerInput.selectionStart ?? composerInput.value.length;
      const before = composerInput.value.slice(0, pos);
      if (!/(?:^|\s)\/[a-z0-9-]*$/.test(before)) return;
    }
    detectSlashContext();
  });

  composerInput.addEventListener('blur', () => {
    window.setTimeout(() => closePicker(), 150);
  });
}

/** @deprecated Use initComposerSlashPicker */
export function mountSlashPicker(msgInput: HTMLTextAreaElement): void {
  initComposerSlashPicker(msgInput);
}

/** Wire slash picker on every known composer input present in the DOM. */
export function initAllComposerSlashPickers(): void {
  for (const id of ['msgInput', 'chatAppInput', 'desktopInput']) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el) initComposerSlashPicker(el);
  }
}

