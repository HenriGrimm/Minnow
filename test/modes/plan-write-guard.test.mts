/**
 * Plan mode scoped write guard tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  blockPlanModeWrite,
  isPlanMarkdownPath,
  isSuperPlanReferenceArtifactPath,
  isUnderDocumentationPlans,
} from '../../src/chat/modes/plan-write-guard.ts';

describe('isUnderDocumentationPlans', () => {
  test('accepts plans root and nested dirs', () => {
    assert.equal(isUnderDocumentationPlans('documentation/plans'), true);
    assert.equal(isUnderDocumentationPlans('documentation/plans/Build out'), true);
  });

  test('rejects paths outside plans', () => {
    assert.equal(isUnderDocumentationPlans('documentation/context.md'), false);
    assert.equal(isUnderDocumentationPlans('src/main.ts'), false);
  });
});

describe('isPlanMarkdownPath', () => {
  test('accepts markdown under plans', () => {
    assert.equal(
      isPlanMarkdownPath('documentation/plans/feature-foo.md'),
      true,
    );
    assert.equal(
      isPlanMarkdownPath('documentation/plans/Build out/foo.md'),
      true,
    );
  });

  test('rejects non-md or outside plans', () => {
    assert.equal(isPlanMarkdownPath('documentation/plans/readme.txt'), false);
    assert.equal(isPlanMarkdownPath('documentation/foo.md'), false);
  });
});

describe('blockPlanModeWrite', () => {
  test('allows save_file for plan markdown in plan mode', () => {
    assert.equal(
      blockPlanModeWrite('plan', 'save_file', {
        path: 'documentation/plans/my-feature.md',
        content: '# Plan',
      }),
      null,
    );
  });

  test('blocks save_file outside plans in plan mode', () => {
    const msg = blockPlanModeWrite('plan', 'save_file', {
      path: 'src/foo.ts',
      content: 'x',
    });
    assert.ok(msg?.includes('documentation/plans'));
  });

  test('allows make_directory under plans in plan mode', () => {
    assert.equal(
      blockPlanModeWrite('plan', 'make_directory', {
        path: 'documentation/plans',
      }),
      null,
    );
  });

  test('does not block build mode writes', () => {
    assert.equal(
      blockPlanModeWrite('build', 'save_file', {
        path: 'src/foo.ts',
        content: 'x',
      }),
      null,
    );
  });

  test('blocks append_file in plan mode', () => {
    const msg = blockPlanModeWrite('plan', 'append_file', {
      path: 'documentation/plans/x.md',
      content: 'x',
    });
    assert.ok(msg?.includes('Plan mode'));
  });
});

describe('super-plan references write guard', () => {
  test('isSuperPlanReferenceArtifactPath accepts research-artifact and build-spec', () => {
    assert.equal(
      isSuperPlanReferenceArtifactPath(
        'documentation/plans/references/my-plan/research-artifact.md',
      ),
      true,
    );
    assert.equal(
      isSuperPlanReferenceArtifactPath(
        'documentation/plans/references/my-plan/build-spec.md',
      ),
      true,
    );
    assert.equal(
      isSuperPlanReferenceArtifactPath(
        'documentation/plans/references/my-plan/notes.md',
      ),
      false,
    );
  });

  test('allows save_file for slug-based super-plan reference artifacts', () => {
    assert.equal(
      blockPlanModeWrite('super-plan', 'save_file', {
        path: 'documentation/plans/references/feature-x-spec.md',
        content: '# Build spec',
      }),
      null,
    );
    assert.equal(
      blockPlanModeWrite('super-plan', 'save_file', {
        path: 'documentation/plans/references/feature-x-research.md',
        content: '# Research',
      }),
      null,
    );
  });

  test('allows save_file for super-plan reference artifacts', () => {
    assert.equal(
      blockPlanModeWrite('super-plan', 'save_file', {
        path: 'documentation/plans/references/feature-x/research-artifact.md',
        content: '# Research',
      }),
      null,
    );
    assert.equal(
      blockPlanModeWrite('super-plan', 'save_file', {
        path: 'documentation/plans/references/feature-x/build-spec.md',
        content: '# Build spec',
      }),
      null,
    );
  });

  // Super Plan is disabled for release: the id normalizes to Plan, so the guard
  // still blocks the write but reports it as Plan mode.
  test('blocks save_file outside plans in super-plan mode', () => {
    const msg = blockPlanModeWrite('super-plan', 'save_file', {
      path: 'src/foo.ts',
      content: 'x',
    });
    assert.ok(msg?.includes('Plan mode may only save_file'));
  });
});
