import {
  readConfigFile,
  writeConfigFile,
} from '../../config/config-file-cache';
import {
  backupMemory,
  clearMemory,
  createMemoryEntry,
  deleteMemoryEntry,
  fetchMemoryEnabled,
  fetchMemoryEntries,
  fetchMemoryStatus,
  updateMemoryEntry,
} from '../../memory/client';
import { appConfirm } from '../app-dialog';
import { parseMemoryTagsInput } from '../../memory/parse-tags';
import type { MemoryEntryWithBody } from '../../memory/types';
import {
  memorySavedPayloadFromEntry,
  showMemorySavedToast,
} from '../memory-saved-toast';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

let bindingsDone = false;
let listBindingsDone = false;
let addFormBound = false;
/** Bumps on each list refresh so stale concurrent fetches cannot append twice. */
let memoryListRefreshGen = 0;
let selectedMemoryId: string | null = null;
let cachedEntries: MemoryEntryWithBody[] = [];
/** When set, the compose form updates this entry instead of creating one. */
let editingMemoryId: string | null = null;

type MemoryComposeMode = 'add' | 'edit';

const MEMORY_BODY_MAX_BYTES = 32 * 1024;

const setStatus: StatusFn = (kind, message) => {
  const el = document.getElementById('brainMemoriesStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
};

// ── Compose panes ────────────────────────────────────────────────────────────

function clearMemoryAddForm(): void {
  const form = document.getElementById('brainMemoryAddForm') as HTMLFormElement | null;
  form?.reset();
  const err = document.getElementById('brainMemoryAddError');
  err?.classList.add('hidden');
  if (err) err.textContent = '';
  editingMemoryId = null;
}

function formatMemoryTagsForInput(tags: string[]): string {
  return tags.join(', ');
}

function setMemoryComposeChrome(mode: MemoryComposeMode): void {
  const eyebrow = document.querySelector('#brainMemoryAddPanel .brain-memory-compose__eyebrow');
  const submitBtn = document.getElementById('brainMemoryAddSubmit');
  const resetBtn = document.getElementById('brainMemoryAddReset');
  if (eyebrow) {
    eyebrow.textContent = mode === 'edit' ? 'Edit memory' : 'New memory';
  }
  if (submitBtn) {
    submitBtn.textContent = mode === 'edit' ? 'Save changes' : 'Save memory';
  }
  resetBtn?.classList.toggle('hidden', mode === 'edit');
  if (mode === 'edit') resetBtn?.setAttribute('hidden', '');
  else resetBtn?.removeAttribute('hidden');
}

function sortMemoryEntries(entries: MemoryEntryWithBody[]): MemoryEntryWithBody[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function formatMemoryTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function setPaneVisible(
  id: 'brainMemoryEmptyState' | 'brainMemoryDetail' | 'brainMemoryAddPanel',
  visible: boolean,
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  if (visible) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

function showMemoryEmptyPane(): void {
  setPaneVisible('brainMemoryEmptyState', true);
  setPaneVisible('brainMemoryDetail', false);
  setPaneVisible('brainMemoryAddPanel', false);
}

function showMemoryComposePane(mode: MemoryComposeMode = 'add'): void {
  setPaneVisible('brainMemoryEmptyState', false);
  setPaneVisible('brainMemoryDetail', false);
  setPaneVisible('brainMemoryAddPanel', true);
  setMemoryComposeChrome(mode);
  const titleInput = document.getElementById('brainMemoryAddTitle') as HTMLInputElement | null;
  titleInput?.focus();
}

function showMemoryEditPane(entry: MemoryEntryWithBody): void {
  editingMemoryId = entry.id;
  const titleInput = document.getElementById('brainMemoryAddTitle') as HTMLInputElement | null;
  const bodyInput = document.getElementById('brainMemoryAddBody') as HTMLTextAreaElement | null;
  const tagsInput = document.getElementById('brainMemoryAddTags') as HTMLInputElement | null;
  const errEl = document.getElementById('brainMemoryAddError');
  if (titleInput) titleInput.value = entry.title || '';
  if (bodyInput) bodyInput.value = entry.body ?? '';
  if (tagsInput) tagsInput.value = formatMemoryTagsForInput(entry.tags);
  errEl?.classList.add('hidden');
  if (errEl) errEl.textContent = '';
  showMemoryComposePane('edit');
}

function showMemoryDetailPane(): void {
  setPaneVisible('brainMemoryEmptyState', false);
  setPaneVisible('brainMemoryAddPanel', false);
  setPaneVisible('brainMemoryDetail', true);
}

function updateListSelectionHighlight(): void {
  const listEl = document.getElementById('brainMemoryList');
  if (!listEl) return;
  listEl.querySelectorAll<HTMLButtonElement>('[data-memory-select]').forEach((btn) => {
    const selected = btn.dataset.memorySelect === selectedMemoryId;
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function renderMemoryDetail(entry: MemoryEntryWithBody): void {
  const mount = document.getElementById('brainMemoryDetail');
  if (!mount) return;
  mount.replaceChildren();

  const head = document.createElement('div');
  head.className = 'brain-memory-detail__head';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.className = 'brain-memory-detail__title';
  title.textContent = entry.title || 'Untitled';
  titleWrap.append(title);

  const meta = document.createElement('div');
  meta.className = 'brain-memory-detail__meta';

  if (entry.pinned) {
    const pin = document.createElement('span');
    pin.className = 'brain-memory-chip brain-memory-chip--pinned';
    pin.textContent = 'Pinned';
    meta.append(pin);
  }

  const source = document.createElement('span');
  source.className = 'brain-memory-chip';
  source.textContent = entry.source;
  meta.append(source);

  const updated = document.createElement('span');
  updated.textContent = `Updated ${formatMemoryTimestamp(entry.updatedAt)}`;
  meta.append(updated);

  if (entry.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'brain-memory-list-item__meta';
    tags.textContent = entry.tags.map((t) => `#${t}`).join(' ');
    meta.append(tags);
  }

  titleWrap.append(meta);
  head.append(titleWrap);

  const actions = document.createElement('div');
  actions.className = 'brain-memory-detail__actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'brain-action-btn';
  editBtn.textContent = 'Edit';
  editBtn.setAttribute('aria-label', `Edit memory ${entry.title}`);
  editBtn.dataset.memoryEdit = entry.id;
  actions.append(editBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'brain-action-btn brain-action-btn--danger';
  removeBtn.textContent = 'Delete';
  removeBtn.setAttribute('aria-label', `Delete memory ${entry.title}`);
  removeBtn.dataset.memoryRemove = entry.id;
  actions.append(removeBtn);

  head.append(actions);

  const body = document.createElement('pre');
  body.className = 'brain-memory-detail__body';
  body.textContent = entry.body?.trim() ? entry.body : '(empty)';

  mount.append(head, body);
  showMemoryDetailPane();
}

function selectMemoryEntry(id: string | null): void {
  selectedMemoryId = id;
  updateListSelectionHighlight();
  if (!id) {
    showMemoryEmptyPane();
    return;
  }
  const entry = cachedEntries.find((e) => e.id === id);
  if (!entry) {
    showMemoryEmptyPane();
    return;
  }
  editingMemoryId = null;
  renderMemoryDetail(entry);
}

// ── List ─────────────────────────────────────────────────────────────────────

function renderMemoryListItem(entry: MemoryEntryWithBody): HTMLElement {
  const row = document.createElement('article');
  row.className = 'brain-memory-list-item';
  row.setAttribute('role', 'listitem');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'brain-memory-list-item__btn';
  btn.dataset.memorySelect = entry.id;
  btn.setAttribute('aria-selected', entry.id === selectedMemoryId ? 'true' : 'false');

  const title = document.createElement('span');
  title.className = 'brain-memory-list-item__title';
  title.textContent = entry.title || 'Untitled';

  const metaParts: string[] = [];
  if (entry.pinned) metaParts.push('pinned');
  metaParts.push(entry.source);
  const meta = document.createElement('span');
  meta.className = 'brain-memory-list-item__meta';
  meta.textContent = metaParts.join(' · ');

  btn.append(title, meta);
  row.append(btn);
  return row;
}

function bindMemoryListActions(): void {
  if (listBindingsDone) return;
  listBindingsDone = true;

  const onClick = (ev: Event) => {
    const selectBtn = (ev.target as HTMLElement).closest(
      '[data-memory-select]',
    ) as HTMLButtonElement | null;
    if (selectBtn?.dataset.memorySelect) {
      selectMemoryEntry(selectBtn.dataset.memorySelect);
      return;
    }

    const editBtn = (ev.target as HTMLElement).closest(
      '[data-memory-edit]',
    ) as HTMLButtonElement | null;
    if (editBtn?.dataset.memoryEdit) {
      const entry = cachedEntries.find((e) => e.id === editBtn.dataset.memoryEdit);
      if (entry) showMemoryEditPane(entry);
      return;
    }

    const target = (ev.target as HTMLElement).closest(
      '[data-memory-remove]',
    ) as HTMLButtonElement | null;
    if (!target?.dataset.memoryRemove) return;

    const id = target.dataset.memoryRemove;
    void (async () => {
      if (!(await appConfirm('Delete this memory entry?', { confirmLabel: 'Delete', danger: true }))) {
        return;
      }
      const ok = await deleteMemoryEntry(id);
      if (ok) {
        if (selectedMemoryId === id) selectedMemoryId = null;
        setStatus('ok', 'Memory entry deleted');
        await refreshMemoryEntriesList();
        return;
      }
      setStatus('err', 'Delete failed. Open or restart Minnow.');
    })();
  };

  document.getElementById('brainMemoryList')?.addEventListener('click', onClick);
  document.getElementById('brainMemoryDetailPane')?.addEventListener('click', onClick);
}

// ── Forms ────────────────────────────────────────────────────────────────────

function bindMemoryAddForm(): void {
  if (addFormBound) return;
  addFormBound = true;

  const form = document.getElementById('brainMemoryAddForm') as HTMLFormElement | null;
  const errEl = document.getElementById('brainMemoryAddError');
  const resetBtn = document.getElementById('brainMemoryAddReset');
  const cancelBtn = document.getElementById('brainMemoryAddCancel');

  resetBtn?.addEventListener('click', () => clearMemoryAddForm());

  cancelBtn?.addEventListener('click', () => {
    const resumeId = editingMemoryId ?? selectedMemoryId;
    clearMemoryAddForm();
    if (resumeId) selectMemoryEntry(resumeId);
    else if (cachedEntries.length) selectMemoryEntry(cachedEntries[0].id);
    else showMemoryEmptyPane();
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const titleInput = document.getElementById('brainMemoryAddTitle') as HTMLInputElement | null;
      const bodyInput = document.getElementById('brainMemoryAddBody') as HTMLTextAreaElement | null;
      const tagsInput = document.getElementById('brainMemoryAddTags') as HTMLInputElement | null;

      const title = titleInput?.value.trim() ?? '';
      const body = bodyInput?.value ?? '';
      const bodyTrimmed = body.trim();

      if (!title || !bodyTrimmed) {
        if (errEl) {
          errEl.textContent = 'Title and body are required.';
          errEl.classList.remove('hidden');
        }
        return;
      }

      const bodyBytes = new TextEncoder().encode(body).length;
      if (bodyBytes > MEMORY_BODY_MAX_BYTES) {
        if (errEl) {
          errEl.textContent = 'Body exceeds 32 KB. Shorten the text and try again.';
          errEl.classList.remove('hidden');
        }
        setStatus('err', 'Memory body too large (max 32 KB)');
        return;
      }

      const tags = parseMemoryTagsInput(tagsInput?.value ?? '');

      if (editingMemoryId) {
        const updated = await updateMemoryEntry(editingMemoryId, {
          title,
          body,
          tags,
        });
        if (!updated) {
          if (errEl) {
            errEl.textContent = 'Save failed. Open or restart Minnow and try again.';
            errEl.classList.remove('hidden');
          }
          setStatus('err', 'Could not save. Open or restart Minnow and try again.');
          return;
        }

        if (errEl) errEl.classList.add('hidden');
        const savedId = editingMemoryId;
        clearMemoryAddForm();
        selectedMemoryId = savedId;
        setStatus('ok', `Updated memory “${updated.title}”`);
        await refreshMemoryEntriesList();
        return;
      }

      const entry = await createMemoryEntry({
        title,
        body,
        tags,
        source: 'user',
      });

      if (!entry) {
        if (errEl) {
          errEl.textContent = 'Save failed. Open or restart Minnow and try again.';
          errEl.classList.remove('hidden');
        }
        setStatus('err', 'Could not save. Open or restart Minnow and try again.');
        return;
      }

      if (errEl) errEl.classList.add('hidden');
      clearMemoryAddForm();
      selectedMemoryId = entry.id;
      setStatus('ok', `Saved memory “${entry.title}”`);
      await refreshMemoryEntriesList();
      showMemorySavedToast(memorySavedPayloadFromEntry(entry, body), {
        onReject: async () => {
          const rejected = await deleteMemoryEntry(entry.id);
          if (rejected) {
            if (selectedMemoryId === entry.id) selectedMemoryId = null;
            await refreshMemoryEntriesList();
          }
          return rejected;
        },
      });
    })();
  });
}

async function hydrateToggles(): Promise<void> {
  const enableEl = document.getElementById('brainMemoryEnabled') as HTMLInputElement | null;
  if (enableEl) {
    enableEl.checked = await fetchMemoryEnabled();
  }

}

function bindMemoriesSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  document.getElementById('brainMemoryAddOpen')?.addEventListener('click', () => {
    clearMemoryAddForm();
    showMemoryComposePane('add');
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
      setStatus('ok', enableEl.checked ? 'Memory enabled' : 'Memory disabled');
    } else {
      setStatus('err', 'Memory settings require Minnow running locally');
    }
  });

  document.getElementById('brainMemoryBackup')?.addEventListener('click', async () => {
    const id = await backupMemory();
    setStatus(
      id ? 'ok' : 'err',
      id ? `Memory backup: ${id}` : 'Backup failed. Open or restart Minnow.',
    );
  });

  document.getElementById('brainMemoryClear')?.addEventListener('click', async () => {
    if (
      !(await appConfirm('Clear all memory entries?', {
        confirmLabel: 'Clear',
        danger: true,
      }))
    ) {
      return;
    }
    const ok = await clearMemory(true);
    setStatus(
      ok ? 'ok' : 'err',
      ok ? 'Memory cleared (archived)' : 'Clear failed. Open or restart Minnow.',
    );
    if (ok) {
      selectedMemoryId = null;
      await refreshMemoryEntriesList();
    }
  });

  bindMemoryAddForm();
}

// ── Refresh ──────────────────────────────────────────────────────────────────

async function refreshMemoryEntriesList(): Promise<void> {
  const countEl = document.getElementById('brainMemoryEntryCount');
  const hintEl = document.getElementById('brainMemoryServerHint');
  const listEl = document.getElementById('brainMemoryList');
  const offlineEl = document.getElementById('brainMemoryOffline');
  const addOpenBtn = document.getElementById('brainMemoryAddOpen') as HTMLButtonElement | null;
  if (!countEl || !hintEl || !listEl) return;

  const refreshGen = ++memoryListRefreshGen;
  const isStale = () => refreshGen !== memoryListRefreshGen;

  listEl.replaceChildren();
  bindMemoryListActions();

  const status = await fetchMemoryStatus();
  if (isStale()) return;
  const online = !!status;
  offlineEl?.classList.toggle('hidden', online);
  addOpenBtn?.toggleAttribute('disabled', !online);

  if (!status) {
    countEl.textContent = '— entries';
    hintEl.textContent = 'Open Minnow for memory API';
    cachedEntries = [];
    selectedMemoryId = null;
    const offline = document.createElement('p');
    offline.className = 'brain-memory-list__note';
    offline.textContent = 'Open Minnow to view and manage stored memories.';
    listEl.append(offline);
    showMemoryEmptyPane();
    return;
  }

  const count = status.entryCount;
  countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
  hintEl.textContent = status.home ? status.home : 'Server connected';

  const entries = await fetchMemoryEntries(true);
  if (isStale()) return;
  if (!entries) {
    cachedEntries = [];
    const err = document.createElement('p');
    err.className = 'brain-memory-list__note';
    err.textContent = 'Could not load memory entries.';
    listEl.append(err);
    showMemoryEmptyPane();
    return;
  }

  cachedEntries = sortMemoryEntries(entries);

  if (!cachedEntries.length) {
    selectedMemoryId = null;
    const empty = document.createElement('p');
    empty.className = 'brain-memory-list__note';
    empty.textContent = 'No memory entries yet.';
    listEl.append(empty);
    showMemoryEmptyPane();
    return;
  }

  if (selectedMemoryId && !cachedEntries.some((e) => e.id === selectedMemoryId)) {
    selectedMemoryId = null;
  }
  if (!selectedMemoryId) {
    selectedMemoryId = cachedEntries[0].id;
  }

  for (const entry of cachedEntries) {
    listEl.append(renderMemoryListItem(entry));
  }

  selectMemoryEntry(selectedMemoryId);
}

/** Load Brain memories section: toggles, entries, backup/clear. */
export async function renderMemoriesSection(): Promise<void> {
  bindMemoryListActions();
  bindMemoriesSection();
  await hydrateToggles();
  await refreshMemoryEntriesList();
}
