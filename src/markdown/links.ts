/**
 * Keep markdown <a href> from navigating the SPA.
 *
 * Hash links like `#overview` would replace `#/app/code/…` and remount the
 * shell. Relative files like `foo.md` would load Vite's index.html and fully
 * reload. This module classifies hrefs, stamps GitHub-style heading ids, and
 * intercepts clicks in capture phase.
 */

const HTTP_URL_RE = /^https?:\/\//i;

/** Surfaces whose anchors must not escape to the browser chrome. */
const MARKDOWN_LINK_ROOT_SELECTOR = [
  '.msg-bubble',
  '.thoughts-content',
  '.file-viewer-markdown-preview',
  '.product-wiki-markdown',
  '.brain-markdown',
].join(', ');

/** In-app hashes the OS router / Brain wiki already own — do not steal them. */
const IN_APP_HASH_RE = /^(#\/|#brain-wiki\/)/u;

const DANGEROUS_SCHEME_RE = /^(javascript|data|vbscript|file):/iu;

const LINE_FRAGMENT_RE = /^L(\d+)(?:-L?(\d+))?$/iu;

const MAIL_OR_TEL_RE = /^(mailto|tel):/iu;

export type MarkdownLineRange = { startLine: number; endLine: number };

let routingBound = false;

/** Heading fragment to scroll after the target markdown file mounts. */
let pendingHeadingScroll: { path: string; headingId: string } | null = null;

/** Test seam so click tests do not load the file viewer module. */
let workspaceOpenerForTests:
  | ((
      path: string,
      headingId?: string,
      lineRange?: MarkdownLineRange,
    ) => void)
  | null = null;

export type MarkdownLinkAction =
  | { type: 'pass' }
  | { type: 'ignore' }
  | { type: 'http'; url: string }
  | { type: 'heading'; id: string }
  | {
      type: 'workspace';
      path: string;
      headingId?: string;
      lineRange?: MarkdownLineRange;
    };

// ── Heading ids (GitHub slugger: first "Foo" → foo, second → foo-1) ──────────

/** GitHub-flavored heading slug so `[text](#overview)` matches rendered h1–h6. */
export function githubHeadingSlug(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return slug || 'section';
}

/** Assign unique heading ids; streaming callers supply counts from their stable prefix. */
export function applyMarkdownHeadingIds(root: ParentNode, used = new Map<string, number>()): string[] {
  const bases: string[] = [];
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const base = githubHeadingSlug(heading.textContent ?? '');
    bases.push(base);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    heading.id = seen === 0 ? base : `${base}-${seen}`;
  });
  return bases;
}

/**
 * New-tab fallback so a missed click handler cannot replace this window.
 * In-app hashes stay in-place so `#/wiki/…` and `#/app/…` still route.
 */
export function hardenMarkdownAnchors(root: ParentNode): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!href || IN_APP_HASH_RE.test(href) || MAIL_OR_TEL_RE.test(href)) return;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  });
}

/** Heading ids + new-tab fallback after marked → DOMPurify. */
export function decorateRenderedMarkdown(root: ParentNode): void {
  applyMarkdownHeadingIds(root);
  hardenMarkdownAnchors(root);
  // Bind even if boot has not run yet (tests, HMR) — init is idempotent.
  initMarkdownLinkRouting();
}

// ── Path resolve ─────────────────────────────────────────────────────────────

/** Directory of a workspace-relative file (`README.md` → `.`). */
export function markdownSourceDir(sourcePath: string | null | undefined): string {
  const normalized = (sourcePath ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') return '.';
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '.' : normalized.slice(0, idx);
}

/**
 * Resolve a markdown href against the current file's directory.
 * Returns null when the path would leave the workspace (`../` past root).
 */
export function resolveMarkdownWorkspacePath(
  href: string,
  sourcePath: string | null | undefined,
): string | null {
  const raw = href.trim();
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURI(raw);
  } catch {
    decoded = raw;
  }

  const withoutQuery = decoded.split('?')[0] ?? decoded;
  const pathPart = (withoutQuery.split('#')[0] ?? withoutQuery).replace(/\\/g, '/');
  if (!pathPart || DANGEROUS_SCHEME_RE.test(pathPart) || MAIL_OR_TEL_RE.test(pathPart)) {
    return null;
  }
  if (HTTP_URL_RE.test(pathPart) || pathPart.startsWith('//')) return null;
  if (/^[a-zA-Z]:/.test(pathPart)) return null;

  const fromRoot = pathPart.startsWith('/');
  const startDir = fromRoot ? '.' : markdownSourceDir(sourcePath);
  const baseParts = startDir === '.' ? [] : startDir.split('/').filter(Boolean);
  const relParts = pathPart.replace(/^\/+/u, '').split('/');
  const out: string[] = fromRoot ? [] : [...baseParts];

  for (const part of relParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    if (part.includes('\0')) return null;
    out.push(part);
  }

  return out.join('/') || null;
}

export function parseMarkdownLineFragment(fragment: string): MarkdownLineRange | null {
  const match = LINE_FRAGMENT_RE.exec(fragment.trim());
  if (!match) return null;
  const startLine = Number(match[1]);
  if (!Number.isFinite(startLine) || startLine < 1) return null;
  const endRaw = match[2] ? Number(match[2]) : startLine;
  const endLine = Number.isFinite(endRaw) && endRaw >= startLine ? endRaw : startLine;
  return { startLine, endLine };
}

function fragmentFromHref(href: string): string {
  const hashIdx = href.indexOf('#');
  if (hashIdx < 0) return '';
  const queryIdx = href.indexOf('?');
  const end = queryIdx > hashIdx ? queryIdx : href.length;
  return href.slice(hashIdx + 1, end);
}

/** Classify a raw `href` attribute (not the resolved `anchor.href` URL). */
export function classifyMarkdownHref(
  href: string,
  sourcePath: string | null | undefined,
): MarkdownLinkAction {
  const trimmed = href.trim();
  if (!trimmed) return { type: 'ignore' };
  if (DANGEROUS_SCHEME_RE.test(trimmed)) return { type: 'ignore' };
  if (MAIL_OR_TEL_RE.test(trimmed)) return { type: 'pass' };

  if (trimmed.startsWith('//')) {
    try {
      const base =
        typeof window !== 'undefined' && window.location?.href
          ? window.location.href
          : 'https://minnow.local/';
      const url = new URL(trimmed, base).href;
      return HTTP_URL_RE.test(url) ? { type: 'http', url } : { type: 'ignore' };
    } catch {
      return { type: 'ignore' };
    }
  }

  if (HTTP_URL_RE.test(trimmed)) {
    try {
      return { type: 'http', url: new URL(trimmed).href };
    } catch {
      return { type: 'http', url: trimmed };
    }
  }

  if (trimmed.startsWith('#')) {
    if (IN_APP_HASH_RE.test(trimmed)) return { type: 'pass' };
    let id = trimmed.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep raw fragment */
    }
    if (!id) return { type: 'ignore' };
    return { type: 'heading', id };
  }

  const path = resolveMarkdownWorkspacePath(trimmed, sourcePath);
  if (!path) return { type: 'ignore' };

  const fragment = fragmentFromHref(trimmed);
  let decodedFragment = fragment;
  try {
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    decodedFragment = fragment;
  }

  const lineRange = decodedFragment ? parseMarkdownLineFragment(decodedFragment) : null;
  if (lineRange) {
    return { type: 'workspace', path, lineRange };
  }
  if (decodedFragment) {
    return { type: 'workspace', path, headingId: decodedFragment };
  }
  return { type: 'workspace', path };
}

// ── Click routing ────────────────────────────────────────────────────────────

function markdownRootFor(anchor: Element): Element | null {
  return anchor.closest(MARKDOWN_LINK_ROOT_SELECTOR);
}

function sourcePathForAnchor(anchor: Element): string | null {
  const host = anchor.closest('[data-md-source-path]');
  const path = host?.getAttribute('data-md-source-path')?.trim();
  return path || null;
}

function findHeadingInRoot(root: ParentNode, id: string): Element | null {
  if (!id) return null;
  for (const el of root.querySelectorAll('[id]')) {
    if (el.id === id) return el;
  }
  return null;
}

/** Scroll a heading into view inside its overflow preview, not the window. */
export function scrollMarkdownHeading(root: ParentNode, headingId: string): boolean {
  applyMarkdownHeadingIds(root);
  const el = findHeadingInRoot(root, headingId);
  if (!el || typeof (el as HTMLElement).scrollIntoView !== 'function') return false;
  (el as HTMLElement).scrollIntoView({ block: 'start' });
  return true;
}

/** Consume a pending cross-file heading scroll after the target preview mounts. */
export function takePendingMarkdownHeading(path: string): string | null {
  if (!pendingHeadingScroll || pendingHeadingScroll.path !== path) return null;
  const id = pendingHeadingScroll.headingId;
  pendingHeadingScroll = null;
  return id;
}

/**
 * Scroll a heading in an already-mounted preview (tab was already open, so
 * mountMarkdownPreview did not run again). Leaves the pending scroll in place
 * when the preview is not on screen yet so a later mount can consume it.
 */
export function scrollMountedMarkdownHeading(path: string): void {
  if (!pendingHeadingScroll || pendingHeadingScroll.path !== path) return;
  if (typeof document === 'undefined') return;
  const headingId = pendingHeadingScroll.headingId;
  const previews = document.querySelectorAll<HTMLElement>(
    '.file-viewer-markdown-preview[data-md-source-path]',
  );
  for (const preview of previews) {
    if (preview.dataset.mdSourcePath !== path) continue;
    pendingHeadingScroll = null;
    scrollMarkdownHeading(preview, headingId);
    return;
  }
}

function queueHeadingScroll(path: string, headingId: string): void {
  pendingHeadingScroll = { path, headingId };
}

function openWorkspaceFromMarkdown(
  path: string,
  headingId?: string,
  lineRange?: MarkdownLineRange,
): void {
  if (workspaceOpenerForTests) {
    if (headingId) queueHeadingScroll(path, headingId);
    workspaceOpenerForTests(path, headingId, lineRange);
    return;
  }
  if (headingId) queueHeadingScroll(path, headingId);
  void import('../ui/file-viewer').then(async (mod) => {
    await mod.openFileInViewer(
      path,
      lineRange
        ? { asCode: true, initialLineRange: lineRange }
        : undefined,
    );
    if (headingId) scrollMountedMarkdownHeading(path);
  });
}

/** Intercept markdown link activation so the SPA hash and origin stay put. */
export function handleMarkdownLinkClick(event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 && event.type !== 'auxclick') return;
  if (event.type === 'auxclick' && event.button !== 1) return;

  const target = event.target;
  if (!target || typeof target !== 'object' || !('closest' in target)) return;

  const anchor = (target as Element).closest('a[href]');
  if (!anchor || anchor.tagName !== 'A') return;

  const root = markdownRootFor(anchor);
  if (!root) return;

  // Use the raw attribute. `anchor.href` is already resolved against the SPA origin.
  const href = anchor.getAttribute('href') ?? '';
  const action = classifyMarkdownHref(href, sourcePathForAnchor(anchor));

  if (action.type === 'pass') return;

  event.preventDefault();
  event.stopPropagation();

  if (action.type === 'ignore') return;

  if (action.type === 'http') {
    void import('../ui/minnow-browser-links').then((mod) => {
      mod.openUrlInMinnowBrowser(action.url);
    });
    return;
  }

  if (action.type === 'heading') {
    scrollMarkdownHeading(root, action.id);
    return;
  }

  openWorkspaceFromMarkdown(action.path, action.headingId, action.lineRange);
}

/** Install capture-phase listeners once at boot. */
export function initMarkdownLinkRouting(): void {
  if (routingBound || typeof document === 'undefined') return;
  routingBound = true;
  document.addEventListener('click', handleMarkdownLinkClick, true);
  document.addEventListener('auxclick', handleMarkdownLinkClick, true);
}

/** Reset module state (tests). */
export function resetMarkdownLinkRoutingForTests(): void {
  routingBound = false;
  pendingHeadingScroll = null;
  workspaceOpenerForTests = null;
}

/** Override workspace-file opens in unit tests. */
export function setMarkdownWorkspaceOpenerForTests(
  opener:
    | ((
        path: string,
        headingId?: string,
        lineRange?: MarkdownLineRange,
      ) => void)
    | null,
): void {
  workspaceOpenerForTests = opener;
}
