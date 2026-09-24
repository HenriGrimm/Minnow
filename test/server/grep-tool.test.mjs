/**
 * grep server tool (POLISH-021 / MIN-103, MIN-196).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  GREP_DEFAULT_HEAD_LIMIT,
  GREP_MAX_HEAD_LIMIT,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_OUTPUT_CHARS,
  capGrepOutput,
  formatGroupedGrepOutput,
  isRipgrepMatchLine,
  runFindFilesSearch,
  runGrepSearch,
  sortRipgrepOutputByPath,
  truncateRipgrepOutput,
} from '../../server/tools/grep.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../../server/tools/output-cap.js';
import { pathAccessStore, resolveSafePath } from '../../server/runtime/path-access.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/grep-workspace',
);

/** Mirror tools-middleware display paths for tests. */
function toRelativePath(absPath) {
  const rel = path.relative(fixtureRoot, absPath);
  return rel === '' ? '.' : rel.replace(/\\/g, '/');
}

/** Run grep against the fixture tree without relying on global workspace root (parallel-safe). */
function grepInFixture(args) {
  return pathAccessStore.run(
    { allowOutsideWorkspace: false, workspaceRootOverride: fixtureRoot },
    () =>
      runGrepSearch(args, {
        resolveSafePath,
        toRelativePath,
        getWorkspaceRoot: () => fixtureRoot,
      }),
  );
}

/** Run find-files against the fixture tree without relying on global workspace root. */
function findFilesInFixture(args, options) {
  return pathAccessStore.run(
    { allowOutsideWorkspace: false, workspaceRootOverride: fixtureRoot },
    () =>
      runFindFilesSearch(
        args,
        {
          resolveSafePath,
          toRelativePath,
          getWorkspaceRoot: () => fixtureRoot,
        },
        options,
      ),
  );
}

describe('grep helpers', () => {
  it('isRipgrepMatchLine detects match vs context lines', () => {
    assert.equal(isRipgrepMatchLine('src/foo.ts:12:export const x'), true);
    assert.equal(isRipgrepMatchLine('src/foo.ts-11-context'), false);
    assert.equal(isRipgrepMatchLine('12:export const x'), true);
    assert.equal(isRipgrepMatchLine('--'), false);
  });

  it('capGrepOutput caps all emitted lines including context', () => {
    const sample = ['1:alpha', '2-beta', '3:gamma', '4:delta'].join('\n');
    const { text, truncated, lineCount } = capGrepOutput(sample, { headLimit: 2 });
    assert.equal(truncated, true);
    assert.equal(lineCount, 2);
    assert.match(text, /1:alpha/);
    assert.match(text, /2-beta/);
    assert.doesNotMatch(text, /3:gamma/);
    assert.match(text, /truncated at 2 match lines/);
  });

  it('capGrepOutput supports offset pagination', () => {
    const sample = ['line-a', 'line-b', 'line-c', 'line-d'].join('\n');
    const { text, lineCount, nextOffset } = capGrepOutput(sample, {
      offset: 2,
      headLimit: 2,
    });
    assert.equal(lineCount, 2);
    assert.equal(nextOffset, 4);
    assert.match(text, /line-c/);
    assert.match(text, /line-d/);
    assert.doesNotMatch(text, /line-a/);
  });

  it('capGrepOutput caps per-line length', () => {
    const longLine = 'x'.repeat(GREP_MAX_LINE_CHARS + 50);
    const { text } = capGrepOutput(longLine, { headLimit: 1 });
    const emitted = text.split('\n')[0];
    assert.ok(emitted.length <= GREP_MAX_LINE_CHARS);
    assert.match(emitted, /\.\.\.$/);
  });

  it('capGrepOutput enforces total output char budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `match-${i}:${'a'.repeat(400)}`);
    const { text, truncated } = capGrepOutput(lines.join('\n'), {
      headLimit: 100,
      maxOutputChars: 2000,
    });
    assert.equal(truncated, true);
    assert.ok(text.length <= GREP_MAX_OUTPUT_CHARS + 200);
  });

  it('truncateRipgrepOutput delegates to capGrepOutput', () => {
    const sample = ['1:alpha', '2-beta', '3:gamma'].join('\n');
    const { text, truncated, lineCount } = truncateRipgrepOutput(sample, 1);
    assert.equal(truncated, true);
    assert.equal(lineCount, 1);
    assert.match(text, /1:alpha/);
    assert.doesNotMatch(text, /2-beta/);
  });

  it('formatGroupedGrepOutput groups path:line rows per file', () => {
    const sample = [
      'src/foo.ts:42: const x = 1',
      'src/foo.ts:47: const y = 2',
      'src/bar.ts:10: export default',
    ].join('\n');
    const grouped = formatGroupedGrepOutput(sample);
    assert.match(grouped, /^src\/foo\.ts\n {2}42:/m);
    assert.match(grouped, / {2}47:/);
    assert.match(grouped, /^src\/bar\.ts\n {2}10:/m);
  });
});

describe('grep constants (MIN-667)', () => {
  it('uses raised default and max head limits so raising head_limit is not a no-op', () => {
    assert.equal(GREP_DEFAULT_HEAD_LIMIT, 500);
    assert.equal(GREP_MAX_HEAD_LIMIT, 2000);
    assert.ok(GREP_DEFAULT_HEAD_LIMIT < GREP_MAX_HEAD_LIMIT);
    assert.equal(GREP_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS);
    assert.equal(GREP_MAX_LINE_CHARS, 2000);
  });
});

describe('runGrepSearch fixture workspace', () => {
  it('finds matches under src/', async () => {
    const out = await grepInFixture({
      pattern: 'grep-fixture-visible',
      path: 'src',
    });
    assert.match(out, /visible\.ts/);
    assert.match(out, /grep-fixture-visible/);
  });

  it('respects .gitignore for ignored-dir', async () => {
    const out = await grepInFixture({
      pattern: 'grep-fixture-hidden',
      path: '.',
    });
    assert.match(out, /No matches/);
    assert.doesNotMatch(out, /hidden\.ts/);
  });

  it('returns no-match message when pattern is absent', async () => {
    const out = await grepInFixture({
      pattern: 'grep-fixture-absent-xyz',
      path: 'src',
    });
    assert.match(out, /No matches/);
  });

  it('rejects invalid regex', async () => {
    const out = await grepInFixture({ pattern: '[', path: 'src' });
    assert.match(out, /invalid regex/i);
  });

  it('supports literal search', async () => {
    const out = await grepInFixture({
      pattern: 'grep-fixture-visible',
      path: 'src/visible.ts',
      literal: true,
    });
    assert.match(out, /grep-fixture-visible/);
  });

  it('supports case_insensitive search', async () => {
    const out = await grepInFixture({
      pattern: 'GREP-FIXTURE-VISIBLE',
      path: 'src/visible.ts',
      case_insensitive: true,
    });
    assert.match(out, /grep-fixture-visible/i);
  });

  it('truncates when head_limit is exceeded', async () => {
    const out = await grepInFixture({
      pattern: 'export',
      path: 'src',
      head_limit: 1,
    });
    assert.match(out, /truncated at 1 match lines/);
  });

  it('supports output_mode files_with_matches', async () => {
    const out = await grepInFixture({
      pattern: 'grep-fixture',
      path: 'src',
      output_mode: 'files_with_matches',
    });
    assert.match(out, /visible\.ts/);
    assert.doesNotMatch(out, /grep-fixture-visible/);
  });

  it('supports output_mode count', async () => {
    const out = await grepInFixture({
      pattern: 'export',
      path: 'src',
      output_mode: 'count',
    });
    assert.match(out, /:\d+$/m);
    assert.doesNotMatch(out, /export const/);
  });

  it('supports output_mode grouped', async () => {
    const out = await grepInFixture({
      pattern: 'grep-fixture',
      path: 'src',
      output_mode: 'grouped',
    });
    assert.match(out, /visible\.ts/m);
    // Both files, whichever one ripgrep happened to emit last: the fixture is CRLF, and
    // a trailing `\r` used to make the grouping regex drop that line without a trace.
    assert.match(out, /deep\.ts/m);
    assert.doesNotMatch(out, /\r/);
    assert.match(out, / {2}\d+: /);
    assert.doesNotMatch(out, /:\d+:.*:\d+:/);
  });

  it('supports offset pagination', async () => {
    // Path-sorted rg output must stay stable across invocations so offset pages
    // line up with a prior full result (see --sort path in buildRipgrepArgs).
    const full = await grepInFixture({
      pattern: 'export',
      path: 'src',
      head_limit: 10,
    });
    const lines = full.split('\n').filter((l) => l && !l.startsWith('(truncated'));
    assert.ok(lines.length >= 2, 'fixture should yield at least two export matches');

    const first = await grepInFixture({
      pattern: 'export',
      path: 'src',
      head_limit: 1,
      offset: 0,
    });
    const page = await grepInFixture({
      pattern: 'export',
      path: 'src',
      head_limit: 1,
      offset: 1,
    });
    const firstLines = first.split('\n').filter((l) => l && !l.startsWith('(truncated'));
    const pageLines = page.split('\n').filter((l) => l && !l.startsWith('(truncated'));
    assert.equal(firstLines.length, 1);
    assert.equal(pageLines.length, 1);
    assert.equal(firstLines[0], lines[0]);
    assert.equal(pageLines[0], lines[1]);
    assert.notEqual(pageLines[0], firstLines[0]);
  });

  it('rejects paths outside workspace', async () => {
    await assert.rejects(
      () =>
        grepInFixture({
          pattern: 'test',
          path: '/etc',
        }),
      /outside the workspace/i,
    );
  });
});

describe('runFindFilesSearch fixture workspace', () => {
  it('finds .ts files with forward-slash relative paths', async () => {
    const out = await findFilesInFixture({ pattern: '**/*.ts' });
    assert.match(out, /^src\/visible\.ts$/m);
    assert.match(out, /^src\/nested\/deep\.ts$/m);
    assert.doesNotMatch(out, /\\/); // no Windows backslashes
    assert.doesNotMatch(out, /^\.\//m); // no ./ prefix
  });

  it('matches a bare basename glob in any directory', async () => {
    const out = await findFilesInFixture({ pattern: '*.ts' });
    assert.match(out, /visible\.ts/);
    assert.match(out, /nested\/deep\.ts/);
  });

  it('respects .gitignore (excludes ignored-dir)', async () => {
    const out = await findFilesInFixture({ pattern: '**/*.ts' });
    assert.doesNotMatch(out, /hidden\.ts/);
  });

  it('returns a no-match message for an absent pattern', async () => {
    const out = await findFilesInFixture({ pattern: '**/*.rs' });
    assert.match(out, /No files matching/);
  });

  it('scopes results to a subdirectory', async () => {
    const out = await findFilesInFixture({ pattern: '**/*.ts', path: 'src/nested' });
    assert.match(out, /deep\.ts/);
    assert.doesNotMatch(out, /visible\.ts/);
  });

  it('keeps .gitignore in force for a match-everything pattern', async () => {
    // A `-g` glob that whitelists every path overrides the ignore files in ripgrep,
    // so forwarding `**/*` used to return the whole tree — in the real repo that was
    // 153k paths, 123k of them from node_modules, truncated to an arbitrary slice.
    const out = await findFilesInFixture({ pattern: '**/*' });
    assert.match(out, /src\/visible\.ts/);
    assert.doesNotMatch(out, /hidden\.ts/);
  });

  it('returns paths in sorted order', async () => {
    // `rg --files` is unordered, so without this the maxResults cap below returned an
    // arbitrary slice that changed between identical calls.
    const out = await findFilesInFixture({ pattern: '**/*.ts' });
    const lines = out.split('\n').filter((l) => l && !l.startsWith('('));
    assert.deepEqual(lines, [...lines].sort());
  });

  it('truncates deterministically at maxResults', async () => {
    const first = await findFilesInFixture({ pattern: '**/*.ts' }, { maxResults: 1 });
    const second = await findFilesInFixture({ pattern: '**/*.ts' }, { maxResults: 1 });
    assert.equal(first, second);
    assert.match(first, /truncated at 1 results/);
  });
});

/**
 * Path ordering moved out of ripgrep (`--sort path` serialized its traversal, which
 * measured 5x slower warm and far worse on a cold file cache) and into these helpers.
 * The guarantee they have to keep is the one `offset` paging depends on.
 */
describe('sortRipgrepOutputByPath', () => {
  it('restores path order across files', () => {
    const raw = ['src/z.ts:1:zed', 'src/a.ts:4:alpha'].join('\n');
    assert.equal(
      sortRipgrepOutputByPath(raw, 'content'),
      ['src/a.ts:4:alpha', 'src/z.ts:1:zed'].join('\n'),
    );
  });

  it('keeps each file ripgrep emitted contiguously in its own line order', () => {
    const raw = ['src/z.ts:1:one', 'src/z.ts:2:two', 'src/a.ts:9:nine'].join('\n');
    assert.equal(
      sortRipgrepOutputByPath(raw, 'content'),
      ['src/a.ts:9:nine', 'src/z.ts:1:one', 'src/z.ts:2:two'].join('\n'),
    );
  });

  it('carries context lines and separators with their own file', () => {
    const raw = [
      'src/z.ts-3-before',
      'src/z.ts:4:hit',
      'src/z.ts-5-after',
      '--',
      'src/a.ts-1-before',
      'src/a.ts:2:hit',
    ].join('\n');

    assert.equal(
      sortRipgrepOutputByPath(raw, 'content'),
      [
        '--',
        'src/a.ts-1-before',
        'src/a.ts:2:hit',
        'src/z.ts-3-before',
        'src/z.ts:4:hit',
        'src/z.ts-5-after',
      ].join('\n'),
    );
  });

  it('does not split a file on match content that looks like a path', () => {
    const raw = ['src/z.ts:1:const url = "http:12:x"', 'src/a.ts:1:hit'].join('\n');
    const sorted = sortRipgrepOutputByPath(raw, 'content');
    assert.equal(sorted, ['src/a.ts:1:hit', 'src/z.ts:1:const url = "http:12:x"'].join('\n'));
  });

  it('sorts files_with_matches and count output by path', () => {
    assert.equal(
      sortRipgrepOutputByPath('src/z.ts\nsrc/a.ts', 'files_with_matches'),
      'src/a.ts\nsrc/z.ts',
    );
    assert.equal(sortRipgrepOutputByPath('src/z.ts:3\nsrc/a.ts:1', 'count'), 'src/a.ts:1\nsrc/z.ts:3');
  });
});

describe('grep result-cap policy (MIN-667)', () => {
  it('ignores the automatic head cap when applyResultCap is false', () => {
    const sample = Array.from({ length: 600 }, (_, i) => `${i}:match`).join('\n');
    const { text, truncated, lineCount } = capGrepOutput(sample, { applyResultCap: false });
    assert.equal(truncated, false);
    assert.equal(lineCount, 600);
    assert.doesNotMatch(text, /truncated at/);
  });

  it('still honors an explicit head_limit when applyResultCap is false', () => {
    const sample = Array.from({ length: 40 }, (_, i) => `${i}:match`).join('\n');
    const { lineCount, truncated } = capGrepOutput(sample, {
      applyResultCap: false,
      explicitHeadLimit: true,
      headLimit: 10,
    });
    assert.equal(lineCount, 10);
    assert.equal(truncated, true);
  });
});
