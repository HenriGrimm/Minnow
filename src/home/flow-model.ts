import type { Chat, HomeIssueRun, IssueCard } from '../types';
import type { IssuesTaxonomy } from '../issues/taxonomy';
import { isUnreviewedTriageIssue } from '../issues/triage';

export const FLOW_COLUMNS = [
  ['triage', 'Triage'], ['ready', 'Ready'], ['progress', 'In Progress'], ['review', 'Review'], ['done', 'Done'],
] as const;
export type FlowColumn = typeof FLOW_COLUMNS[number][0];
export type GroupMode = 'files' | 'each' | 'one';

export function flowColumn(issue: IssueCard, taxonomy: IssuesTaxonomy): FlowColumn | null {
  const status = taxonomy.statuses.find(s => s.id === issue.status);
  if (status?.role === 'canceled') return null;
  if (status?.role === 'done' || issue.agent?.home?.state === 'done') return 'done';
  if (issue.agent?.home?.boardId) return status?.role === 'review' ? 'review' : 'progress';
  if (issue.agent?.home?.state === 'planned') return 'ready';
  if (issue.agent?.home && ['ready', 'conflict', 'mergequeued', 'merging'].includes(issue.agent.home.state)) return 'review';
  if (status?.role === 'review') return 'review';
  if (issue.agent?.home && issue.agent.home.state !== 'held' || status?.role === 'in_progress') return 'progress';
  if (status?.role === 'triage' || isUnreviewedTriageIssue(issue)) return 'triage';
  return 'ready';
}

export function blockers(issue: IssueCard, issues: readonly IssueCard[], taxonomy: IssuesTaxonomy): IssueCard[] {
  return (issue.issueRefs ?? []).filter(ref => ref.kind === 'blocked-by')
    .map(ref => issues.find(i => i.id === ref.issueId))
    .filter((i): i is IssueCard => Boolean(i && !taxonomy.statuses.find(s => s.id === i.status)?.isClosed && i.agent?.home?.state !== 'done'));
}

/** Connected components of actual linked files, including transitive overlaps. Unlinked issues stay separate. */
export function groupIssues(issues: IssueCard[], mode: GroupMode): IssueCard[][] {
  if (!issues.length) return [];
  if (mode === 'one') return [issues];
  if (mode === 'each') return issues.map(i => [i]);
  const groups: IssueCard[][] = [];
  const paths = (issue: IssueCard) => new Set((issue.codeRefs ?? []).map(r => r.path.replace(/\\/g, '/').replace(/^\.\//, '')));
  for (const issue of issues) {
    const files = paths(issue);
    const overlaps = groups.filter(group => group.some(member => [...paths(member)].some(p => files.has(p))));
    const joined = [issue, ...overlaps.flat()];
    for (const group of overlaps) groups.splice(groups.indexOf(group), 1);
    groups.push(joined);
  }
  return groups;
}

export function issueChat(issue: IssueCard, chats: readonly Chat[]): Chat | undefined {
  return chats.find(c => c.id === (issue.agent?.chatId || issue.chatIds?.at(-1)));
}

export function batchIssues(issues: IssueCard[]): IssueCard[][] {
  const groups = new Map<string, IssueCard[]>();
  for (const issue of issues) {
    const key = issue.agent?.home?.groupId || issue.id;
    const group = groups.get(key) ?? []; group.push(issue); groups.set(key, group);
  }
  return [...groups.values()];
}

export function stateLabel(state: HomeIssueRun['state'] | undefined, phase?: string): string {
  if (!state) return phase === 'awaiting_input' ? 'needs your answer' : phase === 'review' ? 'ready for review' : phase === 'running' ? 'working' : phase === 'failed' ? 'needs attention' : 'not started';
  return ({ held: 'held', waitslot: 'queued · waiting for a slot', working: phase === 'awaiting_input' ? 'needs your answer' : 'working', paused: 'paused', planned: 'Planned', ready: 'ready for review', conflict: 'merge conflict', rebasing: 'rebasing', mergequeued: 'queued to merge', merging: 'merging', done: 'merged', failed: 'needs attention' })[state];
}

export interface DraftTask { title: string; description: string; files: string[] }
export function parseDraftTasks(text: string): DraftTask[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('The model did not return tasks. Try again.');
  const value = JSON.parse(match[0]) as { tasks?: unknown[] };
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 20) throw new Error('Expected between 1 and 20 draft tasks.');
  return value.tasks.map(raw => {
    const row = raw as Record<string, unknown>;
    if (typeof row?.title !== 'string' || !row.title.trim()) throw new Error('A draft task is missing its title.');
    return { title: row.title.trim().slice(0, 240), description: typeof row.description === 'string' ? row.description.trim() : '', files: Array.isArray(row.files) ? row.files.filter((p): p is string => typeof p === 'string' && Boolean(p.trim())).slice(0, 30) : [] };
  });
}
