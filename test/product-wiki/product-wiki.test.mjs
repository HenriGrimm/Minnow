import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  loadProductWikiCatalog,
  readProductWikiPage,
  resolveProductWikiPagePath,
  resetProductWikiCatalogForTests,
  searchProductWiki,
} from '../../server/product-wiki/catalog.js';
import {
  toolMinnowDocsList,
  toolMinnowDocsRead,
  toolMinnowDocsSearch,
} from '../../server/tools/minnow-docs-tools.js';
import {
  buildProductWikiCatalog,
  createProductWikiEntry,
  isGitHubWikiPublishPath,
  isProductWikiPath,
} from '../../scripts/product-wiki-catalog-lib.mjs';
import { compareProductWikiEntries } from '../../src/product-wiki/nav-order.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('product wiki catalog generation', () => {
  test('includes user manual paths while excluding developer and working folders', () => {
    assert.equal(isProductWikiPath('manual/get-started/install.md'), true);
    assert.equal(isProductWikiPath('manual/README.md'), true);
    assert.equal(isProductWikiPath('ROADMAP.md'), true);
    assert.equal(isProductWikiPath('THIRD_PARTY_NOTICES.md'), true);
    assert.equal(isProductWikiPath('README.md'), false);
    assert.equal(isProductWikiPath('context.md'), false);
    assert.equal(isProductWikiPath('guides/setup.md'), false);
    assert.equal(isProductWikiPath('contributor/setup-from-source.md'), false);
    assert.equal(isProductWikiPath('maintainer/releasing.md'), false);
    assert.equal(isProductWikiPath('plans/example.md'), false);
    assert.equal(isProductWikiPath('memory/note.md'), false);
    assert.equal(isProductWikiPath('../README.md'), false);
  });

  test('includes full corpus paths for GitHub Wiki publishing', () => {
    assert.equal(isGitHubWikiPublishPath('README.md'), true);
    assert.equal(isGitHubWikiPublishPath('context.md'), true);
    assert.equal(isGitHubWikiPublishPath('guides/setup.md'), true);
    assert.equal(isGitHubWikiPublishPath('maintainer/wiki-publishing.md'), true);
    assert.equal(isGitHubWikiPublishPath('manual/get-started/install.md'), true);
    assert.equal(isGitHubWikiPublishPath('contributor/setup-from-source.md'), true);
    assert.equal(isGitHubWikiPublishPath('plans/example.md'), false);
  });

  test('extracts deterministic page metadata', () => {
    const entry = createProductWikiEntry(
      'manual/get-started/example.md',
      '\uFEFF# Example guide\n\nA short summary for readers.\n\n## Configure it\n\nDetails.',
    );
    assert.equal(entry.path, 'documentation/manual/get-started/example.md');
    assert.equal(entry.title, 'Example guide');
    assert.equal(entry.summary, 'A short summary for readers. Configure it Details.');
    assert.deepEqual(entry.headings, ['Configure it']);
    assert.equal(entry.section, 'Get started');
    assert.match(entry.hash, /^[a-f0-9]{64}$/u);
  });

  test('orders catalog entries for reader navigation', async () => {
    const generated = await buildProductWikiCatalog(path.join(repositoryRoot, 'documentation'));
    const paths = generated.entries.map((entry) => entry.path);
    assert.deepEqual(paths.slice(0, 5), [
      'documentation/manual/README.md',
      'documentation/manual/get-started/install.md',
      'documentation/manual/get-started/connect-a-model.md',
      'documentation/manual/get-started/costs-and-providers.md',
      'documentation/manual/get-started/first-chat.md',
    ]);
    const appsBlock = paths.filter((pagePath) => pagePath.includes('/manual/apps/'));
    assert.deepEqual(appsBlock[0], 'documentation/manual/apps/overview.md');
    const sorted = [...generated.entries].sort(compareProductWikiEntries);
    assert.deepEqual(sorted.map((entry) => entry.path), paths);
  });

  test('manual bodies avoid retired onboarding navigation phrases', async () => {
    const generated = await buildProductWikiCatalog(path.join(repositoryRoot, 'documentation'));
    const manualEntries = generated.entries.filter((entry) =>
      entry.path.startsWith('documentation/manual/'),
    );

    const bannedPhrases = [
      { label: 'eight apps', pattern: /\beight apps\b/iu },
      { label: 'eight core apps', pattern: /\beight core apps\b/iu },
      { label: 'Chat (desktop)', pattern: /\bChat \(desktop\)/iu },
      { label: 'desktop chat surface', pattern: /\bdesktop chat surface\b/iu },
    ];

    const violations = [];

    for (const entry of manualEntries) {
      const relative = entry.path.replace(/^documentation\//u, '');
      const absolute = path.join(repositoryRoot, 'documentation', relative);
      const body = await fs.readFile(absolute, 'utf8');
      const isGlossary = relative === 'manual/reference/glossary.md';

      for (const { label, pattern } of bannedPhrases) {
        if (pattern.test(body)) {
          violations.push(`${entry.path}: banned phrase "${label}"`);
        }
      }

      const desktopHash = /#\/desktop/gu;
      let match = desktopHash.exec(body);
      while (match) {
        const lineStart = body.lastIndexOf('\n', match.index) + 1;
        const lineEnd = body.indexOf('\n', match.index);
        const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd);
        const sectionStart = body.lastIndexOf('\n## ', match.index);
        const sectionHeading =
          sectionStart === -1 ? '' : body.slice(sectionStart, body.indexOf('\n', sectionStart + 1));
        const legacyContext =
          isGlossary || /legacy/i.test(line) || /legacy/i.test(sectionHeading);
        if (!legacyContext) {
          violations.push(`${entry.path}: #/desktop outside glossary/legacy context`);
        }
        match = desktopHash.exec(body);
      }
    }

    assert.deepEqual(violations, []);
  });

  test('committed catalog covers every generated page', async () => {
    const generated = await buildProductWikiCatalog(path.join(repositoryRoot, 'documentation'));
    const committed = await loadProductWikiCatalog();
    assert.deepEqual(committed, generated);
    assert.ok(committed.entries.some((entry) => entry.path === 'documentation/manual/reference/wiki-and-brain.md'));
    assert.ok(!committed.entries.some((entry) => entry.path === 'documentation/guides/wiki.md'));
    assert.ok(!committed.entries.some((entry) => entry.path === 'documentation/maintainer/releasing.md'));
    assert.ok(!committed.entries.some((entry) => entry.path.startsWith('documentation/contributor/')));
    assert.ok(!committed.entries.some((entry) => entry.path === 'documentation/context.md'));
    assert.ok(committed.entries.some((entry) => entry.path === 'documentation/ROADMAP.md'));
    assert.ok(
      committed.entries.every(
        (entry) =>
          entry.path.startsWith('documentation/manual/')
          || entry.path === 'documentation/ROADMAP.md'
          || entry.path === 'documentation/THIRD_PARTY_NOTICES.md',
      ),
    );
  });

  test('runtime catalog drops legacy developer pages from stale catalog.json', async () => {
    resetProductWikiCatalogForTests();
    const original = await fs.readFile(
      path.join(repositoryRoot, 'server/product-wiki/catalog.json'),
      'utf8',
    );
    const parsed = JSON.parse(original);
    parsed.entries = [
      {
        path: 'documentation/context.md',
        title: 'Developer context',
        summary: 'Should not appear in app',
        headings: [],
        section: 'Developer reference',
        hash: 'deadbeef',
      },
      ...parsed.entries,
    ];
    const tempPath = path.join(repositoryRoot, 'server/product-wiki/catalog.json');
    await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    try {
      const loaded = await loadProductWikiCatalog();
      assert.ok(!loaded.entries.some((entry) => entry.path === 'documentation/context.md'));
      assert.ok(loaded.entries.length > 0);
    } finally {
      await fs.writeFile(tempPath, original, 'utf8');
      resetProductWikiCatalogForTests();
    }
  });
});

describe('product wiki reads and search', () => {
  test('reads an allowlisted official page', async () => {
    const page = await readProductWikiPage('documentation/manual/get-started/install.md');
    assert.equal(page.path, 'documentation/manual/get-started/install.md');
    assert.match(page.content, /^# /u);
  });

  test('rejects traversal and excluded documents', async () => {
    await assert.rejects(
      resolveProductWikiPagePath('documentation/../package.json'),
      /not found|path/iu,
    );
    await assert.rejects(
      resolveProductWikiPagePath('documentation/plans/MIN-406-unified-minnow-wiki.md'),
      /not found/iu,
    );
    await assert.rejects(
      resolveProductWikiPagePath('documentation/guides/setup.md'),
      /not found/iu,
    );
  });

  test('ranks exact title and heading matches with excerpts', async () => {
    const hits = await searchProductWiki('Minnow wiki', { limit: 4 });
    assert.ok(hits.length > 0);
    assert.ok(hits[0].path.startsWith('documentation/manual/'));
    assert.ok(!hits.some((hit) => hit.path === 'documentation/guides/wiki.md'));
    assert.ok(hits[0].excerpt.length > 0);
  });
});

describe('product wiki chat tools', () => {
  test('search, read, and list return citation paths', async () => {
    const searchResult = JSON.parse(await toolMinnowDocsSearch({ query: 'composer modes' }));
    assert.ok(searchResult.hits.some((hit) => hit.path === 'documentation/manual/concepts/modes.md'));

    const readResult = await toolMinnowDocsRead({ path: 'documentation/manual/README.md' });
    assert.match(readResult, /Source: documentation\/manual\/README\.md/u);
    assert.match(readResult, /# Minnow manual/u);

    const listResult = JSON.parse(await toolMinnowDocsList({ prefix: 'documentation/manual/' }));
    assert.ok(listResult.entries.every((entry) => entry.path.startsWith('documentation/manual/')));
  });

  test('returns explicit errors for missing arguments', async () => {
    assert.equal(await toolMinnowDocsSearch({}), 'Error: query is required.');
    assert.equal(await toolMinnowDocsRead({}), 'Error: path is required.');
  });
});

describe('GitHub Wiki staging contract', () => {
  test('publishing script and workflow are present', async () => {
    const script = await fs.readFile(
      path.join(repositoryRoot, 'scripts/publish-github-wiki.mjs'),
      'utf8',
    );
    const workflow = await fs.readFile(
      path.join(repositoryRoot, '.github/workflows/wiki-sync.yml'),
      'utf8',
    );
    assert.match(script, /_Sidebar\.md/u);
    assert.match(script, /collectGitHubWikiPublishPaths/u);
    assert.match(workflow, /WIKI_SYNC_TOKEN/u);
    const publishScript = await fs.readFile(
      path.join(repositoryRoot, 'scripts/push-github-wiki.mjs'),
      'utf8',
    );
    assert.match(publishScript, /Minnow\.wiki\.git/u);
  });
});
