import { randomUUID } from '../lib/random-id';
import type { ModelRouter, RouterEntry } from '../models/routers';
import { formatRouterTaskTypeLabel, ROUTER_TASK_TYPES } from '../models/router-task-types.mjs';
import '../styles/model-router-task-types.css';
import { iconHtml } from './icon';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

let openTasks: { owner: HTMLElement; close: () => void } | undefined;

/** Close a task picker before its owning pool editor is replaced or disposed. */
export function closePoolTaskTypeChoices(container: HTMLElement): void {
  if (openTasks && container.contains(openTasks.owner)) openTasks.close();
}

export const POOL_POLICIES: { id: ModelRouter['policy']; title: string; detail: string }[] = [
  { id: 'priority', title: 'Prefer first', detail: 'Start with the first available model in your lineup.' },
  { id: 'balance', title: 'Share work', detail: 'Spread new chats across models. Higher ranks get more work.' },
  { id: 'evaluate', title: 'Match the task', detail: 'An evaluator picks the task type, model tier, and reasoning for each new chat.' },
];

export function createPoolEntry(binding: { providerId: string; modelId: string }): RouterEntry {
  return { id: randomUUID(), ...binding, enabled: true, concurrencyLimit: 1 };
}

/** The same multi-specialty assignment control in both pool editors. */
export function poolTaskTypeChoices(entry: RouterEntry, label: string, onChange: () => void): HTMLElement {
  const group = document.createElement('div'); group.className = 'router-task-types';
  group.setAttribute('aria-label', `Task types for ${label}`);
  const caption = document.createElement('span'); caption.className = 'router-task-types__caption'; caption.textContent = 'Tasks';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'router-task-types__trigger';
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
  const valueLabel = document.createElement('span'); valueLabel.className = 'router-task-types__value';
  const chevron = document.createElement('span'); chevron.innerHTML = iconHtml('chevronDown', { size: 10 }); chevron.setAttribute('aria-hidden', 'true');
  trigger.append(valueLabel, chevron);
  const panel = document.createElement('div'); panel.className = 'router-task-popover'; panel.hidden = true; panel.popover = 'auto';
  panel.id = `pool-tasks-${randomUUID()}`; trigger.setAttribute('aria-controls', panel.id);
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', `Choose task types for ${label}`);
  const heading = document.createElement('strong'); heading.textContent = 'Assign task types';
  const hint = document.createElement('p'); hint.textContent = 'Choose specialties, or accept any task.';
  const choices = document.createElement('div'); choices.className = 'router-task-types__choices';
  const any = document.createElement('button'); any.type = 'button'; any.textContent = 'Any task';
  any.className = 'router-task-types__any';
  const inputs: HTMLInputElement[] = [];
  const refresh = (): void => {
    const labels = entry.taskTypes?.map(formatRouterTaskTypeLabel) || [];
    valueLabel.textContent = labels.length ? `${labels.slice(0, 2).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}` : 'Any task';
    trigger.title = labels.length ? labels.join(', ') : 'Accept any task type';
    trigger.setAttribute('aria-label', `Task types for ${label}: ${labels.join(', ') || 'Any task'}`);
    any.setAttribute('aria-pressed', String(!entry.taskTypes?.length));
    for (const input of inputs) input.checked = entry.taskTypes?.includes(input.value as typeof ROUTER_TASK_TYPES[number]) || false;
  };
  any.onclick = () => { delete entry.taskTypes; refresh(); onChange(); };
  choices.append(any);
  for (const value of ROUTER_TASK_TYPES) {
    const option = document.createElement('label'); option.className = 'router-task-types__option';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = value;
    checkbox.setAttribute('aria-label', formatRouterTaskTypeLabel(value));
    checkbox.checked = entry.taskTypes?.includes(value) || false;
    inputs.push(checkbox);
    checkbox.onchange = () => {
      const selected = new Set(entry.taskTypes || []);
      if (checkbox.checked) selected.add(value); else selected.delete(value);
      if (selected.size) entry.taskTypes = ROUTER_TASK_TYPES.filter(type => selected.has(type));
      else delete entry.taskTypes;
      refresh(); onChange();
    };
    const text = document.createElement('span'); text.textContent = formatRouterTaskTypeLabel(value);
    option.append(checkbox, text); choices.append(option);
  }
  const done = document.createElement('button'); done.type = 'button'; done.className = 'router-task-types__done'; done.textContent = 'Done';
  panel.append(heading, hint, choices, done);
  let observer: MutationObserver | undefined;
  let opened = false;
  const close = (): void => {
    if (!opened) return;
    opened = false;
    observer?.disconnect(); observer = undefined;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', scrolled, true);
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (openTasks?.owner === group) openTasks = undefined;
    unregisterChromePopover();
  };
  const outside = (event: Event): void => { if (!group.contains(event.target as Node)) close(); };
  const scrolled = (event: Event): void => { if (!panel.contains(event.target as Node)) close(); };
  trigger.onclick = () => {
    if (opened) { close(); return; }
    openTasks?.close(); opened = true; openTasks = { owner: group, close };
    panel.hidden = false; registerChromePopover();
    if (typeof panel.showPopover === 'function') panel.showPopover();
    const box = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 280; const height = panel.offsetHeight;
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(box.bottom + 6, window.innerHeight - height - 8))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close); window.addEventListener('scroll', scrolled, true);
    const Observer = group.ownerDocument.defaultView?.MutationObserver;
    if (Observer) { observer = new Observer(() => { if (!group.isConnected) close(); }); observer.observe(document.body, { childList: true, subtree: true }); }
    (inputs.find(input => input.checked) || any).focus();
  };
  done.onclick = () => { close(); trigger.focus(); };
  panel.addEventListener('toggle', event => { if ((event as ToggleEvent).newState === 'closed') close(); });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); }
    if (event.key === 'Tab') {
      if (event.shiftKey && document.activeElement === any) { event.preventDefault(); done.focus(); }
      else if (!event.shiftKey && document.activeElement === done) { event.preventDefault(); any.focus(); }
    }
  });
  refresh(); group.append(caption, trigger, panel); return group;
}

/** Read-only task assignments used by pool inspectors and the Models popover. */
export function poolTaskTypeBadges(entry: Pick<RouterEntry, 'taskTypes'>): HTMLElement {
  const tags = document.createElement('div'); tags.className = 'router-task-badges';
  const values = entry.taskTypes?.length ? entry.taskTypes.map(formatRouterTaskTypeLabel) : ['Any task'];
  for (const value of values) {
    const tag = document.createElement('span'); tag.textContent = value; tags.append(tag);
  }
  return tags;
}

/** Both pool editors use the same strategy controls and routing descriptions. */
export function poolStrategyChoices(policy: ModelRouter['policy'], onChange: (policy: ModelRouter['policy']) => void): HTMLElement {
  const choices = document.createElement('div');
  choices.className = 'router-policy-choices';
  choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Routing strategy');
  for (const item of POOL_POLICIES) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.policy = item.id;
    button.setAttribute('aria-pressed', String(policy === item.id));
    const title = document.createElement('strong'); title.textContent = item.title;
    const detail = document.createElement('span'); detail.textContent = item.detail;
    button.append(title, detail); button.onclick = () => onChange(item.id); choices.append(button);
  }
  return choices;
}
