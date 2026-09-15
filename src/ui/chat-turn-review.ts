import type { Chat } from '../types';
import { getPerFileChangeSummary } from '../usage/code-change-ledger';
import { openGitCommitDiffPanel, openRecordedChangesDiffPanel } from './git-commit-diff-panel';
import type { GitPatchFileEntry } from './git-patch-files';

export async function reviewTurnChanges(chat: Chat, start: number, end: number) {
  const messages = chat.history.slice(start, end + 1);
  const commit = [...messages].reverse().find((msg) => msg.role === 'tool' && msg.codeChange?.source === 'git-commit');
  if (commit?.role === 'tool') {
    // Older transcripts predate commitSha; Git's own commit output includes the revision.
    const sha = commit.codeChange?.commitSha ?? commit.content.match(/\[[^\]\n]+\s([a-f0-9]{7,40})\]/i)?.[1];
    if (sha) return openGitCommitDiffPanel({ sha, cwd: chat.workspacePath });
  }
  const entries: GitPatchFileEntry[] = getPerFileChangeSummary(chat, start, end).map((file) => ({
    path: file.path,
    binary: false,
    notice: !file.diffChunks.length ? 'This change has no recorded diff. Open the file or review its commit in Git history.'
      : file.diffChunks.some((chunk) => chunk.truncated) ? 'Recorded diff is truncated.' : undefined,
    patch: file.diffChunks.map(({ lines }) => {
      const oldCount = lines.filter((line) => line.type !== 'add').length;
      const newCount = lines.filter((line) => line.type !== 'remove').length;
      return `@@ -1,${oldCount} +1,${newCount} @@\n` + lines.map((line) =>
        `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`).join('\n');
    }).join('\n'),
  }));
  return openRecordedChangesDiffPanel(entries);
}
