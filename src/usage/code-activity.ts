import { getWorkspacePath } from '../state/workspace';
import { countLineChangeStats } from '../chat/prompts/text-diff';
import { randomUUID } from '../lib/random-id';
import { getFileTreeListingWorkspaceRoot } from '../ui/file-tree-listing-root';

export type ActivitySource = 'all' | 'agent' | 'completions';
export interface ActivityDay { day: string; source: string; additions: number; deletions: number }
export interface ActivityEvent extends ActivityDay { id: string; at: string; paths: string[]; chatId?: string; workspace: string }
export interface CodeActivity { trackingSince: string; days: ActivityDay[]; events: ActivityEvent[] }

export async function fetchCodeActivity(workspace: string, source: ActivitySource = 'all', day?: string): Promise<CodeActivity> {
  const query = new URLSearchParams({ workspace, source, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (day) query.set('day', day);
  const response = await fetch(`/api/activity?${query}`);
  if (!response.ok) throw new Error('Code activity is unavailable');
  return response.json();
}

/** Record accepted buffer edits once. Saving the buffer is not another AI edit. */
export function recordAcceptedCodeEdit(filePath: string, before: string, after: string, source: 'agent' | 'completions'): void {
  const workspace = getFileTreeListingWorkspaceRoot() || getWorkspacePath();
  if (!workspace || !filePath || before === after) return;
  const event = { id: randomUUID(), source, ...countLineChangeStats(before, after), paths: [filePath] };
  const url = `/api/activity?${new URLSearchParams({ workspace })}`;
  void (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
        if (!response.ok) throw new Error('Activity could not be saved');
        return;
      } catch (error) {
        if (attempt === 1) console.warn('[activity] Accepted edit could not be recorded', error);
      }
    }
  })();
}
