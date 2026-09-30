import { BrainRevisionConflictError, fetchBrainPage, saveBrainPage } from '../../brain/client';
import { getGraphSelectedPath, setGraphSelectedPath } from './graph-section';
import { renderBrainMarkdown } from './wikilink-markdown';
import {
  memorySavedPayloadFromBrainPage,
  showMemorySavedToast,
} from '../memory-saved-toast';

type EditViewMode = 'source' | 'split' | 'preview';

let bindingsDone = false;
let previewBound = false;
let activeViewMode: EditViewMode = 'split';
let loadedEditPath: string | null = null;
let loadedEditRevision: string | null = null;

function setEditStatus(kind: 'ok' | 'err' | 'spin', message: string): void {
  const el = document.getElementById('brainEditStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
}

// ── Preview ──────────────────────────────────────────────────────────────────

/** Mirror path, title, and tags into the wiki-style preview header. */
function refreshEditPreviewChrome(): void {
  const pathEl = document.getElementById('brainEditPath') as HTMLInputElement | null;
  const titleEl = document.getElementById('brainEditTitle') as HTMLInputElement | null;
  const tagsEl = document.getElementById('brainEditTags') as HTMLInputElement | null;
  const previewTitle = document.getElementById('brainEditPreviewTitle');
  const previewPath = document.getElementById('brainEditPreviewPath');
  const previewTags = document.getElementById('brainEditPreviewTags');

  const path = pathEl?.value.trim().replace(/\\/g, '/') || '—';
  const title = titleEl?.value.trim() || 'Untitled page';
  const tags = (tagsEl?.value ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (previewTitle) previewTitle.textContent = title;
  if (previewPath) previewPath.textContent = path;
  if (previewTags) {
    if (tags.length) {
      previewTags.textContent = tags.map((t) => `#${t}`).join(' ');
      previewTags.classList.remove('hidden');
      previewTags.hidden = false;
    } else {
      previewTags.textContent = '';
      previewTags.classList.add('hidden');
      previewTags.hidden = true;
    }
  }
}

/** Refresh the live markdown preview pane from the body textarea. */
function refreshEditPreview(): void {
  const bodyEl = document.getElementById('brainEditBody') as HTMLTextAreaElement | null;
  const previewEl = document.getElementById('brainEditPreview');
  if (!bodyEl || !previewEl) return;

  refreshEditPreviewChrome();

  const body = bodyEl.value;
  if (!body.trim()) {
    previewEl.replaceChildren();
    previewEl.classList.add('brain-muted');
    previewEl.textContent = 'Start typing in the source pane to see a live preview.';
    return;
  }

  previewEl.classList.remove('brain-muted');
  renderBrainMarkdown(previewEl, body, (path) => {
    void import('../brain-page').then((m) => m.openBrainEditForPath(path));
  });
}

function applyEditViewMode(mode: EditViewMode): void {
  activeViewMode = mode;
  const workspace = document.getElementById('brainEditWorkspace');
  if (workspace) {
    workspace.classList.remove('is-view-source', 'is-view-split', 'is-view-preview');
    workspace.classList.add(`is-view-${mode}`);
  }

  document.querySelectorAll<HTMLButtonElement>('[data-brain-edit-view]').forEach((btn) => {
    const view = btn.dataset.brainEditView as EditViewMode | undefined;
    const pressed = view === mode;
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    btn.classList.toggle('is-active', pressed);
  });
}

// ── Bind ─────────────────────────────────────────────────────────────────────

function bindEditSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  document.getElementById('brainEditLoad')?.addEventListener('click', () => {
    void loadEditForm();
  });

  document.getElementById('brainEditNew')?.addEventListener('click', () => {
    void prepareNewPage();
  });

  document.getElementById('brainEditSave')?.addEventListener('click', () => {
    void saveEditForm();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-brain-edit-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.brainEditView as EditViewMode | undefined;
      if (mode) applyEditViewMode(mode);
    });
  });
}

function bindEditPreview(): void {
  if (previewBound) return;
  previewBound = true;

  const bodyEl = document.getElementById('brainEditBody');
  bodyEl?.addEventListener('input', refreshEditPreview);

  for (const id of ['brainEditPath', 'brainEditTitle', 'brainEditTags']) {
    document.getElementById(id)?.addEventListener('input', refreshEditPreviewChrome);
  }
}

// ── Load save ────────────────────────────────────────────────────────────────

async function loadEditForm(): Promise<void> {
  const pathEl = document.getElementById('brainEditPath') as HTMLInputElement | null;
  const titleEl = document.getElementById('brainEditTitle') as HTMLInputElement | null;
  const tagsEl = document.getElementById('brainEditTags') as HTMLInputElement | null;
  const bodyEl = document.getElementById('brainEditBody') as HTMLTextAreaElement | null;
  if (!pathEl || !titleEl || !tagsEl || !bodyEl) return;

  const relPath = pathEl.value.trim().replace(/\\/g, '/');
  if (!relPath) {
    setEditStatus('err', 'Enter a relative path (e.g. facts/my-note.md).');
    return;
  }

  setEditStatus('spin', 'Loading…');
  const page = await fetchBrainPage(relPath);
  if (!page) {
    loadedEditPath = null;
    loadedEditRevision = null;
    titleEl.value = '';
    tagsEl.value = '';
    bodyEl.value = '';
    refreshEditPreview();
    setEditStatus('ok', 'New page — fill in title and body, then save.');
    return;
  }

  loadedEditPath = page.path;
  loadedEditRevision = page.revision ?? null;
  titleEl.value = page.meta.title;
  tagsEl.value = (page.meta.tags ?? []).join(', ');
  bodyEl.value = page.body;
  refreshEditPreview();
  setEditStatus('ok', `Loaded ${relPath}`);
}

/** Reset the form for manual page creation. */
async function prepareNewPage(): Promise<void> {
  const pathEl = document.getElementById('brainEditPath') as HTMLInputElement | null;
  const titleEl = document.getElementById('brainEditTitle') as HTMLInputElement | null;
  const tagsEl = document.getElementById('brainEditTags') as HTMLInputElement | null;
  const bodyEl = document.getElementById('brainEditBody') as HTMLTextAreaElement | null;
  if (!pathEl || !titleEl || !tagsEl || !bodyEl) return;

  pathEl.value = 'facts/';
  loadedEditPath = null;
  loadedEditRevision = null;
  titleEl.value = '';
  tagsEl.value = '';
  bodyEl.value = '';
  refreshEditPreview();
  setEditStatus('ok', 'New page — enter a path, title, and body, then save.');
  pathEl.focus();
}

async function saveEditForm(): Promise<void> {
  const pathEl = document.getElementById('brainEditPath') as HTMLInputElement | null;
  const titleEl = document.getElementById('brainEditTitle') as HTMLInputElement | null;
  const tagsEl = document.getElementById('brainEditTags') as HTMLInputElement | null;
  const bodyEl = document.getElementById('brainEditBody') as HTMLTextAreaElement | null;
  if (!pathEl || !titleEl || !tagsEl || !bodyEl) return;

  let relPath = pathEl.value.trim().replace(/\\/g, '/');
  if (!relPath) {
    setEditStatus('err', 'Path is required.');
    return;
  }
  if (!relPath.endsWith('.md')) relPath = `${relPath}.md`;
  pathEl.value = relPath;

  const title = titleEl.value.trim();
  const body = bodyEl.value;
  if (!title || !body.trim()) {
    setEditStatus('err', 'Title and body are required.');
    return;
  }

  const tags = tagsEl.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  setEditStatus('spin', 'Saving…');
  let saved;
  try {
    saved = await saveBrainPage({
      path: relPath,
      title,
      body,
      tags,
      source: 'user',
      expectedRevision: loadedEditPath === relPath ? loadedEditRevision : null,
    });
  } catch (error) {
    if (error instanceof BrainRevisionConflictError) {
      setEditStatus('err', 'Page changed since it was loaded. Your draft is kept; reload the page to review the latest version.');
      return;
    }
    throw error;
  }
  if (!saved) {
    setEditStatus('err', 'Save failed. Is Minnow running?');
    return;
  }

  loadedEditPath = saved.path;
  loadedEditRevision = saved.revision ?? null;
  setGraphSelectedPath(relPath);
  setEditStatus('ok', `Saved ${relPath}`);
  showMemorySavedToast(memorySavedPayloadFromBrainPage(saved));
  refreshEditPreview();
}

/** Mount edit section and optionally pre-fill a path from Wiki. */
export async function renderEditSection(prefillPath?: string): Promise<void> {
  bindEditSection();
  bindEditPreview();
  applyEditViewMode(activeViewMode);

  const pathEl = document.getElementById('brainEditPath') as HTMLInputElement | null;
  if (pathEl && prefillPath) {
    pathEl.value = prefillPath;
    if (prefillPath.endsWith('/')) {
      await prepareNewPage();
    } else {
      await loadEditForm();
    }
    return;
  }
  if (pathEl && !pathEl.value.trim()) {
    const fromGraph = getGraphSelectedPath();
    if (fromGraph) pathEl.value = fromGraph;
  }
  refreshEditPreview();
}
