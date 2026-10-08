import { randomUUID } from '../lib/random-id';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';

/** Transient, renderer-owned expansion activity shared with other app windows. */
const local = new Set<string>();
const remote = new Map<string, string[]>();
const revisions = new Map<string, number>();
let revision = 0;
const owner = randomUUID();
let channel: BroadcastChannel | undefined;

function paint(): void {
  document.querySelectorAll<HTMLElement>('[data-issue-expansion-activity]').forEach((slot) => {
    const busy = isIssueBackgroundExpanding(slot.dataset.issueExpansionActivity ?? '', slot.dataset.issueActivityWorkspace);
    slot.hidden = !busy;
    slot.setAttribute('aria-busy', String(busy));
  });
}

function init(): void {
  if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('minnow.issue-expansion');
  channel.onmessage = ({ data }) => {
    if (!data || data.owner === owner) return;
    if (data.kind === 'request') publish();
    if (data.kind === 'snapshot' && typeof data.owner === 'string' && Array.isArray(data.ids)
      && typeof data.revision === 'number' && data.revision > (revisions.get(data.owner) ?? -1)) {
      revisions.set(data.owner, data.revision);
      remote.set(data.owner, data.ids.filter((id: unknown) => typeof id === 'string'));
      paint();
    }
  };
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  channel.postMessage({ kind: 'request', owner });
  window.addEventListener('pagehide', disposeIssueBackgroundActivity, { once: true });
}

function publish(): void {
  channel?.postMessage({ kind: 'snapshot', owner, revision: ++revision, ids: [...local] });
}

/** Closing the originating window withdraws its transient activity. */
export function disposeIssueBackgroundActivity(): void {
  local.clear();
  publish();
  channel?.close();
  channel = undefined;
  remote.clear();
  revisions.clear();
  window.removeEventListener('pagehide', disposeIssueBackgroundActivity);
  paint();
}

function key(id: string, workspacePath = ''): string {
  return `${normalizeWorkspacePath(workspacePath)}::${id}`;
}

export function isIssueBackgroundExpanding(id: string, workspacePath = ''): boolean {
  const issueKey = key(id, workspacePath);
  return local.has(issueKey) || [...remote.values()].some((ids) => ids.includes(issueKey));
}

export function setIssueBackgroundExpanding(id: string, busy: boolean, workspacePath = ''): void {
  init();
  if (busy) local.add(key(id, workspacePath));
  else local.delete(key(id, workspacePath));
  publish();
  paint();
}

/** A stable slot updated in place, so activity never remounts an issue editor. */
export function createIssueExpansionActivity(id: string, workspacePath = ''): HTMLElement {
  init();
  const slot = document.createElement('span');
  slot.className = 'issues-expansion-activity';
  slot.dataset.issueExpansionActivity = id;
  slot.dataset.issueActivityWorkspace = workspacePath;
  slot.setAttribute('role', 'status');
  slot.hidden = !isIssueBackgroundExpanding(id, workspacePath);
  slot.innerHTML = '<span class="issues-expansion-activity__spinner" aria-hidden="true"></span>Expanding';
  return slot;
}
