import '../styles/scc-actions.css';
import '../styles/scc-releases.css';
import { actionApi, type Release } from '../state/actions-api';
import { createIcon } from './icon';
import {
  button, el, emptyState, errorStrip, listNavigator, skeletonRows, type SccContext, type SccView,
} from './scc-shared';
import { actionHeader } from './scc-action-layout';
import { renderReleaseNotesMarkdown } from './release-notes-markdown';
import { confirmAction, field, labeled, operationButton, remoteOptions, select, statusLine, textArea } from './scc-action-form';
import { createReleaseWorkflowTrigger } from './scc-release-workflow';
import { createReleaseDraftWriter } from './release-draft-writer';
import { createReleaseAssets } from './scc-release-assets';

const releaseDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function dateLabel(release: Release): string {
  const date = Date.parse(release.publishedAt || release.createdAt);
  return Number.isFinite(date) ? releaseDate.format(date) : '';
}

function releaseState(release: Release): string {
  return release.draft ? 'Draft' : release.prerelease ? 'Prerelease' : 'Published';
}

function stateLabel(release: Release): HTMLElement {
  const state = releaseState(release);
  return el('span', `scc-release__state scc-release__state--${state.toLowerCase()}`, state);
}

function renderNotes(container: HTMLElement, body: string): void {
  if (body.trim()) renderReleaseNotesMarkdown(container, body);
  else container.replaceChildren(el('p', 'scc-release__muted', 'No release notes yet.'));
}

function notesEditor(value = '') {
  const root = el('div', 'scc-release__notes-editor');
  const bar = el('div', 'scc-release__notes-bar');
  const modes = el('div', 'scc-release__modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Release notes view');
  const notes = textArea('Release notes', value);
  notes.placeholder = 'Describe what changed in this release.';
  const preview = el('div', 'scc-release__notes scc-prdetail__body');
  preview.setAttribute('aria-label', 'Release notes preview');
  const update = () => renderNotes(preview, notes.value);
  const write = button({ label: 'Write', variant: 'ghost', onClick: () => setPreview(false) });
  const read = button({ label: 'Preview', variant: 'ghost', onClick: () => setPreview(true) });
  function setPreview(active: boolean) {
    if (active) update();
    notes.hidden = active;
    preview.hidden = !active;
    write.setAttribute('aria-pressed', String(!active));
    read.setAttribute('aria-pressed', String(active));
  }
  modes.append(write, read);
  bar.append(el('h3', undefined, 'Release notes'), modes);
  root.append(bar, notes, preview);
  update();
  setPreview(false);
  return { root, notes, update };
}

function releaseDetails(release: Release): HTMLElement {
  const section = el('section', 'scc-release__side-section');
  const facts = el('dl', 'scc-release__facts');
  facts.append(el('dt', undefined, 'Tag'), el('dd', 'scc-release__ref', release.tag));
  if (release.target) {
    const isSha = /^[a-f0-9]{40}$/i.test(release.target);
    const target = el('dd', 'scc-release__ref', isSha ? release.target.slice(0, 8) : release.target);
    target.title = release.target;
    facts.append(el('dt', undefined, isSha ? 'Commit' : 'Target'), target);
  }
  const date = dateLabel(release);
  if (date) facts.append(el('dt', undefined, release.publishedAt ? 'Published' : 'Created'), el('dd', undefined, date));
  section.append(el('h3', undefined, 'Release details'), facts);
  return section;
}

function prereleaseField(input: HTMLInputElement): HTMLElement {
  const label = el('label', 'scc-release__check');
  label.append(input, el('span', undefined, 'Mark as prerelease'));
  return label;
}

export function createReleasesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-actions scc-releases');
  const toolbar = el('div', 'scc-list-view__toolbar');
  const split = el('div', 'scc-split');
  const listCol = el('section', 'scc-split__list');
  listCol.setAttribute('aria-label', 'Release history');
  const list = el('div', 'scc-split__list-body');
  const detail = el('div', 'scc-split__detail scc-release__detail');
  const content = el('div', 'scc-release__content');
  const back = button({ label: 'All releases', icon: 'chevronLeft', variant: 'ghost', className: 'scc-release__back', onClick: backToList });
  detail.append(back, content);
  listCol.append(toolbar, list);
  split.append(listCol, detail);
  let cwd = ctx.getCwd();
  let generation = 0;
  let destroyed = false;
  let page = 1;
  let rows: Release[] = [];
  let repo = '';
  let selected = 0;
  let listRequest = 0;
  let creating = false;
  let hasMore = false;
  let returnedToList = false;
  let canReloadDetail = () => true;
  let draftWriter: ReturnType<typeof createReleaseDraftWriter> | undefined;
  const listCount = el('span', 'scc-actions__count');
  listCount.setAttribute('role', 'status');
  const search = field('Search loaded releases', '', 'search');
  search.placeholder = 'Search loaded releases';
  const searchBox = el('div', 'scc-release__search');
  searchBox.append(createIcon('search', { size: 14 }), search);
  const filter = select('Release status', [
    { value: 'all', label: 'All statuses' },
    { value: 'draft', label: 'Drafts' },
    { value: 'prerelease', label: 'Prereleases' },
    { value: 'published', label: 'Published' },
  ]);
  const releaseWorkflow = createReleaseWorkflowTrigger(ctx);
  const newRelease = button({ label: 'New release', icon: 'plus', variant: 'primary', onClick: () => {
    if (!creating) void create();
    openDetail();
  } });
  root.append(actionHeader('Releases', '', [
    button({ title: 'Refresh releases', icon: 'refresh', variant: 'ghost', onClick: () => void refresh(false, true) }),
    releaseWorkflow.button,
    newRelease,
  ]), split);
  toolbar.append(searchBox, filter, listCount);
  search.addEventListener('input', renderList);
  filter.addEventListener('change', renderList);

  function openDetail() {
    returnedToList = false;
    root.classList.add('scc-releases--detail');
    if (back.getClientRects().length) back.focus();
  }

  function backToList() {
    returnedToList = true;
    root.classList.remove('scc-releases--detail');
    (list.querySelector<HTMLButtonElement>('.is-selected') ?? search).focus();
  }

  function renderList() {
    const focusedId = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.id : undefined;
    const query = search.value.trim().toLowerCase();
    const visible = rows.filter(r =>
      `${r.title} ${r.tag}`.toLowerCase().includes(query) &&
      (filter.value === 'all' || releaseState(r).toLowerCase() === filter.value),
    );
    listCount.textContent = query || filter.value !== 'all'
      ? `${visible.length} of ${rows.length} loaded`
      : `${rows.length} loaded`;
    const nodes: HTMLElement[] = visible.map(r => {
      const label = `${r.title} · ${r.tag} · ${releaseState(r)}`;
      const row = button({ className: 'scc-action-row scc-release__row', title: label, onClick: () => {
        if (!returnedToList || r.id !== selected) void show(r.id);
        openDetail();
      } });
      row.classList.remove('scc-btn--icon-only');
      row.dataset.id = String(r.id);
      row.setAttribute('aria-pressed', String(selected === r.id));
      row.classList.toggle('is-selected', selected === r.id);
      const top = el('span', 'scc-release__row-top');
      top.append(stateLabel(r));
      const date = dateLabel(r);
      if (date) top.append(el('span', 'scc-release__row-date', date));
      row.append(top, el('span', 'scc-action-row__title', r.title));
      const meta = el('span', 'scc-action-row__meta');
      if (r.title !== r.tag) meta.append(el('span', 'scc-release__ref', r.tag));
      if (r.assets.length) meta.append(el('span', undefined, `${r.assets.length} ${r.assets.length === 1 ? 'asset' : 'assets'}`));
      if (meta.childElementCount) row.append(meta);
      return row;
    });
    if (!nodes.length) nodes.push(emptyState({
      icon: 'tags',
      title: rows.length ? 'No matching releases' : 'No releases yet',
      body: rows.length ? 'Try a different search or status.' : 'Create a draft to prepare notes and attach builds.',
    }));
    if (hasMore) nodes.push(button({ label: 'Load more', onClick: () => void refresh(true) }));
    list.replaceChildren(...nodes);
    if (focusedId) list.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
  }

  async function refresh(append = false, reloadDetail = false) {
    const request = ++listRequest;
    const nextPage = append ? page + 1 : 1;
    if (!rows.length) list.replaceChildren(skeletonRows(6));
    const result = await actionApi('releaseList', { cwd, page: nextPage });
    if (destroyed || request !== listRequest) return;
    if (!result.ok) {
      const error = errorStrip(result.error || 'Could not load releases', () => void refresh(append, reloadDetail));
      if (rows.length) {
        list.querySelector('.scc-error')?.remove();
        list.prepend(error);
      } else list.replaceChildren(error);
      return;
    }
    repo = result.repo || repo;
    hasMore = Boolean(result.hasMore);
    page = nextPage;
    rows = append ? [...new Map([...rows, ...(result.releases || [])].map(r => [r.id, r])).values()] : result.releases || [];
    renderList();
    if (!selected && !creating && rows.length) void show(rows[0]!.id);
    else if (reloadDetail && selected && !creating && canReloadDetail()) void show(selected);
  }

  function renderHeader(title: string, badge?: HTMLElement) {
    const head = el('header', 'scc-release__head');
    const identity = el('div', 'scc-release__identity');
    const titleRow = el('div', 'scc-release__title-row');
    const heading = el('h2', undefined, title);
    titleRow.append(heading);
    if (badge) titleRow.append(badge);
    if (repo) identity.append(el('p', 'scc-release__repo', repo));
    identity.append(titleRow);
    const actions = el('div', 'scc-release__actions');
    head.append(identity, actions);
    content.replaceChildren(head);
    return { heading, actions };
  }

  function resetDetail() {
    draftWriter?.destroy();
    draftWriter = undefined;
    canReloadDetail = () => true;
    detail.scrollTop = 0;
    return ++generation;
  }

  async function create() {
    const g = resetDetail();
    creating = true;
    selected = 0;
    renderList();
    const capturedCwd = cwd;
    renderHeader('New draft release');
    content.append(skeletonRows(5));
    try {
      const [tags, branches] = await Promise.all([remoteOptions(cwd, 'tags'), remoteOptions(cwd, 'branches')]);
      if (destroyed || g !== generation) return;
      renderHeader('New draft release');
      const grid = el('div', 'scc-release__grid');
      const editor = el('section', 'scc-release__editor');
      const sidebar = el('aside', 'scc-release__sidebar');
      const settings = el('section', 'scc-release__side-section');
      const targets = branches.flatMap(b => b.sha ? [{ value: b.sha, label: `${b.name} · ${b.sha.slice(0, 8)}` }] : []);
      const mode = select('Tag source', [
        { value: 'existing', label: 'Existing tag' },
        { value: 'new', label: 'Create a new tag' },
      ], tags.length ? 'existing' : 'new');
      const tag = select('Existing tag', tags.map(t => ({ value: t.name, label: t.name })));
      const newTag = field('New tag');
      newTag.placeholder = 'v1.0.0';
      const target = select('Target commit', [{ value: '', label: 'Select a remote branch commit' }, ...targets]);
      const existingHost = labeled('Existing tag', tag);
      const newHost = labeled('New tag', newTag);
      const targetHost = labeled('Target remote commit', target);
      const title = field('Title');
      title.placeholder = 'Defaults to the tag';
      const { root: notesRoot, notes, update } = notesEditor();
      const prerelease = field('Prerelease', '', 'checkbox');
      const status = statusLine();
      const notesStatus = statusLine();
      const tagArgs = () => ({ cwd: capturedCwd, tag: mode.value === 'new' ? newTag.value.trim() : tag.value, target: mode.value === 'new' ? target.value : undefined });
      const generate = operationButton('Generate with GitHub', notesStatus, () => actionApi('releaseNotes', tagArgs()), result => {
        if (destroyed || g !== generation) return;
        title.value = result.title || title.value;
        notes.value = result.body || '';
        update();
      });
      const submit = operationButton('Create draft', status, () => actionApi('releaseCreate', {
        ...tagArgs(), createTag: mode.value === 'new', title: title.value, body: notes.value, prerelease: prerelease.checked,
      }), result => {
        if (destroyed || g !== generation) return;
        if (result.release) void show(result.release.id);
        void refresh();
      });
      submit.classList.add('scc-btn--primary');
      // operationButton owns the busy state. Recheck the fields at submission time.
      const validate = (event: Event) => {
        const args = tagArgs();
        if (args.tag && (mode.value !== 'new' || args.target)) return;
        event.stopImmediatePropagation();
        status.textContent = !args.tag ? 'Choose or enter a tag.' : 'Select a remote branch commit.';
        const tagInput = mode.value === 'new' ? newTag : tag;
        (args.tag ? target : tagInput).focus();
      };
      for (const control of [generate, submit]) control.addEventListener('click', validate, true);
      const toggle = () => {
        existingHost.hidden = mode.value !== 'existing';
        newHost.hidden = targetHost.hidden = mode.value !== 'new';
      };
      mode.addEventListener('change', toggle);
      toggle();
      const notesActions = el('div', 'scc-release__notes-actions');
      notesActions.append(generate);
      editor.append(labeled('Title', title), notesRoot, notesActions, notesStatus);
      settings.append(el('h3', undefined, 'Tag and target'), labeled('Tag source', mode), existingHost, newHost, targetHost, prereleaseField(prerelease), submit, status);
      sidebar.append(settings);
      grid.append(editor, sidebar);
      content.append(grid);
    } catch (error) {
      if (destroyed || g !== generation) return;
      renderHeader('New draft release');
      content.append(errorStrip(error instanceof Error ? error.message : String(error), () => void create()));
    }
  }

  async function show(id: number) {
    const g = resetDetail();
    creating = false;
    selected = id;
    renderList();
    content.replaceChildren(skeletonRows(5));
    const capturedCwd = cwd;
    const isCurrent = () => !destroyed && g === generation;
    const result = await actionApi('releaseView', { cwd: capturedCwd, id });
    if (!isCurrent()) return;
    if (!result.ok || !result.release) {
      content.replaceChildren(emptyState({ title: 'Could not open this release', body: 'Retry the request or refresh the release list.' }), errorStrip(result.error || 'Release unavailable', () => void show(id)));
      return;
    }
    const release = result.release;
    repo = result.repo || repo;
    const releaseRepo = repo;
    const writable = Boolean(result.canWrite && !release.immutable);
    let badge = stateLabel(release);
    const { heading, actions } = renderHeader(release.title, badge);
    if (release.url) {
      const link = el('a', 'scc-btn scc-btn--ghost', 'Open on GitHub');
      link.append(createIcon('externalLink', { size: 13 }));
      link.href = release.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    const grid = el('div', 'scc-release__grid');
    const main = el('div', 'scc-release__main');
    const sidebar = el('aside', 'scc-release__sidebar');
    const overview = el('section', 'scc-release__overview');
    const preview = el('div', 'scc-release__notes scc-prdetail__body');
    renderNotes(preview, release.body);
    overview.append(el('h3', undefined, 'Release notes'), preview);
    if (!release.draft || !writable) main.append(overview);
    sidebar.append(releaseDetails(release));
    grid.append(main, sidebar, createReleaseAssets({ release, repo: releaseRepo, cwd: capturedCwd, writable, isCurrent,
      onChange: assets => {
        rows = rows.map(row => row.id === id ? { ...row, assets } : row);
        renderList();
      },
    }));
    content.append(grid);
    if (!writable) {
      sidebar.append(el('p', 'scc-release__access', release.immutable ? 'This release is immutable.' : 'Your account has read-only access to this release.'));
      return;
    }

    const editor = el('section', 'scc-release__editor');
    const settings = el('section', 'scc-release__side-section scc-release__publishing');
    editor.hidden = settings.hidden = !release.draft;
    main.append(editor);
    sidebar.append(settings);
    const status = statusLine();
    const notesStatus = statusLine();
    const title = field('Title', release.title);
    const { root: notesRoot, notes, update } = notesEditor(release.body);
    const prerelease = field('Prerelease', '', 'checkbox');
    prerelease.checked = release.prerelease;
    const latest = select('Latest release', [
      { value: '', label: 'Keep current setting' },
      { value: 'true', label: 'Mark as latest' },
      { value: 'false', label: 'Do not mark as latest' },
      { value: 'legacy', label: 'Let GitHub choose' },
    ]);
    const edit = (publish = false) => actionApi('releaseEdit', {
      cwd: capturedCwd, id, title: title.value, body: notes.value, prerelease: prerelease.checked, latest: latest.value || undefined, publish,
    });
    const snapshot = () => JSON.stringify([title.value, notes.value, prerelease.checked, latest.value]);
    let saved = snapshot();
    canReloadDetail = () => editor.hidden && snapshot() === saved;
    editor.append(labeled('Title', title), notesRoot);
    const generate = operationButton('Generate with GitHub', notesStatus,
      () => actionApi('releaseNotes', { cwd: capturedCwd, tag: release.tag, target: release.target }),
      response => {
        if (!isCurrent()) return;
        notes.value = response.body || '';
        update();
      });
    const save = operationButton('Save changes', status, async () => {
      const submitted = snapshot();
      const response = await edit();
      if (response.ok && isCurrent()) {
        saved = submitted;
        const updated = response.release;
        if (updated) {
          heading.textContent = updated.title;
          const updatedBadge = stateLabel(updated);
          badge.replaceWith(updatedBadge);
          badge = updatedBadge;
          renderNotes(preview, updated.body);
          rows = rows.map(row => row.id === id ? { ...updated, assets: row.assets } : row);
          renderList();
        }
      }
      return response;
    });
    const publishingActions = el('div', 'scc-release__publishing-actions');
    const operations = [save, generate];
    publishingActions.append(save);
    if (release.draft) {
      const publish = operationButton('Publish release', status, async () =>
        await confirmAction({ title: 'Publish release', message: `Publish ${releaseRepo} · ${release.tag}?`, confirmLabel: 'Publish' })
          ? edit(true) : { ok: true, note: 'Cancelled' },
      response => {
        if (!isCurrent() || response.note === 'Cancelled') return;
        void show(id);
        void refresh();
      });
      publish.classList.add('scc-btn--primary');
      publishingActions.append(publish);
      operations.push(publish);
    } else {
      save.classList.add('scc-btn--primary');
      const editButton = button({ label: 'Edit release', icon: 'edit', onClick: () => {
        editor.hidden = settings.hidden = !editor.hidden;
        overview.hidden = !editor.hidden;
        editButton.setAttribute('aria-expanded', String(!editor.hidden));
        editButton.querySelector('.scc-btn__label')!.textContent = editor.hidden ? 'Edit release' : 'Close editor';
        if (!editor.hidden) title.focus();
      } });
      editButton.setAttribute('aria-expanded', 'false');
      actions.append(editButton);
    }
    const danger = el('details', 'scc-release__disclosure scc-release__danger');
    const remove = operationButton('Delete release', status, async () =>
      await confirmAction({ title: 'Delete release', message: `Delete ${releaseRepo} · ${release.tag} and its assets? The Git tag will be retained.`, danger: true })
        ? actionApi('releaseDelete', { cwd: capturedCwd, id }) : { ok: true, note: 'Cancelled' },
    response => {
      if (!isCurrent() || response.note === 'Cancelled') return;
      resetDetail();
      selected = 0;
      rows = rows.filter(row => row.id !== id);
      content.replaceChildren(emptyState({ title: 'Release deleted', body: 'The Git tag was retained.' }));
      backToList();
      void refresh();
    });
    remove.classList.add('scc-btn--danger');
    operations.push(remove);
    danger.append(el('summary', undefined, 'Delete release'), remove);
    settings.append(el('h3', undefined, 'Publishing'), prereleaseField(prerelease), labeled('Latest release', latest), publishingActions, status, danger);
    if (release.draft) {
      draftWriter = createReleaseDraftWriter({ cwd: capturedCwd, id, notes, onNotesChange: update, operations, generate });
      editor.append(draftWriter.root);
    } else {
      const notesActions = el('div', 'scc-release__notes-actions');
      notesActions.append(generate);
      editor.append(notesActions);
    }
    editor.append(notesStatus);
  }

  content.append(emptyState({ icon: 'tags', title: 'Select a release', body: 'Open a release to review notes and assets.' }));
  void refresh();
  const navigateList = listNavigator({ getRows: () => [...list.querySelectorAll<HTMLElement>('.scc-action-row')] });
  return {
    root,
    onKey: event => list.contains(event.target as Node) && navigateList(event),
    refresh: async () => {
      if (cwd !== ctx.getCwd()) {
        resetDetail();
        releaseWorkflow.close();
        cwd = ctx.getCwd();
        rows = [];
        repo = '';
        selected = 0;
        hasMore = false;
        creating = false;
        returnedToList = false;
        root.classList.remove('scc-releases--detail');
        content.replaceChildren(emptyState({ icon: 'tags', title: 'Select a release', body: 'Open a release to review notes and assets.' }));
        await refresh();
      }
    },
    destroy: () => {
      resetDetail();
      releaseWorkflow.destroy();
      destroyed = true;
      listRequest++;
      root.remove();
    },
  };
}
