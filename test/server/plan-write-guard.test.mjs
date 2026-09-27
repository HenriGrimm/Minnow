/**
 * Server-side Plan mode write guard (POST /api/tools enforcement).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  blockPlanModeWrite,
  isPlanMarkdownPath,
  isUnderDocumentationPlans,
  resolveModeIdFromToolsBody,
} from '../../server/tools/plan-write-guard.js';

describe('resolveModeIdFromToolsBody', () => {
  test('reads modeId string', () => {
    assert.equal(resolveModeIdFromToolsBody({ modeId: 'plan' }), 'plan');
  });

  test('planMode flag forces plan', () => {
    assert.equal(resolveModeIdFromToolsBody({ planMode: true }), 'plan');
  });
});

describe('server blockPlanModeWrite', () => {
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

  test('does not block build mode writes', () => {
    assert.equal(
      blockPlanModeWrite('build', 'save_file', {
        path: 'src/foo.ts',
        content: 'x',
      }),
      null,
    );
  });

  test('allows in-place edits of a plan markdown file', () => {
    assert.equal(
      blockPlanModeWrite('plan', 'append_file', {
        path: 'documentation/plans/x.md',
        content: 'x',
      }),
      null,
    );
    assert.equal(
      blockPlanModeWrite('plan', 'replace_text_in_file', {
        path: 'documentation/plans/x.md',
        search: 'a',
        replace: 'b',
      }),
      null,
    );
  });

  test('blocks in-place edits outside plans', () => {
    const msg = blockPlanModeWrite('plan', 'append_file', {
      path: 'src/foo.ts',
      content: 'x',
    });
    assert.ok(msg?.includes('documentation/plans'));
  });

  test('still blocks delete_path in plan mode', () => {
    const msg = blockPlanModeWrite('plan', 'delete_path', {
      path: 'documentation/plans/x.md',
    });
    assert.ok(msg?.includes('Plan mode'));
  });

  test('blocks Godot process control in plan mode', () => {
    assert.match(blockPlanModeWrite('plan', 'godot_control', { action: 'run_scene' }), /Plan mode/);
  });
});

describe('server plan path helpers', () => {
  test('isUnderDocumentationPlans accepts nested dirs', () => {
    assert.equal(isUnderDocumentationPlans('documentation/plans/Build out'), true);
  });

  test('isPlanMarkdownPath rejects non-md under plans', () => {
    assert.equal(isPlanMarkdownPath('documentation/plans/readme.txt'), false);
  });
});
