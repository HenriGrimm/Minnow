import '../styles/scc-actions.css';
import { actionApi, type Release } from '../state/actions-api';
import { button, el, emptyState, type SccContext, type SccView } from './scc-shared';
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
import { requestActionWorkflow } from './scc-actions';

export function createReleasesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-actions');
  const toolbar = el('div', 'scc-list-view__toolbar');
  const split = el('div', 'scc-split');
  const list = el('div', 'scc-split__list');
  const detail = el('div', 'scc-split__detail scc-action-detail');
  split.append(list, detail);
  root.append(toolbar, split);
  let cwd = ctx.getCwd();
  let generation = 0;
  let destroyed = false;
  let page = 1;
  let rows: Release[] = [];
  let repo = '';
  let selected = 0;
  const search = field('Search loaded releases');
  const filter = select('Release status', [
    { value: 'all', label: 'All releases' },
    { value: 'draft', label: 'Drafts' },
    { value: 'prerelease', label: 'Prereleases' },
    { value: 'published', label: 'Published' },
  ]);
  search.placeholder = 'Search loaded releases';
  toolbar.append(
    search,
    filter,
    button({ label: 'New release', onClick: () => void create() }),
    button({
      label: 'Run release workflow',
      onClick: () => {
        requestActionWorkflow();
        ctx.goTo('checks');
      },
    }),
    button({ label: 'Refresh', onClick: () => void refresh() }),
  );
  search.addEventListener('input', renderList);
  filter.addEventListener('change', renderList);
  function renderList() {
    const visible = rows.filter(
      (r) =>
        `${r.title} ${r.tag}`.toLowerCase().includes(search.value.toLowerCase()) &&
        (filter.value === 'all' ||
          (filter.value === 'draft' && r.draft) ||
          (filter.value === 'prerelease' && r.prerelease) ||
          (filter.value === 'published' && !r.draft)),
    );
    const nodes: HTMLElement[] = visible.map((r) =>
      button({
        label: `${r.title} · ${r.tag} · ${r.draft ? 'Draft' : r.prerelease ? 'Prerelease' : 'Published'}`,
        onClick: () => void show(r.id),
      }),
    );
    if (!nodes.length)
      nodes.push(
        emptyState({
          title: 'No matching releases',
          body: 'Create a draft or load more releases.',
        }),
      );
    if (hasMore)
      nodes.push(
        button({
          label: 'Load more',
          onClick: () => {
            page++;
            void refresh(true);
          },
        }),
      );
    list.replaceChildren(...nodes);
  }
  let hasMore = false;
  async function refresh(append = false) {
    const g = generation;
    const result = await actionApi('releaseList', { cwd, page: append ? page : 1 });
    if (destroyed || g !== generation) return;
    if (!result.ok) {
      list.replaceChildren(el('p', undefined, result.error));
      return;
    }
    repo = result.repo || repo;
    hasMore = Boolean(result.hasMore);
    if (append) rows = [...rows, ...(result.releases || [])];
    else {
      rows = result.releases || [];
      page = 1;
    }
    renderList();
  }
  async function create() {
    selected = 0;
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
    const g = ++generation;
    selected = id;
    const capturedCwd = cwd;
    const result = await actionApi('releaseView', { cwd: capturedCwd, id });
    if (destroyed || g !== generation || selected !== id) return;
    if (!result.ok || !result.release) {
      detail.replaceChildren(el('p', undefined, result.error));
      return;
    }
    const release = result.release;
    repo = result.repo || repo;
    const status = statusLine();
    const writable = result.canWrite && !release.immutable;
    detail.replaceChildren(
      el('h2', undefined, release.title),
      el('p', undefined, `${repo} · ${release.tag} · ${release.target}`),
      el(
        'p',
        undefined,
        `${release.draft ? 'Draft' : release.prerelease ? 'Prerelease' : 'Published'} · ${release.publishedAt || release.createdAt}`,
      ),
    );
    const link = el('a', 'scc-btn', 'Open on GitHub');
    link.href = release.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    detail.append(link);
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
    detail.append(
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
      detail.append(
        operationButton(
          'Save changes',
          status,
          () => edit(),
          () => {
            if (!destroyed && g === generation) void refresh();
          },
        ),
      );
      detail.append(
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
        detail.append(
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
      detail.append(
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
              void refresh();
            }
          },
        ),
      );
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
    detail.append(el('h3', undefined, 'Assets'));
    const assets = el('div', 'scc-action-assets');
    detail.append(assets);
    for (const asset of release.assets) {
      const row = el('div', 'scc-action-asset');
      const assetStatus = statusLine();
      const directory = field('Download directory', '.');
      row.append(
        el(
          'p',
          undefined,
          `${asset.name} · ${(asset.size / 1024 / 1024).toFixed(1)} MiB · ${asset.downloads} downloads`,
        ),
        labeled('Download directory (relative to worktree)', directory),
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
    detail.append(status);
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
    refresh: async () => {
      if (cwd !== ctx.getCwd()) {
        cwd = ctx.getCwd();
        generation++;
        rows = [];
        detail.replaceChildren();
        await refresh();
      }
    },
    destroy: () => {
      destroyed = true;
      generation++;
      root.remove();
    },
  };
}
