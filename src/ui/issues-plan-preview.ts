import { readWorkspaceTextFile } from '../attachments/workspace-text-read';
import { readPlanType } from '../../server/orchestrator/core/plan-format.js';
import type { IssueCard } from '../types';
import { readSavedIssuePlan, type SavedIssuePlan } from '../issues/saved-plan';
import { mountPlanPreviewContent } from '../chat/plans/plan-preview';
import { inferIssuePlanPath } from '../issues/plan-attach';

/** Read the saved plan from the checkout that owns the issue's planning chat. */
export function mountIssuePlanPreview(host: HTMLElement, onPlanChange?: (plan: SavedIssuePlan | null) => void): { update: (issue: IssueCard) => void; open: (issue: IssueCard, path: string, workspaceRoot: string) => void; dispose: () => void } {
  let disposed = false, revision = 0, signature = '';
  const section = document.createElement('section');
  section.className = 'issues-plan-preview';
  section.setAttribute('aria-label', 'Issue plan');
  const heading = document.createElement('h3'); heading.textContent = 'Plan';
  const pathLabel = document.createElement('p'); pathLabel.className = 'issues-plan-preview__path';
  const content = document.createElement('div'); content.className = 'issues-plan-preview__content';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry loading plan';
  section.append(heading, pathLabel, content, retry); section.hidden = true; host.append(section);
  let current: IssueCard | undefined;
  let openedSource: { path: string; workspaceRoot: string } | undefined;
  retry.onclick = () => { if (!current) return; if (openedSource) open(current, openedSource.path, openedSource.workspaceRoot); else { signature = ''; update(current); } };

  async function load(issue: IssueCard, request: number, source?: { path: string; workspaceRoot: string }): Promise<void> {
    const loadSignature = signature;
    try {
      const plan = source ? await readOpenedPlan(source) : await readSavedIssuePlan(issue);
      if (disposed) return;
      if (!source && loadSignature === signature) onPlanChange?.(plan);
      if (request !== revision) return;
      pathLabel.textContent = plan.path;
      mountPlanPreviewContent(content, plan.markdown, { modeId: 'plan' });
    } catch {
      if (disposed || request !== revision) return;
      content.textContent = 'Could not load the saved plan. Retry when its checkout is available.';
      retry.hidden = false;
    }
  }

  function update(issue: IssueCard): void {
    if (disposed) return;
    current = issue;
    const planned = issue.agent?.home?.state === 'planned';
    const path = inferIssuePlanPath(issue);
    const next = JSON.stringify([issue.id, path, planned, issue.agent?.home?.state, issue.agent?.updatedAt, issue.agent?.chatId, issue.chatIds]);
    if (next === signature) return;
    signature = next; openedSource = undefined; const request = ++revision;
    onPlanChange?.(null);
    section.hidden = !path && !planned;
    if (section.hidden) return;
    pathLabel.textContent = path || ''; content.textContent = 'Loading plan…'; retry.hidden = true;
    void load(issue, request);
  }
  async function readOpenedPlan(source: { path: string; workspaceRoot: string }): Promise<SavedIssuePlan> {
    const markdown = await readWorkspaceTextFile(source.path, source.workspaceRoot, Date.now());
    return { ...source, markdown, type: readPlanType(markdown) };
  }

  function open(issue: IssueCard, path: string, workspaceRoot: string): void {
    if (disposed) return;
    current = issue; openedSource = { path, workspaceRoot };
    section.hidden = false; pathLabel.textContent = path; content.textContent = 'Loading plan…'; retry.hidden = true;
    void load(issue, ++revision, openedSource);
    section.scrollIntoView?.({ block: 'nearest' });
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
  }

  return { update, open, dispose() { disposed = true; revision++; section.remove(); } };
}
