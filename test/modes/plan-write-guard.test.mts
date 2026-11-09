/**
 * Plan mode scoped write guard tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isPlanMarkdownPath,
  isSuperPlanReferenceArtifactPath,
  isUnderDocumentationPlans,
} from '../../src/chat/modes/plan-write-guard.ts';
import { classifyToolCall, decidePermission } from '../../src/lib/permissions.mjs';

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

describe('/plan dispatch scope', () => {
  const decide = (tool: string, args: Record<string, unknown>) =>
    decidePermission('full', classifyToolCall(tool, args, { workspaceRoots: ['/workspace'] }), { clamp: 'plans' }).decision;
  test('allows creating and editing plan markdown inside the project plans directory', () => {
    const path = 'documentation/plans/issues/review.md';
    assert.equal(decide('make_directory', { path: 'documentation/plans/issues' }), 'allow');
    for (const tool of ['save_file', 'append_file', 'insert_at_line', 'replace_text_in_file']) {
      assert.equal(decide(tool, { path }), 'allow', tool);
      assert.equal(decide(tool, { path: 'src/foo.ts' }), 'deny', tool);
    }
  });
  test('blocks moves, copies and deletions even within the plan directory', () => {
    const path = 'documentation/plans/x.md';
    assert.equal(decide('delete_path', { path }), 'deny');
    for (const tool of ['move_file', 'copy_file']) {
      assert.equal(decide(tool, { source: path, destination: 'documentation/plans/y.md' }), 'deny');
    }
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

});
