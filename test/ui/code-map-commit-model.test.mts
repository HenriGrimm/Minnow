import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodeMapFolder } from '../../src/brain/types.ts';
import type { GitCommitReview } from '../../src/ui/git-commit-review.ts';
import { commitReviewMatchesWorkspace, normalizeReviewPath } from '../../src/ui/git-commit-review.ts';
import { commitFilesForNode, commitNodeLabel, folderWithCommitFiles } from '../../src/ui/code-map/commit-review.ts';
import { buildFolderModel, type MapNode } from '../../src/ui/code-map/model.ts';

const review: GitCommitReview = {
  sha: 'abc', cwd: 'C:/repo', selectedPath: 'src/a.ts', files: [
    { path: 'src/a.ts', status: 'Modified', additions: 2, deletions: 1 },
    { path: 'src/nested/b.ts', status: 'Added', additions: 4, deletions: 0 },
    { path: 'other/new.ts', oldPath: 'src/old.ts', status: 'Renamed', additions: 0, deletions: 0 },
    { path: 'src-extra/file.ts', status: 'Deleted', additions: 0, deletions: 3 },
  ],
};
const empty: CodeMapFolder = { path: 'src', nodes: [], edges: [], hidden: [], calledFrom: [], callsInto: [], summary: null };
const node = (path: string, kind: MapNode['kind'] = 'folder'): MapNode => ({ id: path, path, kind, label: path, detail: '', meta: '', layer: 0, weight: 0 });

test('folder overlays include direct changed files and subfolders without changing the index or inventing edges', () => {
  const result = folderWithCommitFiles(empty, review);
  assert.deepEqual(result.nodes.map(n => [n.path, n.kind]), [['src/a.ts', 'file'], ['src/nested', 'folder']]);
  assert.equal(empty.nodes.length, 0);
  assert.equal(result.edges.length, 0);
  assert.equal(folderWithCommitFiles(result, review).nodes.length, 2);
  assert.equal(buildFolderModel(result, 'strong').nodes.size, 2);
});

test('module changes aggregate descendants, respect loose files, and include rename source paths', () => {
  assert.equal(commitNodeLabel(node('src'), review), '3 changed · +6 −1');
  assert.equal(commitFilesForNode(node('src/nested'), review).length, 1);
  assert.equal(commitFilesForNode(node('src/old.ts', 'file'), review)[0].status, 'Renamed');
  assert.equal(commitFilesForNode(node('src/a.ts', 'symbol'), review)[0].status, 'Modified');
  const loose = { ...node('src', 'module'), module: { id: 'src', path: 'src', name: 'src', group: 'src', loose: true, test: false, files: 2, symbols: 2, lines: 2 } };
  assert.equal(commitFilesForNode(loose, review).length, 2);
  assert.equal(commitNodeLabel(node('unchanged.ts', 'file'), review), null);
  assert.equal(commitFilesForNode(node('src', 'package'), review).length, 0);
});

test('workspace scope compares Windows paths safely without folding case-sensitive Unix paths', () => {
  assert.equal(normalizeReviewPath('.\\src\\a.ts'), 'src/a.ts');
  assert.equal(commitReviewMatchesWorkspace(review, 'c:\\REPO\\'), true);
  assert.equal(commitReviewMatchesWorkspace(review, 'C:/other'), false);
  assert.equal(commitReviewMatchesWorkspace({ ...review, cwd: '/repo' }, '/Repo'), false);
});
