import '../styles/scc-actions.css';
import { actionApi, type Release } from '../state/actions-api';
import {
  button, chip, el, emptyState, errorStrip, listNavigator, relativeTime, skeletonRows,
  type SccContext, type SccView,
} from './scc-shared';
import { actionHeader, actionRow } from './scc-action-layout';
import { renderReleaseNotesMarkdown } from './release-notes-markdown';
import {
  field,
  labeled,
  operationButton,
  remoteOptions,
  select,
  statusLine,
  textArea,
} from './scc-action-form';
import { confirmAction as appConfirm } from './scc-action-form';
import { createReleaseWorkflowTrigger } from './scc-release-workflow';

export function createReleasesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-actions scc-releases');
  const toolbar = el('div', 'scc-list-view__toolbar');
  const split = el('div', 'scc-split');
  const listCol = el('div', 'scc-split__list');
  const list = el('div', 'scc-split__list-body');
  const detail = el('div', 'scc-split__detail scc-action-detail');
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
  const listCount = el('span', 'scc-actions__count');
  const search = field('Search loaded releases');
  const filter = select('Release status', [
    { value: 'all', label: 'All releases' },
    { value: 'draft', label: 'Drafts' },
    { value: 'prerelease', label: 'Prereleases' },
    { value: 'published', label: 'Published' },
  ]);
  search.placeholder = 'Search loaded releases';
  const releaseWorkflow = createReleaseWorkflowTrigger(ctx);
  root.append(actionHeader('Releases', 'Release notes, downloads, and drafts for this repository.', [
    releaseWorkflow.button,
    button({ label: 'Refresh', icon: 'refresh', onClick: () => void refresh(false, true) }),
    button({ label: 'New release', variant: 'primary', onClick: () => void create() }),
  ]), split);
  toolbar.append(search, filter, listCount);
  search.addEventListener('input', renderList);
  filter.addEventListener('change', renderList);
  function renderList() {
    const focusedId = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.id
      : undefined;
    const visible = rows.filter(
      (r) =>
        `${r.title} ${r.tag}`.toLowerCase().includes(search.value.toLowerCase()) &&
        (filter.value === 'all' ||
          (filter.value === 'draft' && r.draft) ||
          (filter.value === 'prerelease' && r.prerelease) ||
          (filter.value === 'published' && !r.draft && !r.prerelease)),
    );
    listCount.textContent = `${visible.length} of ${rows.length} loaded`;
    const nodes: HTMLElement[] = visible.map((r) => {
      const state = r.draft ? 'Draft' : r.prerelease ? 'Prerelease' : 'Published';
      const row = actionRow(r.title, `${r.tag} · ${relativeTime(r.publishedAt || r.createdAt) || 'Unpublished'} · ${r.assets.length} assets`, () => void show(r.id));
      row.dataset.id = String(r.id);
      row.setAttribute('aria-label', `${r.title} · ${r.tag} · ${state}`);
      row.setAttribute('aria-pressed', String(selected === r.id));
      row.classList.toggle('is-selected', selected === r.id);
      row.prepend(chip(state, r.draft ? 'draft' : undefined));
      return row;
    });
    if (!nodes.length)
      nodes.push(
        emptyState({
          title: rows.length ? 'No matching releases' : 'No releases yet',
          body: rows.length ? 'Try another search or status filter.' : 'Create a draft to prepare notes and upload your build.',
        }),
      );
    if (hasMore)
      nodes.push(
        button({
          label: 'Load more',
          onClick: () => {
            void refresh(true);
          },
        }),
      );
    list.replaceChildren(...nodes);
    if (focusedId) list.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
  }
  let hasMore = false;
  async function refresh(append = false, reloadDetail = false) {
    const request = ++listRequest;
    const capturedCwd = cwd;
    const nextPage = append ? page + 1 : 1;
    if (!rows.length) list.replaceChildren(skeletonRows(6));
    const result = await actionApi('releaseList', { cwd, page: nextPage });
    if (destroyed || request !== listRequest || capturedCwd !== cwd) return;
    if (!result.ok) {
      list.replaceChildren(errorStrip(result.error || 'Could not load releases', () => void refresh(append)));
      return;
    }
    repo = result.repo || repo;
    hasMore = Boolean(result.hasMore);
    page = nextPage;
    if (append) rows = [...new Map([...rows, ...(result.releases || [])].map(r => [r.id, r])).values()];
    else {
      rows = result.releases || [];
      page = 1;
    }
    renderList();
    if (!selected && !creating && rows.length) void show(rows[0]!.id);
    else if (reloadDetail && selected && !creating && detail.querySelector<HTMLElement>('.scc-release__editor')?.hidden !== false) void show(selected);
  }
  async function create() {
    creating = true;
    selected = 0;
    renderList();
    const g = ++generation;
    const capturedCwd = cwd;
    detail.replaceChildren(el('h2', undefined, 'New draft release'), el('p', undefined, repo));
    const status = statusLine();
    detail.append(status);
    try {
      const [tags, branches] = await Promise.all([
        remoteOptions(cwd, 'tags'),
        remoteOptions(cwd, 'branches'),
      ]);
      if (destroyed || g !== generation) return;
      const mode = select('Tag source', [
        { value: 'existing', label: 'Existing tag' },
        { value: 'new', label: 'Create a new tag' },
      ]);
      const tag = select(
        'Existing tag',
        tags.map((t) => ({ value: t.name, label: t.name })),
      );
      const newTag = field('New tag');
      const target = select(
        'Target commit',
        branches
          .filter((b) => b.sha)
          .map((b) => ({ value: b.sha!, label: `${b.name} · ${b.sha}` })),
      );
      const title = field('Title');
      const notes = textArea('Release notes');
      const prerelease = field('Prerelease', '', 'checkbox');
      const existingHost = labeled('Existing tag', tag);
      const newHost = labeled('New tag', newTag);
      const targetHost = labeled('Target remote commit', target);
      const toggle = () => {
        existingHost.hidden = mode.value !== 'existing';
        newHost.hidden = targetHost.hidden = mode.value !== 'new';
      };
      mode.addEventListener('change', toggle);
      toggle();
      detail.append(
        labeled('Tag source', mode),
        existingHost,
        newHost,
        targetHost,
        labeled('Title', title),
        labeled('Notes', notes),
        labeled('Prerelease', prerelease),
      );
      detail.append(
        operationButton(
          'Generate notes',
          status,
          () =>
            actionApi('releaseNotes', {
              cwd: capturedCwd,
              tag: mode.value === 'new' ? newTag.value : tag.value,
              target: mode.value === 'new' ? target.value : undefined,
            }),
          (result) => {
            if (destroyed || g !== generation) return;
            title.value = result.title || title.value;
            notes.value = result.body || '';
          },
        ),
      );
      detail.append(
        operationButton(
          'Create draft',
          status,
          () =>
            actionApi('releaseCreate', {
              cwd: capturedCwd,
              tag: mode.value === 'new' ? newTag.value : tag.value,
              createTag: mode.value === 'new',
              target: target.value,
              title: title.value,
              body: notes.value,
              prerelease: prerelease.checked,
            }),
          (result) => {
            if (destroyed || g !== generation) return;
            void refresh();
            if (result.release) void show(result.release.id);
          },
        ),
      );
      detail.append(status);
    } catch (error) {
      status.textContent = String(error);
    }
  }
  async function show(id: number) {
    creating = false;
    const g = ++generation;
    selected = id;
    renderList();
    detail.replaceChildren(skeletonRows(5));
    const capturedCwd = cwd;
    const result = await actionApi('releaseView', { cwd: capturedCwd, id });
    if (destroyed || g !== generation || selected !== id) return;
    if (!result.ok || !result.release) {
      detail.replaceChildren(emptyState({ title: 'Could not open this release', body: 'Retry the request, or refresh the release list if it was deleted.' }), errorStrip(result.error || 'Release unavailable', () => void show(id)));
      return;
    }
    const release = result.release;
    repo = result.repo || repo;
    const status = statusLine();
    const writable = result.canWrite && !release.immutable;
    const head = el('header', 'scc-release__head');
    const facts = el('div', 'scc-release__facts');
    facts.append(chip(release.draft ? 'Draft' : release.prerelease ? 'Prerelease' : 'Published'), chip(release.tag), el('span', undefined, release.target));
    const date = release.publishedAt || release.createdAt;
    if (date && Number.isFinite(Date.parse(date))) facts.append(el('span', undefined, new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })));
    head.append(el('p', 'scc-action-context', repo), el('h2', undefined, release.title), facts);
    detail.replaceChildren(head);
    const link = el('a', 'scc-btn', 'Open on GitHub');
    link.href = release.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const actions = el('div', 'scc-release__actions');
    actions.append(link);
    detail.append(actions);
    const preview = el('section', 'scc-release__notes scc-prdetail__body');
    preview.setAttribute('aria-label', 'Release notes');
    if (release.body.trim()) renderReleaseNotesMarkdown(preview, release.body);
    else preview.append(el('p', 'scc-action-context', 'No release notes were added.'));
    detail.append(el('h3', undefined, 'Release notes'), preview);
    const editor = el('section', 'scc-release__editor scc-action-form');
    editor.hidden = true;
    detail.append(editor);
    const title = field('Title', release.title);
    const notes = textArea('Release notes', release.body);
    const prerelease = field('Prerelease', '', 'checkbox');
    prerelease.checked = release.prerelease;
    const latest = select('Latest release', [
      { value: '', label: 'Keep current setting' },
      { value: 'true', label: 'Mark as latest' },
      { value: 'false', label: 'Do not mark as latest' },
      { value: 'legacy', label: 'Let GitHub choose' },
    ]);
    title.disabled = notes.disabled = prerelease.disabled = latest.disabled = !writable;
    editor.append(
      labeled('Title', title),
      labeled('Notes', notes),
      labeled('Prerelease', prerelease),
      labeled('Latest', latest),
    );
    const edit = (publish = false) =>
      actionApi('releaseEdit', {
        cwd: capturedCwd,
        id,
        title: title.value,
        body: notes.value,
        prerelease: prerelease.checked,
        latest: latest.value || undefined,
        publish,
      });
    if (writable) {
      const editButton = button({ label: 'Edit release', onClick: () => {
        editor.hidden = !editor.hidden;
        editButton.setAttribute('aria-expanded', String(!editor.hidden));
        if (!editor.hidden) title.focus();
      } });
      editButton.setAttribute('aria-expanded', 'false');
      actions.append(editButton);
      editor.append(
        operationButton(
          'Save changes',
          status,
          () => edit(),
          (result) => {
            if (destroyed || g !== generation) return;
            if (result.release) {
              head.querySelector('h2')!.textContent = result.release.title;
              renderReleaseNotesMarkdown(preview, result.release.body);
            }
            void refresh();
          },
        ),
      );
      editor.append(
        operationButton(
          'Generate notes',
          status,
          () =>
            actionApi('releaseNotes', {
              cwd: capturedCwd,
              tag: release.tag,
              target: release.target,
            }),
          (result) => {
            if (destroyed || g !== generation) return;
            notes.value = result.body || '';
          },
        ),
      );
      if (release.draft)
        editor.append(
          operationButton(
            'Publish release',
            status,
            async () =>
              (await appConfirm({
                title: 'Publish release',
                message: `Publish ${repo} · ${release.tag}?`,
                confirmLabel: 'Publish',
              }))
                ? edit(true)
                : { ok: true, note: 'Cancelled' },
            (result) => {
              if (destroyed || g !== generation) return;
              if (result.release) void show(id);
              void refresh();
            },
          ),
        );
      const danger = el('details', 'scc-release__danger');
      danger.append(el('summary', undefined, 'Delete release'),
        operationButton(
          'Delete release',
          status,
          async () =>
            (await appConfirm({
              title: 'Delete release',
              message: `Delete ${repo} · ${release.tag} and its assets? The Git tag will be retained.`,
              danger: true,
            }))
              ? actionApi('releaseDelete', { cwd: capturedCwd, id })
              : { ok: true, note: 'Cancelled' },
          (result) => {
            if (destroyed || g !== generation) return;
            if (result.note !== 'Cancelled') {
              detail.replaceChildren();
              selected = 0;
              void refresh();
            }
          },
        ),
      );
      editor.append(danger, status);
    } else
      detail.append(
        el(
          'p',
          undefined,
          release.immutable
            ? 'This release is immutable.'
            : 'Your account does not have permission to edit releases.',
        ),
      );
    detail.append(el('h3', undefined, `Assets (${release.assets.length})`));
    const directory = field('Download directory', '.');
    if (release.assets.length) detail.append(labeled('Download directory (relative to worktree)', directory));
    const assets = el('div', 'scc-action-assets');
    detail.append(assets);
    for (const asset of release.assets) {
      const row = el('div', 'scc-action-asset');
      const assetStatus = statusLine();
      row.append(
        el(
          'p',
          undefined,
          `${asset.name} · ${(asset.size / 1024 / 1024).toFixed(1)} MiB · ${asset.downloads} downloads`,
        ),
        operationButton('Download', assetStatus, () =>
          actionApi('releaseAssetDownload', {
            cwd: capturedCwd,
            id,
            assetId: asset.id,
            directory: directory.value,
          }),
        ),
      );
      if (writable)
        row.append(
          operationButton(
            'Delete asset',
            assetStatus,
            async () =>
              (await appConfirm({
                message: `Delete ${asset.name} from ${repo} · ${release.tag}?`,
                danger: true,
              }))
                ? actionApi('releaseAssetDelete', { cwd: capturedCwd, id, assetId: asset.id })
                : { ok: true, note: 'Cancelled' },
            (result) => {
              if (destroyed || g !== generation) return;
              if (result.note !== 'Cancelled') row.remove();
            },
          ),
        );
      row.append(assetStatus);
      assets.append(row);
    }
    if (writable) {
      const upload = field('Asset path');
      const transferStatus = statusLine();
      detail.append(
        labeled('Upload file (relative to worktree)', upload),
        operationButton(
          'Upload asset',
          transferStatus,
          async () => {
            const name = upload.value.replaceAll('\\', '/').split('/').pop();
            const collision = release.assets.some((a) => a.name === name);
            if (
              collision &&
              !(await appConfirm({
                message: `Replace ${name} in ${repo} · ${release.tag}?`,
                danger: true,
                confirmLabel: 'Replace',
              }))
            )
              return { ok: true, note: 'Cancelled' };
            return actionApi('releaseAssetUpload', {
              cwd: capturedCwd,
              id,
              path: upload.value,
              replace: collision,
            });
          },
          (result) => {
            if (destroyed || g !== generation) return;
            if (result.note !== 'Cancelled') void show(id);
          },
        ),
        transferStatus,
      );
    }
  }
  void refresh();
  detail.append(
    emptyState({
      title: 'Select a release',
      body: 'Review release notes, manage assets, or create a draft.',
    }),
  );
  return {
    root,
    onKey: listNavigator({ getRows: () => [...list.querySelectorAll<HTMLElement>('.scc-action-row')] }),
    refresh: async () => {
      if (cwd !== ctx.getCwd()) {
        releaseWorkflow.close();
        cwd = ctx.getCwd();
        generation++;
        listRequest++;
        rows = [];
        repo = '';
        selected = 0;
        creating = false;
        detail.replaceChildren();
        await refresh();
      }
    },
    destroy: () => {
      releaseWorkflow.destroy();
      destroyed = true;
      generation++;
      listRequest++;
      root.remove();
    },
  };
}
