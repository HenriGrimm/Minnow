/**
 * Brain app — Memories: the project and user memories agents can search, with
 * revision-checked edit and forget. Other Brain pages are legacy notes that
 * agents never see.
 */

import {
  readConfigFile,
  writeConfigFile,
} from '../../config/config-file-cache';
import {
  fetchMemories,
  forgetMemoryRecord,
  updateMemoryRecord,
} from '../../brain/client';
import type { MemoryKind, MemoryListing, MemoryRecord, MemoryScope } from '../../brain/types';
import { fetchMemoryEnabled } from '../../memory/client';
import { appConfirm } from '../app-dialog';

type StatusFn = (kind: 'idle' | 'ok' | 'err' | 'spin', message: string) => void;

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  decision: 'Decisions',
  constraint: 'Constraints',
  gotcha: 'Gotchas',
  preference: 'Preferences',
  reference: 'References',
};

const KIND_ORDER: MemoryKind[] = ['decision', 'constraint', 'gotcha', 'preference', 'reference'];

export interface MemoryGroup {
  scope: MemoryScope;
  title: string;
  count: number;
  cap: number;
  kinds: { kind: MemoryKind; label: string; items: MemoryRecord[] }[];
}

/** Group a listing by scope (project first), then by kind in a stable order. */
export function groupMemories(listing: MemoryListing): MemoryGroup[] {
  const scopes: { scope: MemoryScope; title: string; cap: number }[] = [];
  if (listing.project) {
    scopes.push({ scope: 'project', title: `Project · ${listing.project.label}`, cap: listing.limits.projectCap });
  }
  scopes.push({ scope: 'user', title: 'Your preferences · all projects', cap: listing.limits.userCap });
  return scopes.map(({ scope, title, cap }) => {
    const rows = listing.memories.filter((memory) => memory.scope === scope);
    return {
      scope,
      title,
      cap,
      count: rows.length,
      kinds: KIND_ORDER
        .map((kind) => ({
          kind,
          label: MEMORY_KIND_LABELS[kind],
          items: rows.filter((memory) => (memory.kind ?? 'reference') === kind),
        }))
        .filter((group) => group.items.length > 0),
    };
  });
}

let bindingsDone = false;
let refreshGen = 0;
let listing: MemoryListing | null = null;
let selectedId: string | null = null;
let editingId: string | null = null;

const setStatus: StatusFn = (kind, message) => {
  const el = document.getElementById('brainMemoriesStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
};

function findMemory(id: string | null): MemoryRecord | undefined {
  return id ? listing?.memories.find((memory) => memory.id === id) : undefined;
}

function setPaneVisible(
  id: 'brainMemoryEmptyState' | 'brainMemoryDetail' | 'brainMemoryAddPanel',
  visible: boolean,
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  el.toggleAttribute('hidden', !visible);
}

function showPane(pane: 'empty' | 'detail' | 'edit'): void {
  setPaneVisible('brainMemoryEmptyState', pane === 'empty');
  setPaneVisible('brainMemoryDetail', pane === 'detail');
  setPaneVisible('brainMemoryAddPanel', pane === 'edit');
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function chip(text: string, extra = 'brain-memory-chip--plain'): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `brain-memory-chip${extra ? ` ${extra}` : ''}`;
  el.textContent = text;
  return el;
}

// ── Detail ───────────────────────────────────────────────────────────────────

function renderDetail(memory: MemoryRecord): void {
  const mount = document.getElementById('brainMemoryDetail');
  if (!mount) return;
  mount.replaceChildren();

  const head = document.createElement('div');
  head.className = 'brain-memory-detail__head';
  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.className = 'brain-memory-detail__title';
  title.textContent = memory.title || 'Untitled';
  const meta = document.createElement('div');
  meta.className = 'brain-memory-detail__meta';
  meta.append(
    chip(memory.kind, ''),
    chip(memory.scope === 'user' ? 'All projects' : listing?.project?.label ?? 'Project'),
    chip(memory.source === 'user' ? 'Edited by you' : 'Saved by an agent'),
  );
  const updated = document.createElement('span');
  updated.textContent = `Updated ${formatTimestamp(memory.updatedAt)}`;
  meta.append(updated);
  titleWrap.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'brain-memory-detail__actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'brain-action-btn';
  editBtn.textContent = 'Edit';
  editBtn.dataset.memoryEdit = memory.id;
  editBtn.setAttribute('aria-label', `Edit memory ${memory.title}`);
  const forgetBtn = document.createElement('button');
  forgetBtn.type = 'button';
  forgetBtn.className = 'brain-action-btn brain-action-btn--danger';
  forgetBtn.textContent = 'Forget';
  forgetBtn.dataset.memoryForget = memory.id;
  forgetBtn.setAttribute('aria-label', `Forget memory ${memory.title}`);
  actions.append(editBtn, forgetBtn);
  head.append(titleWrap, actions);

  const body = document.createElement('pre');
  body.className = 'brain-memory-detail__body';
  body.textContent = memory.body?.trim() ? memory.body : '(empty)';
  mount.append(head, body);

  if (memory.evidence) {
    const evidence = document.createElement('p');
    evidence.className = 'brain-memory-detail__evidence';
    evidence.textContent = `Evidence: ${memory.evidence}`;
    mount.append(evidence);
  }
  showPane('detail');
}

function select(id: string | null): void {
  selectedId = id;
  editingId = null;
  document.querySelectorAll<HTMLButtonElement>('#brainMemoryList [data-memory-select]').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.memorySelect === id ? 'true' : 'false');
  });
  const memory = findMemory(id);
  if (memory) renderDetail(memory);
  else showPane('empty');
}

// ── Edit ─────────────────────────────────────────────────────────────────────

function showEdit(memory: MemoryRecord): void {
  editingId = memory.id;
  const value = (id: string, text: string) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (el) el.value = text;
  };
  value('brainMemoryAddTitle', memory.title);
  value('brainMemoryAddKind', memory.kind);
  value('brainMemoryAddBody', memory.body);
  value('brainMemoryAddEvidence', memory.evidence ?? '');
  showFormError('');
  showPane('edit');
  (document.getElementById('brainMemoryAddTitle') as HTMLInputElement | null)?.focus();
}

function showFormError(message: string): void {
  const err = document.getElementById('brainMemoryAddError');
  if (!err) return;
  err.textContent = message;
  err.classList.toggle('hidden', !message);
}

async function submitEdit(): Promise<void> {
  const memory = findMemory(editingId);
  if (!memory) return;
  const read = (id: string) =>
    ((document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? '').trim();
  const title = read('brainMemoryAddTitle');
  const body = read('brainMemoryAddBody');
  if (!title || !body) {
    showFormError('Title and body are required.');
    return;
  }
  const submit = document.getElementById('brainMemoryAddSubmit') as HTMLButtonElement | null;
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  setStatus('spin', 'Saving memory…');
  const result = await updateMemoryRecord(memory.id, {
    expectedRevision: memory.revision,
    title,
    body,
    kind: read('brainMemoryAddKind') as MemoryKind,
    evidence: read('brainMemoryAddEvidence'),
  });
  if (submit) submit.disabled = false;
  if (!result.ok) {
    showFormError(result.code === 'stale'
      ? 'An agent changed this memory while you were editing. Reload it and apply your change again.'
      : result.error);
    setStatus('err', 'Memory not saved');
    return;
  }
  setStatus('ok', `Updated “${result.memory.title}”`);
  selectedId = result.memory.id;
  await refreshMemories();
}

async function forget(id: string): Promise<void> {
  const memory = findMemory(id);
  if (!memory) return;
  const ok = await appConfirm(`Forget “${memory.title}”? Agents will no longer find it.`, {
    confirmLabel: 'Forget',
    danger: true,
  });
  if (!ok) return;
  const result = await forgetMemoryRecord(id, { expectedRevision: memory.revision });
  if (!result.ok) {
    setStatus('err', result.error ?? 'Could not forget this memory');
    return;
  }
  if (selectedId === id) selectedId = null;
  setStatus('ok', `Forgot “${memory.title}”`);
  await refreshMemories();
}

// ── List ─────────────────────────────────────────────────────────────────────

function renderList(groups: MemoryGroup[]): void {
  const listEl = document.getElementById('brainMemoryList');
  if (!listEl) return;
  listEl.replaceChildren();
  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'brain-memory-group';
    section.setAttribute('aria-label', group.title);
    const head = document.createElement('p');
    head.className = 'brain-memory-group__head';
    const label = document.createElement('span');
    label.textContent = group.title;
    const count = document.createElement('span');
    count.className = 'brain-memory-group__count';
    count.textContent = `${group.count} / ${group.cap}`;
    count.title = `${group.count} of ${group.cap} memories used`;
    head.append(label, count);
    section.append(head);

    if (!group.kinds.length) {
      const empty = document.createElement('p');
      empty.className = 'brain-memory-list__note';
      empty.textContent = group.scope === 'user'
        ? 'No cross-project preferences yet.'
        : 'No memories for this project yet.';
      section.append(empty);
    }
    for (const kindGroup of group.kinds) {
      const kindHead = document.createElement('p');
      kindHead.className = 'brain-memory-group__kind';
      kindHead.textContent = kindGroup.label;
      section.append(kindHead);
      for (const memory of kindGroup.items) {
        const row = document.createElement('article');
        row.className = 'brain-memory-list-item';
        row.setAttribute('role', 'listitem');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'brain-memory-list-item__btn';
        btn.dataset.memorySelect = memory.id;
        btn.setAttribute('aria-selected', memory.id === selectedId ? 'true' : 'false');
        const title = document.createElement('span');
        title.className = 'brain-memory-list-item__title';
        title.textContent = memory.title || 'Untitled';
        const meta = document.createElement('span');
        meta.className = 'brain-memory-list-item__meta';
        meta.textContent = String(memory.updatedAt ?? '').slice(0, 10);
        btn.append(title, meta);
        row.append(btn);
        section.append(row);
      }
    }
    listEl.append(section);
  }
}

async function refreshMemories(): Promise<void> {
  const gen = ++refreshGen;
  const countEl = document.getElementById('brainMemoryEntryCount');
  const hintEl = document.getElementById('brainMemoryServerHint');
  const offlineEl = document.getElementById('brainMemoryOffline');
  const next = await fetchMemories();
  if (gen !== refreshGen) return;
  offlineEl?.classList.toggle('hidden', next !== null);
  listing = next;
  if (!next) {
    if (countEl) countEl.textContent = '— memories';
    if (hintEl) hintEl.textContent = 'Open Minnow to review memories';
    document.getElementById('brainMemoryList')?.replaceChildren();
    showPane('empty');
    return;
  }
  const total = next.memories.length;
  if (countEl) countEl.textContent = `${total} ${total === 1 ? 'memory' : 'memories'}`;
  if (hintEl) hintEl.textContent = next.project ? `Project: ${next.project.label}` : 'No project open';
  renderList(groupMemories(next));
  if (selectedId && !findMemory(selectedId)) selectedId = null;
  select(selectedId ?? next.memories[0]?.id ?? null);
}

function bindMemoriesSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement;
    const selectBtn = target.closest<HTMLElement>('[data-memory-select]');
    if (selectBtn?.dataset.memorySelect) {
      select(selectBtn.dataset.memorySelect);
      return;
    }
    const editBtn = target.closest<HTMLElement>('[data-memory-edit]');
    if (editBtn?.dataset.memoryEdit) {
      const memory = findMemory(editBtn.dataset.memoryEdit);
      if (memory) showEdit(memory);
      return;
    }
    const forgetBtn = target.closest<HTMLElement>('[data-memory-forget]');
    if (forgetBtn?.dataset.memoryForget) void forget(forgetBtn.dataset.memoryForget);
  };
  document.getElementById('brainMemoryList')?.addEventListener('click', onClick);
  document.getElementById('brainMemoryDetailPane')?.addEventListener('click', onClick);

  document.getElementById('brainMemoryAddForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitEdit();
  });
  document.getElementById('brainMemoryAddCancel')?.addEventListener('click', () => select(editingId ?? selectedId));
  document.getElementById('brainMemoryRefresh')?.addEventListener('click', () => {
    void refreshMemories();
  });
  window.addEventListener('minnow:memory-changed', () => {
    // Don't replace a draft being edited. Opening the section or Refresh reads
    // the latest revision, and a stale save is rejected by the store.
    if (!editingId && document.getElementById('brainSection-memories')?.classList.contains('is-active')) {
      void refreshMemories();
    }
  });

  const enableEl = document.getElementById('brainMemoryEnabled') as HTMLInputElement | null;
  enableEl?.addEventListener('change', async () => {
    const config = await readConfigFile({ fresh: true });
    if (!config) {
      setStatus('err', 'Memory settings require Minnow running locally');
      return;
    }
    const memory = config.memory;
    config.memory = {
      ...(memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {}),
      enabled: enableEl.checked,
    };
    if (await writeConfigFile(config)) {
      setStatus('idle', enableEl.checked ? 'Agent memory on' : 'Agent memory off');
    } else {
      setStatus('err', 'Memory settings require Minnow running locally');
    }
  });
}

/** Load the Memories section: toggle, grouped memories, edit and forget. */
export async function renderMemoriesSection(): Promise<void> {
  bindMemoriesSection();
  const enableEl = document.getElementById('brainMemoryEnabled') as HTMLInputElement | null;
  if (enableEl) enableEl.checked = await fetchMemoryEnabled();
  await refreshMemories();
}
