/**
 * Plan listing helpers used by the V2 Boards create form and leftover pickers.
 *
 * Ported from the V1 `test/orchestrate/list-plans.test.mts` against
 * `src/chat/plans/` (MIN-716). Path-filter cases live in
 * `test/chat/orchestrate/plan-path.test.mts` — do not duplicate them here.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizePlanDiscoverError,
  filterBoardPlanPaths,
  parseFindFilesOutputPaths,
} from '../../../src/chat/plans/list-plans.ts';

test('board discovery excludes Build, unknown types, and unreadable plans, retaining legacy plans', async () => {
  const contents: Record<string, string> = {
    legacy: '# Legacy board',
    board: '---\nplanType: orchestrate\n---\n# Board',
    build: '---\nplanType: build\n---\n# Build',
    invalid: '---\nplanType: other\n---\n# Unknown',
  };
  const found = await filterBoardPlanPaths(['legacy', 'build', 'missing', 'board', 'invalid'], async (path) => {
    if (!(path in contents)) throw new Error('missing');
    return contents[path]!;
  });
  assert.deepEqual(found, ['legacy', 'board']);
});

describe('normalizePlanDiscoverError', () => {
  test('maps ENOENT to no_plans_dir', () => {
    assert.equal(
      normalizePlanDiscoverError(
        "ENOENT: no such file or directory, scandir 'C:\\workspace\\documentation\\plans'",
      ),
      'no_plans_dir',
    );
  });

  test('passes through other messages', () => {
    assert.equal(normalizePlanDiscoverError('pattern is required'), 'pattern is required');
  });
});

describe('parseFindFilesOutputPaths', () => {
  test('splits lines and ignores truncation footer', () => {
    const raw =
      'documentation/plans/a.md\ndocumentation/plans/b.md\n(truncated at 500 results)';
    assert.deepEqual(parseFindFilesOutputPaths(raw), [
      'documentation/plans/a.md',
      'documentation/plans/b.md',
    ]);
  });

  test('returns empty for no files message', () => {
    assert.deepEqual(
      parseFindFilesOutputPaths('No files matching "**/*.md" under documentation/plans'),
      [],
    );
  });

  test('returns empty for Error prefix', () => {
    assert.deepEqual(parseFindFilesOutputPaths('Error: pattern is required'), []);
  });
});
