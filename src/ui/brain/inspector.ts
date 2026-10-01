import { appAlert, appConfirm, appPrompt } from '../app-dialog';
/**
 * Brain graph inspector: title, tags, summary, backlinks, body preview, actions.
 */

import { fetchBrainPage, deleteBrainPage, deleteBrainArchive } from '../../brain/client';
import type { BrainPageMeta } from '../../brain/types';
import { computeBrainBacklinks } from './tree-utils';
import { renderBrainEmptyState, renderBrainLoading } from './empty-state';
import { renderBrainMarkdown } from './wikilink-markdown';
import { iconHtml } from '../icon';

export type InspectorNavigateFn = (relPath: string) => void;
export type InspectorEditFn = (relPath: string) => void;
export type InspectorDeletedFn = () => void | Promise<void>;

// ── Archive ──────────────────────────────────────────────────────────────────

/** Parse workspace/chat ids from an archive page path. */
function parseArchiveFromPath(relPath: string): { workspaceKey: string; chatId: string } | null {
  const match = relPath.match(/^workspaces\/([^/]+)\/archive\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  return { workspaceKey: match[1], chatId: match[2] };
}

/** Compact relative age for the inspector metric strip. */
function formatAge(iso: string | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Resolve a raw wikilink target to a catalog page, tolerating a missing `.md`. */
function resolveLinkTarget(
  catalogPages: BrainPageMeta[],
  raw: string,
): BrainPageMeta | null {
  const key = raw.replace(/\\/g, '/').replace(/\.md$/i, '');
  return (
    catalogPages.find((p) => p.path.replace(/\\/g, '/').replace(/\.md$/i, '') === key) ?? null
  );
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/** One label/value cell in the inspector metric strip. */
function buildMetric(label: string, value: string): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'brain-inspector__metric';
  const name = document.createElement('span');
  name.className = 'brain-inspector__metric-label';
  name.textContent = label;
  const num = document.createElement('span');
  num.className = 'brain-inspector__metric-value';
  num.textContent = value;
  cell.append(name, num);
  return cell;
}

/** One group of relations (backlinks, outbound links, similar pages). */
function buildRelationGroup(
  title: string,
  glyph: string,
  entries: Array<{ label: string; path?: string; missing?: boolean }>,
  navigate: InspectorNavigateFn,
): HTMLElement | null {
  if (!entries.length) return null;
  const group = document.createElement('div');
  group.className = 'brain-relation-group';

  const head = document.createElement('p');
  head.className = 'brain-relation-group__title';
  const mark = document.createElement('span');
  mark.className = 'brain-relation-group__glyph';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = glyph;
  head.append(mark, document.createTextNode(title));
  const count = document.createElement('span');
  count.className = 'brain-relation-group__count';
  count.textContent = String(entries.length);
  head.append(count);
  group.append(head);

  const list = document.createElement('ul');
  list.className = 'brain-relation-list';
  for (const entry of entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brain-relation';
    btn.textContent = entry.label;
    btn.title = entry.path ?? entry.label;
    if (entry.missing || !entry.path) {
      btn.disabled = true;
      btn.dataset.missing = 'true';
      btn.title = `${entry.label} — no page at this path`;
    } else {
      btn.addEventListener('click', () => navigate(entry.path!));
    }
    li.append(btn);
    list.append(li);
  }
  group.append(list);
  return group;
}

/** Content mount inside #brainInspector (resize handle stays as a sibling). */
function getInspectorContent(mount: HTMLElement): HTMLElement {
  let content = mount.querySelector('.brain-inspector__content') as HTMLElement | null;
  if (!content) {
    content = document.createElement('div');
    content.className = 'brain-inspector__content';
    mount.append(content);
  }
  return content;
}

// ── Inspector render ─────────────────────────────────────────────────────────

/** Mount or refresh the right-hand node inspector for a wiki page. */
export async function renderBrainInspector(
  mount: HTMLElement,
  relPath: string,
  catalogPages: BrainPageMeta[],
  navigate: InspectorNavigateFn,
  onEdit: InspectorEditFn,
  onDeleted?: InspectorDeletedFn,
): Promise<void> {
  mount.classList.add('is-open');
  mount.setAttribute('aria-hidden', 'false');
  const content = getInspectorContent(mount);
  content.replaceChildren();

  const inner = document.createElement('div');
  inner.className = 'brain-inspector__inner';
  content.append(inner);

  const loadingMount = document.createElement('div');
  inner.append(loadingMount);
  renderBrainLoading(loadingMount, 'Loading page…');

  const page = await fetchBrainPage(relPath);
  inner.replaceChildren();

  if (!page) {
    renderBrainEmptyState(inner, {
      icon: 'file',
      title: 'Page unavailable',
      message: `Could not load ${relPath}.`,
    });
    return;
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'brain-inspector__close icon-btn';
  closeBtn.setAttribute('aria-label', 'Close inspector');
  closeBtn.innerHTML =
    iconHtml('close');
  closeBtn.addEventListener('click', () => closeBrainInspector(mount));
  inner.append(closeBtn);

  const head = document.createElement('header');
  head.className = 'brain-inspector__head';

  const kindLine = document.createElement('p');
  kindLine.className = 'brain-inspector__kind';
  const swatch = document.createElement('span');
  swatch.className = 'brain-inspector__kind-dot';
  swatch.setAttribute('aria-hidden', 'true');
  const kindText = document.createElement('span');
  kindText.textContent = page.meta.folder || 'wiki page';
  kindLine.append(swatch, kindText);

  const title = document.createElement('h2');
  title.className = 'brain-inspector__title';
  title.textContent = page.meta.title;
  const pathLine = document.createElement('p');
  pathLine.className = 'brain-inspector__path';
  pathLine.textContent = page.path;
  head.append(kindLine, title, pathLine);

  if (page.meta.tags?.length) {
    const chips = document.createElement('div');
    chips.className = 'brain-inspector__tag-chips brain-chip-row';
    for (const tag of page.meta.tags) {
      const chip = document.createElement('span');
      chip.className = 'brain-chip';
      chip.textContent = tag;
      chips.append(chip);
    }
    head.append(chips);
  }

  if (page.meta.summary?.trim()) {
    const summary = document.createElement('p');
    summary.className = 'brain-inspector__summary';
    summary.textContent = page.meta.summary;
    head.append(summary);
  }

  inner.append(head);

  const backlinks = computeBrainBacklinks(catalogPages, page.path);
  const outbound = (page.meta.links ?? []).map((raw) => {
    const target = resolveLinkTarget(catalogPages, raw);
    return {
      label: target?.title ?? raw,
      path: target?.path,
      missing: !target,
    };
  });
  const similar = (page.meta.similarTo ?? [])
    .map((raw) => resolveLinkTarget(catalogPages, String(raw)))
    .filter((p): p is BrainPageMeta => Boolean(p))
    .map((p) => ({ label: p.title, path: p.path }));

  const metrics = document.createElement('div');
  metrics.className = 'brain-inspector__metrics';
  metrics.append(
    buildMetric('In', String(backlinks.length)),
    buildMetric('Out', String(outbound.length)),
    buildMetric('Tags', String(page.meta.tags?.length ?? 0)),
    buildMetric('Updated', formatAge(page.meta.updatedAt)),
  );
  inner.append(metrics);

  const relations = document.createElement('section');
  relations.className = 'brain-inspector__relations';
  const relTitle = document.createElement('h3');
  relTitle.className = 'brain-section-subtitle';
  relTitle.textContent = 'Connections';
  relations.append(relTitle);

  const groups = [
    buildRelationGroup(
      'Linked from',
      '←',
      backlinks.map((from) => ({
        label: catalogPages.find((p) => p.path === from)?.title ?? from,
        path: from,
      })),
      navigate,
    ),
    buildRelationGroup('Links to', '→', outbound, navigate),
    buildRelationGroup('Similar', '≈', similar, navigate),
  ].filter((g): g is HTMLElement => Boolean(g));

  if (!groups.length) {
    const none = document.createElement('p');
    none.className = 'brain-muted';
    none.textContent = 'Nothing links here yet — this page is an island.';
    relations.append(none);
  } else {
    relations.append(...groups);
  }
  inner.append(relations);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'brain-inspector__body';
  const bodyTitle = document.createElement('h3');
  bodyTitle.className = 'brain-section-subtitle';
  bodyTitle.textContent = 'Page';
  const bodyMarkdown = document.createElement('div');
  bodyMarkdown.className = 'brain-inspector__markdown';
  renderBrainMarkdown(bodyMarkdown, page.body, navigate);
  bodyWrap.append(bodyTitle, bodyMarkdown);
  inner.append(bodyWrap);

  const actions = document.createElement('div');
  actions.className = 'brain-inspector__actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'brain-action-btn is-primary';
  editBtn.textContent = 'Edit page';
  editBtn.addEventListener('click', () => onEdit(page.path));
  actions.append(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'brain-action-btn brain-action-btn--danger';
  deleteBtn.textContent = 'Delete page';
  deleteBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await appConfirm(
        `Delete wiki page "${page.meta.title}"?\n\nPath: ${page.path}\n\nThis cannot be undone.`,
      );
      if (!ok) return;
      const result = await deleteBrainPage(page.path);
      if (!result.ok) {
        await appAlert(result.error ?? 'Delete failed.');
        return;
      }
      closeBrainInspector(mount);
      await onDeleted?.();
    })();
  });
  actions.append(deleteBtn);

  const archiveInfo = parseArchiveFromPath(page.path);
  if (archiveInfo) {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'brain-action-btn brain-action-btn--danger';
    archiveBtn.textContent = 'Delete entire chat archive';
    archiveBtn.addEventListener('click', () => {
      void (async () => {
        const ok = await appConfirm(
          `Delete the entire chat archive for "${archiveInfo.chatId}"?\n\nAll pages under this chat folder will be removed.`,
        );
        if (!ok) return;
        const result = await deleteBrainArchive(
          archiveInfo.chatId,
          archiveInfo.workspaceKey,
        );
        if (!result.ok) {
          await appAlert(result.error ?? 'Archive delete failed.');
          return;
        }
        closeBrainInspector(mount);
        await onDeleted?.();
      })();
    });
    actions.append(archiveBtn);
  }

  inner.append(actions);
}

/** Collapse the inspector panel. */
export function closeBrainInspector(mount: HTMLElement): void {
  mount.classList.remove('is-open');
  mount.setAttribute('aria-hidden', 'true');
  mount.querySelector('.brain-inspector__content')?.replaceChildren();
}
