/**
 * Workspace path equality after slash and trailing-separator normalization.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizeWorkspacePath,
  workspacePathsEqual,
} from '../../src/lib/normalize-workspace-path.ts';

describe('workspacePathsEqual', () => {
  test('treats trailing slashes and backslashes as the same folder', () => {
    assert.equal(workspacePathsEqual('/home/user/minnow', '/home/user/minnow/'), true);
    assert.equal(
      workspacePathsEqual('C:/Users/dukky/Minnow', 'C:\\Users\\dukky\\Minnow'),
      true,
    );
    assert.equal(normalizeWorkspacePath('/home/user/minnow/'), '/home/user/minnow');
  });

  test('ignores Windows folder casing without changing stored spelling', () => {
    const saved = 'C:/Users/dukky/Documents/GitHub/Vinea';
    assert.equal(workspacePathsEqual(saved, 'c:\\users\\dukky\\documents\\github\\vinea\\'), true);
    assert.equal(normalizeWorkspacePath(saved), saved);
    assert.equal(workspacePathsEqual(saved, 'D:/users/dukky/documents/github/vinea'), false);
    assert.equal(workspacePathsEqual('/home/user/Vinea', '/home/user/vinea'), false);
  });

  test('rejects empty or different folders', () => {
    assert.equal(workspacePathsEqual('', '/home/user/minnow'), false);
    assert.equal(workspacePathsEqual('/home/user/a', '/home/user/b'), false);
  });
});
