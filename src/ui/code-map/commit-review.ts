import type { CodeMapFolder } from '../../brain/types';
import type { CommitReviewFile, GitCommitReview } from '../git-commit-review';
import { normalizeReviewPath } from '../git-commit-review';
import type { MapNode } from './model';

/** Include commit-only paths without inventing indexed symbols or call relationships. */
export function folderWithCommitFiles(folder: CodeMapFolder, review: GitCommitReview | null): CodeMapFolder {
  if (!review) return folder;
  const nodes = [...folder.nodes];
  const prefix = folder.path ? `${normalizeReviewPath(folder.path)}/` : '';
  for (const file of review.files) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length);
    const name = relative.split('/')[0];
    const path = `${prefix}${name}`;
    if (!name || nodes.some((node) => node.path === path)) continue;
    nodes.push({
      id: path, path, name, kind: relative.includes('/') ? 'folder' : 'file',
      symbols: 0, lines: 0, files: 0, outside: 0, callsIn: 0, callsOut: 0,
    });
  }
  return { ...folder, nodes };
}

export function commitFilesForNode(node: MapNode, review: GitCommitReview): CommitReviewFile[] {
  if (node.path === undefined) return [];
  const path = normalizeReviewPath(node.path);
  if (node.kind === 'file' || node.kind === 'symbol' || node.kind === 'center') {
    return review.files.filter((file) => file.path === path || file.oldPath === path);
  }
  if (node.kind !== 'folder' && node.kind !== 'module') return [];
  const prefix = path ? `${path}/` : '';
  return review.files.filter((file) => {
    const matches = (value: string) => value.startsWith(prefix)
      && (!node.module?.loose || !value.slice(prefix.length).includes('/'));
    return matches(file.path) || Boolean(file.oldPath && matches(file.oldPath));
  });
}

export function commitNodeLabel(node: MapNode, review: GitCommitReview): string | null {
  const files = commitFilesForNode(node, review);
  if (!files.length) return null;
  const status = node.kind === 'file' || node.kind === 'symbol' || node.kind === 'center'
    ? files[0].status : `${files.length} changed`;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return `${status} · +${additions} −${deletions}`;
}
