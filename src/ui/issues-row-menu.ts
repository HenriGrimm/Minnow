import type { IssueCard } from '../types';
import { canRunIssueWorkflow, ISSUE_FOREGROUND_CHAT_MODES, runIssueForegroundChat } from '../chat/issues/pipeline';
import { getMode } from '../chat/modes/registry';
import type { ChatRunTargetChoice } from '../state/chat-worktree';
import type { IssueForegroundChatMode } from '../chat/issues/workflow-seeds';
import { lastIssueMenuOrigin, promptIssueChatRunTarget } from './issues-chat-run-target';
import { canExpandIssueDraft } from '../chat/issues/expand-issue-guards';
import { canExpandIssueWithAgent } from '../chat/issues/expand-task';
import { sortedPriorities, sortedTypes } from '../issues/taxonomy';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { assignIssueToMe, collectIssueLabelSuggestions, findIssueById, listIssueProjects, updateIssue } from '../state/issues-store';
import { subIssueMenuItems } from './issues-sub-issues';
import { isIssueDraftExpanding, startIssueExpandFromUi } from './issues-expand-controls';
import { isIssueExpanding, expandIssueFromUi, refreshIssueDetailIfOpen } from './issues-detail';
import { appPrompt } from './app-dialog';
import type { IssuesContextMenuItem } from './issues-context-menu';

export interface IssueRowMenuActions {
  checked: boolean;
  open: () => void;
  toggleSelection: () => void;
  statusOptions: () => Array<{ id: string; label: string; iconClass: string }>;
  render: () => void;
  delete: () => Promise<void>;
}

/** Build context menu items for a list row or board card. */
export function buildIssueRowMenuItems(
  issue: IssueCard,
  targetIds: string[],
  actions: IssueRowMenuActions,
  options?: { view: () => void; edit: () => void },
): IssuesContextMenuItem[] {
  const singleTarget = targetIds.length === 1;
  const isChecked = actions.checked;
  const workflowOk = canRunIssueWorkflow(issue);
  const workflowBusy = workflowBusyIds.has(issue.id);
  const items: IssuesContextMenuItem[] = [
    {
      id: 'open',
      label: options ? 'View' : 'Open',
      disabled: !singleTarget,
      onSelect: options?.view ?? (() => actions.open()),
    },
    {
      id: 'copy-id',
      label: singleTarget ? 'Copy ID' : `Copy ${targetIds.length} IDs`,
      onSelect: () => void copyTextToClipboard(targetIds.join(', ')),
    },
    {
      id: 'select',
      label: isChecked ? 'Deselect' : 'Select',
      onSelect: () => {
        actions.toggleSelection();
      },
    },
  ];
  if (options) {
    items.splice(1, 0, { id: 'edit', label: 'Edit in Issues', onSelect: options.edit });
    items.splice(items.findIndex((item) => item.id === 'select'), 1);
  }
  if (singleTarget) items.push({
    id: 'copy-issue', label: 'Copy issue',
    onSelect: async () => {
      const { formatIssueForClipboard } = await import('../issues/clipboard');
      await copyTextToClipboard(formatIssueForClipboard(findIssueById(issue.id) ?? issue, {
        taxonomy: getIssuesTaxonomySync(),
        projectName: listIssueProjects().find((project) => project.id === issue.projectId)?.name,
      }));
    },
  });

  if (singleTarget && canExpandIssueDraft(issue)) {
    items.push({
      id: 'expand',
      label: isIssueDraftExpanding(issue.id) ? 'Expanding…' : 'Expand',
      hint: 'Fill title and description from this card',
      onSelect: () => void startIssueExpandFromUi(issue.id),
    });
  }

  if (singleTarget && canExpandIssueWithAgent(issue)) {
    items.push({
      id: 'expand-agent',
      label: isIssueExpanding(issue.id) ? 'Expanding with agent…' : 'Expand with agent',
      hint: 'Research the workspace and write the card',
      disabled: isIssueExpanding(issue.id),
      onSelect: () => void expandIssueFromUi(issue.id).then(() => actions.render()),
    });
  }

  if (singleTarget) {
    const subItems = subIssueMenuItems(issue);
    if (subItems.length > 0) {
      subItems[0] = { ...subItems[0], separatorBefore: true };
      items.push(...subItems);
    }
  }

  if (singleTarget) {
    items.push({
      id: 'send-to-chat',
      label: 'Send to chat',
      separatorBefore: true,
      disabled: !workflowOk || workflowBusy,
      submenu: () => buildForegroundChatSubmenuItems(issue, actions.render),
    });
  }

  items.push({
    id: 'change-status',
    label: singleTarget ? 'Change status' : `Change status (${targetIds.length})`,
    separatorBefore: true,
    submenu: () =>
      actions.statusOptions().map((status) => ({
        id: status.id,
        label: status.label,
        iconClass: status.iconClass,
        onSelect: () => {
          for (const id of targetIds) {
            updateIssue(id, { status: status.id });
          }
          actions.render();
        },
      })),
  });

  const patchTargets = (patch: Parameters<typeof updateIssue>[1]) => {
    for (const id of targetIds) updateIssue(id, patch);
    actions.render();
  };
  items.push(
    { id: 'change-priority', label: 'Priority', submenu: () => sortedPriorities(getIssuesTaxonomySync()).map((entry) => ({
      id: entry.id, label: entry.label, onSelect: () => patchTargets({ priority: entry.id }),
    })) },
    { id: 'change-type', label: 'Type', submenu: () => sortedTypes(getIssuesTaxonomySync()).map((entry) => ({
      id: entry.id, label: entry.label, onSelect: () => patchTargets({ type: entry.id }),
    })) },
    { id: 'change-assignee', label: 'Assignee', submenu: [
      { id: 'me', label: 'Me', onSelect: () => { for (const id of targetIds) assignIssueToMe(id); actions.render(); } },
      { id: 'unassigned', label: 'Unassigned', onSelect: () => patchTargets({ assignee: null }) },
    ] },
    { id: 'change-project', label: 'Project', submenu: () => [
      { id: 'none', label: 'No project', onSelect: () => patchTargets({ projectId: null }) },
      ...listIssueProjects().map((project) => ({ id: project.id, label: project.name, onSelect: () => patchTargets({ projectId: project.id }) })),
    ] },
    { id: 'change-labels', label: 'Labels', submenu: () => [
      ...collectIssueLabelSuggestions(issue.id).map((label) => ({
        id: `label-${label}`, label,
        onSelect: () => {
          for (const id of targetIds) {
            const current = findIssueById(id);
            if (!current) continue;
            const has = current.labels.some((value) => value.toLowerCase() === label.toLowerCase());
            updateIssue(id, { labels: has ? current.labels.filter((value) => value.toLowerCase() !== label.toLowerCase()) : [...current.labels, label] });
          }
          actions.render();
        },
      })),
      { id: 'new-label', label: 'New label…', onSelect: async () => {
        const label = await appPrompt('Label name', '', { title: 'New label' });
        if (!label?.trim()) return;
        for (const id of targetIds) {
          const current = findIssueById(id);
          if (current) updateIssue(id, { labels: [...current.labels, label.trim()] });
        }
        actions.render();
      } },
    ] },
  );
  if (singleTarget && issue.github?.url) items.push({
    id: 'open-github', label: 'Open in GitHub', separatorBefore: true,
    onSelect: () => { void import('../chat/issues/git-actions').then((m) => m.openExternalGitUrl(issue.github!.url)); },
  });
  items.push({
    id: 'delete',
    label: singleTarget ? 'Delete' : `Delete ${targetIds.length} issues`,
    danger: true,
    separatorBefore: true,
    onSelect: () => void actions.delete(),
  });

  return items;
}

const FOREGROUND_CHAT_HINTS: Record<IssueForegroundChatMode, string> = {
  general: 'Triage and discuss with full tool access',
  build: 'Implement or iterate on a fix',
  plan: 'Interactive planning chat in Code',
  debug: 'Reproduce and narrow root cause',
};

/** Issue ids with a workflow action in flight from the list context menu. */
const workflowBusyIds = new Set<string>();

async function runIssueWorkflowFromMenu(
  issueId: string,
  modeId: IssueForegroundChatMode,
  runTarget: ChatRunTargetChoice,
  render: () => void,
): Promise<void> {
  if (workflowBusyIds.has(issueId)) return;
  workflowBusyIds.add(issueId);
  const { showToast } = await import('./toast');
  try {
    const result = await runIssueForegroundChat(issueId, modeId, runTarget);
    if (!result.ok) {
      showToast(result.error || 'Send to chat failed', 'error');
      return;
    }
    if (modeId === 'plan') {
      showToast(
        result.planPath ? `Plan chat · ${result.planPath}` : 'Plan chat opened',
        'success',
      );
    } else {
      showToast(`${getMode(modeId).label} chat opened`, 'success');
    }
  } finally {
    workflowBusyIds.delete(issueId);
    render();
    refreshIssueDetailIfOpen();
  }
}

function buildForegroundChatSubmenuItems(issue: IssueCard, render: () => void): IssuesContextMenuItem[] {
  const workflowOk = canRunIssueWorkflow(issue);
  const busy = workflowBusyIds.has(issue.id);
  return ISSUE_FOREGROUND_CHAT_MODES.map((modeId) => ({
    id: modeId,
    label: getMode(modeId).label,
    hint: FOREGROUND_CHAT_HINTS[modeId],
    disabled: !workflowOk || busy,
    onSelect: () => {
      const origin = lastIssueMenuOrigin();
      promptIssueChatRunTarget({
        issueId: issue.id,
        anchor: origin.anchor,
        clientX: origin.clientX,
        clientY: origin.clientY,
        onPick: (choice) =>
          void runIssueWorkflowFromMenu(issue.id, modeId, choice, render),
      });
    },
  }));
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    const { showToast } = await import('./toast');
    showToast('Copied to clipboard');
  } catch {
    const { showToast } = await import('./toast');
    showToast('Could not copy to clipboard', 'error');
  }
}

