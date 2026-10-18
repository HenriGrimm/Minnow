import type { HomeIssueRun } from '../types';
const STATES = new Set(['held', 'waitslot', 'working', 'paused', 'planned', 'ready', 'conflict', 'rebasing', 'mergequeued', 'merging', 'done', 'failed']);
export function parseHomeIssueRun(raw: unknown): HomeIssueRun | undefined {
  if (!raw || typeof raw !== 'object') return;
  const row = raw as Record<string, unknown>;
  if (typeof row.groupId !== 'string' || !row.groupId.trim() || typeof row.state !== 'string' || !STATES.has(row.state) || !['build', 'plan'].includes(String(row.mode)) || typeof row.modelId !== 'string' || !row.modelId.trim() || typeof row.baseBranch !== 'string' || !row.baseBranch.trim()) return;
  return { groupId: row.groupId.trim(), state: row.state as HomeIssueRun['state'], mode: row.mode as HomeIssueRun['mode'], modelId: row.modelId.trim(), baseBranch: row.baseBranch.trim(), ...(typeof row.boardId === 'string' && row.boardId.trim() ? { boardId: row.boardId.trim() } : {}), ...(typeof row.providerId === 'string' ? { providerId: row.providerId } : {}), ...(typeof row.instructions === 'string' ? { instructions: row.instructions } : {}), ...(row.startNow === true ? { startNow: true } : {}) };
}
