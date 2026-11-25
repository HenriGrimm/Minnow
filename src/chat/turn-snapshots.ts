import { reportBackgroundError } from '../boot/report-background-error';
import {
  gitSnapshotCreate,
  type GitOpResult,
} from '../state/git-api';
import { annotateRunSnapshots } from '../state/runs-store';
import { sessionState } from '../state/sessions';
import { resolveChatToolWorkspaceRoot } from '../state/chat-worktree';
import { getWorkspacePath } from '../state/workspace';
import type { Chat, TurnRunId } from '../types';

type SnapshotCreateFn = (input?: {
  cwd?: string;
  message?: string;
}) => Promise<GitOpResult>;

/** Production default; tests may override via {@link setSnapshotCreateForTests}. */
let snapshotCreateImpl: SnapshotCreateFn = gitSnapshotCreate;

/** Test seam — replace dangling-commit create without mocking all of git-api. */
export function setSnapshotCreateForTests(fn: SnapshotCreateFn | null): void {
  snapshotCreateImpl = fn ?? gitSnapshotCreate;
}

export function shouldCaptureTurnSnapshots(chat: Chat): boolean {
  return !chat.worktreeRoot?.trim();
}

export function resolveTurnSnapshotCwd(chat: Chat): string | undefined {
  if (!shouldCaptureTurnSnapshots(chat)) return undefined;

  const groups = sessionState?.groups;
  const scoped = resolveChatToolWorkspaceRoot(chat, groups);
  if (scoped?.trim()) return scoped.trim();

  const bound = chat.workspacePath?.trim();
  if (bound) return bound;

  const live = getWorkspacePath().trim();
  return live || undefined;
}

/** Create a pre-turn dangling snapshot and annotate the run. */
export async function capturePreTurnSnapshot(
  chat: Chat,
  runId: TurnRunId,
): Promise<void> {
  const cwd = resolveTurnSnapshotCwd(chat);
  if (!cwd) return;

  try {
    const result = await snapshotCreateImpl({
      cwd,
      message: `minnow turn pre ${runId}`,
    });
    if (!result.ok || !result.sha) return;
    annotateRunSnapshots(chat, runId, {
      preTurnSnapshotSha: result.sha,
      ...(result.headSha ? { headShaAtTurn: result.headSha } : {}),
      snapshotCwd: cwd,
    });
  } catch (err) {
    reportBackgroundError('turn-snapshot-pre', err);
  }
}

/** Create a post-turn dangling snapshot and annotate the run. */
export async function capturePostTurnSnapshot(
  chat: Chat,
  runId: TurnRunId,
): Promise<void> {
  const cwd = resolveTurnSnapshotCwd(chat);
  if (!cwd) return;

  try {
    const result = await snapshotCreateImpl({
      cwd,
      message: `minnow turn post ${runId}`,
    });
    if (!result.ok || !result.sha) return;
    annotateRunSnapshots(chat, runId, {
      postTurnSnapshotSha: result.sha,
      snapshotCwd: cwd,
    });
  } catch (err) {
    reportBackgroundError('turn-snapshot-post', err);
  }
}
