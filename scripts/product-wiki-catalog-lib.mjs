import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { compareProductWikiEntries } from '../src/product-wiki/nav-order.mjs';
import {
  isGitHubWikiPublishPath,
  isProductWikiPath,
  PRODUCT_WIKI_EXCLUDED_SEGMENTS,
} from '../src/product-wiki/path-filter.mjs';

export { isGitHubWikiPublishPath, isProductWikiPath } from '../src/product-wiki/path-filter.mjs';

const EXCLUDED_SEGMENTS = PRODUCT_WIKI_EXCLUDED_SEGMENTS;

async function collectMarkdownPaths(root, pathFilter, relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory);
  const rows = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), row.name);
    if (row.isDirectory()) {
      if (EXCLUDED_SEGMENTS.has(row.name)) continue;
      paths.push(...(await collectMarkdownPaths(root, pathFilter, relativePath)));
      continue;
    }
    if (row.isFile() && pathFilter(relativePath)) paths.push(relativePath);
  }
  return paths;
}

function plainText(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_>#|~-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Title-case a manual folder slug for navigation grouping. */
function titleCaseSlug(segment) {
  return segment
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(' ');
}

const MANUAL_SECTION_NAMES = {
  'get-started': 'Get started',
  concepts: 'Core concepts',
  extend: 'Extend Minnow',
  apps: 'Apps',
  chat: 'Chat',
  code: 'Code',
  models: 'Models',
  brain: 'Brain',
  issues: 'Issues',
  scheduler: 'Scheduler',
  settings: 'Settings',
  orchestrate: 'Orchestrate',
  research: 'Research',
  desktop: 'Desktop',
  accessibility: 'Accessibility',
  troubleshooting: 'Troubleshooting',
  reference: 'Reference',
};

/** Derive the reader section from the canonical documentation path. */
function sectionForPath(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  if (normalized === 'ROADMAP.md') return 'Roadmap';
  if (normalized === 'THIRD_PARTY_NOTICES.md') return 'Legal';
  if (normalized === 'context.md') return 'Developer reference';
  if (normalized === 'README.md') return 'Overview';
  if (normalized.startsWith('guides/')) return 'Guides';
  if (normalized.startsWith('contributor/')) return 'Contributing';
  if (normalized.startsWith('design-system/')) return 'Design system';
  if (normalized.startsWith('plugins/')) return 'Extensions';
  if (normalized.startsWith('agent-packs/')) return 'Extensions';
  if (normalized.startsWith('maintainer/')) return 'Maintainers';
  if (normalized === 'manual/plugins.md') return 'Extend Minnow';
  if (normalized.startsWith('manual/')) {
    const rest = normalized.slice('manual/'.length);
    const segments = rest.split('/');
    if (segments.length === 1) return 'Overview';
    const folder = segments[0];
    return MANUAL_SECTION_NAMES[folder] ?? titleCaseSlug(folder);
  }
  return 'Overview';
}

/** Extract stable searchable metadata from one Markdown document. */
export function createProductWikiEntry(relativePath, markdown) {
  const normalizedMarkdown = markdown.replace(/^\uFEFF/u, '').replace(/\r\n/g, '\n');
  const headingRows = [...normalizedMarkdown.matchAll(/^(#{1,3})[^\S\r\n]+(.+?)[^\S\r\n]*$/gmu)];
  const title = headingRows.find((row) => row[1].length === 1)?.[2]?.trim()
    ?? path.posix.basename(relativePath, '.md').replaceAll('-', ' ');
  const headings = headingRows
    .filter((row) => row[1].length > 1)
    .map((row) => row[2].replace(/\s+#+$/u, '').trim())
    .filter(Boolean);
  const bodyWithoutTitle = normalizedMarkdown.replace(/^#[^\S\r\n]+.+$/mu, '');
  const summary = plainText(bodyWithoutTitle).slice(0, 280);
  const hash = createHash('sha256').update(normalizedMarkdown).digest('hex');
  return {
    path: `documentation/${relativePath}`,
    title,
    summary,
    headings,
    section: sectionForPath(relativePath),
    hash,
  };
}

/** Build the deterministic in-app product-wiki catalog from documentation/. */
export async function buildProductWikiCatalog(documentationRoot) {
  const relativePaths = await collectMarkdownPaths(documentationRoot, isProductWikiPath);
  const entries = [];
  for (const relativePath of relativePaths) {
    const markdown = await readFile(path.join(documentationRoot, relativePath), 'utf8');
    entries.push(createProductWikiEntry(relativePath, markdown));
  }
  entries.sort(compareProductWikiEntries);
  return { version: 1, entries };
}

/** Collect documentation-relative paths for GitHub Wiki staging. */
export async function collectGitHubWikiPublishPaths(documentationRoot) {
  return collectMarkdownPaths(documentationRoot, isGitHubWikiPublishPath);
}
