import '../styles/product-wiki.css';

import {
  fetchProductWikiCatalog,
  fetchProductWikiPage,
  searchProductWiki,
  type ProductWikiEntry,
  type ProductWikiSearchHit,
} from '../product-wiki/client';
import { iconHtml } from './icon';
import { compareProductWikiEntries } from '../product-wiki/nav-order.mjs';
import { renderProductWikiMarkdown } from './product-wiki-markdown';
import { closeShellOverlay, isShellOverlayOpen, openShellOverlay, shellOverlayClosed } from './shell-overlay-state';

const DEFAULT_PAGE_PATH = 'documentation/manual/README.md';
const REPOSITORY_EDIT_BASE =
  'https://github.com/HenriGrimm/Minnow/edit/main/';
let initialized = false;
let returnHash = '#/desktop';
let catalog: ProductWikiEntry[] = [];
let activePath = DEFAULT_PAGE_PATH;
let searchTimer: number | undefined;
let tocObserver: IntersectionObserver | undefined;

/** Decode a stable page path from the product-wiki hash route. */
export function productWikiPathFromHash(hash: string): string | null {
  const match = hash.match(/^#\/wiki(?:\/(.+))?$/u);
  if (!match) return null;
  if (!match[1]) return DEFAULT_PAGE_PATH;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return DEFAULT_PAGE_PATH;
  }
}

/** Build a breadcrumb trail from a documentation path. */
function buildPathBreadcrumb(path: string): HTMLElement {
  const row = document.createElement('p');
  row.className = 'product-wiki__doc-path';
  const segments = path.replace(/^documentation\/?/u, '').split('/').filter(Boolean);
  if (!segments.length) {
    const root = document.createElement('span');
    root.textContent = 'documentation';
    row.append(root);
    return row;
  }
  const root = document.createElement('span');
  root.textContent = 'documentation';
  row.append(root);
  for (const segment of segments) {
    const sep = document.createElement('span');
    sep.className = 'product-wiki__doc-path-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '/';
    const crumb = document.createElement('span');
    crumb.textContent = segment;
    row.append(sep, crumb);
  }
  return row;
}

/** Sticky table of contents from in-article headings. */
function renderArticleToc(articleBody: HTMLElement): void {
  const toc = document.getElementById('productWikiArticleToc');
  const list = document.getElementById('productWikiTocList');
  if (!toc || !list) return;

  tocObserver?.disconnect();
  tocObserver = undefined;
  list.replaceChildren();

  const headings = articleBody.querySelectorAll('h2, h3');
  if (headings.length < 2) {
    toc.classList.add('hidden');
    return;
  }

  toc.classList.remove('hidden');
  for (const heading of headings) {
    const id = heading.id;
    if (!id) continue;
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = `product-wiki__toc-link${heading.tagName === 'H3' ? ' is-depth-3' : ''}`;
    link.href = `#${id}`;
    link.textContent = heading.textContent?.trim() ?? id;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.append(link);
    list.append(li);
  }

  if (typeof IntersectionObserver === 'undefined') return;

  const links = [...list.querySelectorAll<HTMLAnchorElement>('.product-wiki__toc-link')];
  tocObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (!visible.length) return;
      const activeId = visible[0].target.id;
      for (const link of links) {
        const match = link.getAttribute('href') === `#${activeId}`;
        link.classList.toggle('is-active', match);
      }
    },
    { root: document.getElementById('productWikiArticle'), rootMargin: '-20% 0px -70% 0px', threshold: 0 },
  );
  headings.forEach((heading) => tocObserver?.observe(heading));
}

/** Footer link to edit the page in the repository. */
function renderSourceFooter(path: string): void {
  const footer = document.getElementById('productWikiArticleFooter');
  if (!footer) return;
  footer.replaceChildren();
  const relative = path.replace(/^documentation\//u, '');
  const anchor = document.createElement('a');
  anchor.className = 'product-wiki__source-link';
  anchor.href = `${REPOSITORY_EDIT_BASE}${path}`;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = `Edit ${relative} on GitHub`;
  footer.append(anchor);
}

/** Build the overlay once and return its root. */
function ensureProductWikiRoot(): HTMLElement {
  const existing = document.getElementById('productWikiOverlay');
  if (existing) return existing;

  const root = document.createElement('section');
  root.id = 'productWikiOverlay';
  root.className = 'product-wiki hidden';
  root.setAttribute('aria-label', 'Minnow wiki — User manual');
  root.innerHTML = `
    <header class="product-wiki__header">
      <div class="product-wiki__identity">
        <button id="productWikiNavToggle" class="product-wiki__icon-button product-wiki__nav-toggle" type="button" aria-label="Toggle wiki navigation" aria-expanded="false">${iconHtml('menu', { size: 17 })}</button>
        <span class="product-wiki__mark" aria-hidden="true">?</span>
        <div class="product-wiki__identity-text">
          <strong>Minnow wiki</strong>
          <span>User manual</span>
        </div>
      </div>
      <label class="product-wiki__search">
        ${iconHtml('search', { size: 16 })}
        <span class="visually-hidden">Search the Minnow user manual</span>
        <input id="productWikiSearch" type="search" autocomplete="off" placeholder="Search setup, apps, settings, troubleshooting…" />
        <kbd>Ctrl K</kbd>
      </label>
    </header>
    <div class="product-wiki__body">
      <nav id="productWikiNav" class="product-wiki__nav" aria-label="Wiki pages">
        <div id="productWikiNavContent" class="product-wiki__nav-content" aria-live="polite"></div>
      </nav>
      <button id="productWikiNavScrim" class="product-wiki__scrim" type="button" aria-label="Close wiki navigation"></button>
      <main id="productWikiArticle" class="product-wiki__article" tabindex="-1">
        <div class="product-wiki__article-grid">
          <div class="product-wiki__article-main">
            <header id="productWikiArticleMeta" class="product-wiki__doc-header"></header>
            <article id="productWikiArticleBody" aria-live="polite"></article>
            <footer id="productWikiArticleFooter" class="product-wiki__article-footer"></footer>
          </div>
          <nav id="productWikiArticleToc" class="product-wiki__toc hidden" aria-label="On this page">
            <p class="product-wiki__toc-label">On this page</p>
            <ul id="productWikiTocList" class="product-wiki__toc-list"></ul>
          </nav>
        </div>
      </main>
    </div>
  `;
  (document.getElementById('osStage') ?? document.body).appendChild(root);
  bindProductWiki(root);
  return root;
}

/** Navigate to a page while preserving a reloadable deep link. */
function navigateToProductWikiPage(path: string): void {
  const next = `#/wiki/${encodeURIComponent(path)}`;
  if (window.location.hash !== next) window.location.hash = next;
  else void renderProductWikiPage(path);
}

/** Render the grouped catalog navigation. */
function renderCatalogNavigation(entries: ProductWikiEntry[]): void {
  const host = document.getElementById('productWikiNavContent');
  if (!host) return;
  host.replaceChildren();
  const sections = new Map<string, ProductWikiEntry[]>();
  const orderedEntries = [...entries].sort(compareProductWikiEntries);
  for (const entry of orderedEntries) {
    const rows = sections.get(entry.section) ?? [];
    rows.push(entry);
    sections.set(entry.section, rows);
  }
  for (const [section, rows] of sections) {
    const group = document.createElement('section');
    group.className = 'product-wiki__nav-group';
    const heading = document.createElement('h2');
    heading.textContent = section;
    group.appendChild(heading);
    for (const entry of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'product-wiki__nav-page';
      button.dataset.path = entry.path;
      button.setAttribute('aria-current', entry.path === activePath ? 'page' : 'false');
      const title = document.createElement('strong');
      title.textContent = entry.title;
      const summary = document.createElement('span');
      summary.className = 'product-wiki__nav-page-summary';
      summary.textContent = entry.summary;
      button.append(title, summary);
      button.addEventListener('click', () => navigateToProductWikiPage(entry.path));
      group.appendChild(button);
    }
    host.appendChild(group);
  }
}

/** Render ranked full-text search hits in the navigation rail. */
function renderSearchResults(query: string, hits: ProductWikiSearchHit[]): void {
  const host = document.getElementById('productWikiNavContent');
  if (!host) return;
  host.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'product-wiki__results-heading';
  heading.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} for “${query}”`;
  host.appendChild(heading);
  if (!hits.length) {
    const empty = document.createElement('p');
    empty.className = 'product-wiki__empty';
    empty.textContent = 'Try a feature name, setting, command, or error message.';
    host.appendChild(empty);
    return;
  }
  for (const hit of hits) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'product-wiki__result';
    const section = document.createElement('span');
    section.className = 'product-wiki__result-section';
    section.textContent = hit.section;
    const title = document.createElement('strong');
    title.textContent = hit.title;
    const excerpt = document.createElement('span');
    excerpt.textContent = hit.excerpt;
    button.append(section, title, excerpt);
    button.addEventListener('click', () => navigateToProductWikiPage(hit.path));
    host.appendChild(button);
  }
}

/** Show a compact loading or failure state in the article pane. */
function renderArticleState(message: string, error = false): void {
  const meta = document.getElementById('productWikiArticleMeta');
  const body = document.getElementById('productWikiArticleBody');
  const footer = document.getElementById('productWikiArticleFooter');
  const toc = document.getElementById('productWikiArticleToc');
  if (meta) meta.replaceChildren();
  if (footer) footer.replaceChildren();
  toc?.classList.add('hidden');
  if (!body) return;
  body.className = error ? 'product-wiki__state is-error' : 'product-wiki__state';
  body.textContent = message;
}

/** Load and render one documentation page. */
async function renderProductWikiPage(path: string): Promise<void> {
  activePath = path;
  renderArticleState('Loading page…');
  renderCatalogNavigation(catalog);
  try {
    const page = await fetchProductWikiPage(path);
    const meta = document.getElementById('productWikiArticleMeta');
    const body = document.getElementById('productWikiArticleBody');
    if (!meta || !body || activePath !== path) return;

    meta.replaceChildren();
    const eyebrow = document.createElement('p');
    eyebrow.className = 'product-wiki__doc-eyebrow';
    eyebrow.textContent = page.section;
    const title = document.createElement('h1');
    title.className = 'product-wiki__doc-title';
    title.textContent = page.title;
    meta.append(eyebrow, title, buildPathBreadcrumb(page.path));

    renderProductWikiMarkdown(body, page.content, page.path, navigateToProductWikiPage);
    renderArticleToc(body);
    renderSourceFooter(page.path);
    document.getElementById('productWikiArticle')?.scrollTo({ top: 0 });
    closeMobileNavigation();
  } catch (error) {
    renderArticleState(
      error instanceof Error ? error.message : 'The wiki page could not be loaded.',
      true,
    );
  }
}

/** Run full-text search after a short input debounce. */
async function updateProductWikiSearch(query: string): Promise<void> {
  const normalized = query.trim();
  if (!normalized) {
    renderCatalogNavigation(catalog);
    return;
  }
  const host = document.getElementById('productWikiNavContent');
  if (host) host.textContent = 'Searching…';
  try {
    const hits = await searchProductWiki(normalized);
    const current = (document.getElementById('productWikiSearch') as HTMLInputElement | null)?.value.trim();
    if (current === normalized) renderSearchResults(normalized, hits);
  } catch (error) {
    if (host) host.textContent = error instanceof Error ? error.message : 'Search failed.';
  }
}

/** Close the navigation drawer on compact layouts. */
function closeMobileNavigation(): void {
  const root = document.getElementById('productWikiOverlay');
  root?.classList.remove('is-nav-open');
  document.getElementById('productWikiNavToggle')?.setAttribute('aria-expanded', 'false');
}

/** Bind overlay controls once. */
function bindProductWiki(root: HTMLElement): void {
  root.querySelector('#productWikiNavScrim')?.addEventListener('click', closeMobileNavigation);
  root.querySelector('#productWikiNavToggle')?.addEventListener('click', () => {
    const open = root.classList.toggle('is-nav-open');
    document.getElementById('productWikiNavToggle')?.setAttribute('aria-expanded', String(open));
  });
  const search = root.querySelector<HTMLInputElement>('#productWikiSearch');
  search?.addEventListener('input', () => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void updateProductWikiSearch(search.value), 180);
  });
}

/** Synchronize overlay visibility and article state from the hash route. */
async function syncProductWikiFromHash(): Promise<void> {
  const path = productWikiPathFromHash(window.location.hash);
  const root = ensureProductWikiRoot();
  if (!path) {
    shellOverlayClosed('wiki');
    root.classList.add('hidden');
    void import('./preview-electron-visibility').then((m) => m.scheduleElectronPreviewHostVisibilitySync());
    return;
  }
  if (!isShellOverlayOpen('wiki')) openShellOverlay('wiki', closeProductWiki);
  root.classList.remove('hidden');
  void import('./preview-electron-visibility').then((m) => m.scheduleElectronPreviewHostVisibilitySync());
  if (!catalog.length) {
    try {
      catalog = await fetchProductWikiCatalog();
    } catch (error) {
      renderArticleState(error instanceof Error ? error.message : 'The wiki is unavailable.', true);
      return;
    }
  }
  renderCatalogNavigation(catalog);
  await renderProductWikiPage(path);
}

/** Initialize the in-app product wiki overlay and keyboard search shortcut. */
export function initProductWiki(): void {
  if (initialized) return;
  initialized = true;
  ensureProductWikiRoot();
  window.addEventListener('hashchange', () => void syncProductWikiFromHash());
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && isShellOverlayOpen('wiki')) {
      event.preventDefault();
      closeProductWiki();
      document.querySelector<HTMLElement>('[data-shell-overlay="wiki"]')?.focus();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'k') return;
    if (productWikiPathFromHash(window.location.hash) === null) return;
    event.preventDefault();
    document.getElementById('productWikiSearch')?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!isShellOverlayOpen('wiki')) return;
    const target = event.target as Element | null;
    if (target?.closest('#productWikiOverlay, [data-shell-overlay]')) return;
    closeProductWiki();
  });
  void syncProductWikiFromHash();
}

/** Open the official product wiki from any Minnow surface. */
export function openProductWiki(path = DEFAULT_PAGE_PATH): void {
  if (!isShellOverlayOpen('wiki')) closeShellOverlay();
  if (productWikiPathFromHash(window.location.hash) === null) {
    returnHash = window.location.hash || '#/desktop';
  }
  openShellOverlay('wiki', closeProductWiki);
  navigateToProductWikiPage(path);
}

/** Close the overlay and restore the surface that opened it. */
export function closeProductWiki(): void {
  shellOverlayClosed('wiki');
  document.getElementById('productWikiOverlay')?.classList.add('hidden');
  closeMobileNavigation();
  if (productWikiPathFromHash(window.location.hash) !== null) window.location.hash = returnHash;
  void import('./preview-electron-visibility').then((m) => m.scheduleElectronPreviewHostVisibilitySync());
}
