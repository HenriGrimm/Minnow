import type { Command } from './command-registry';
import type { IssuesGroupBy } from '../issues/grouping';
import { ISSUES_GROUP_BY_OPTIONS } from '../issues/grouping';
import {
  BUILTIN_VIEW_AGENTS,
  BUILTIN_VIEW_MY_OPEN,
  BUILTIN_VIEW_TRIAGE,
  SESSION_VIEW_ALL,
} from '../issues/saved-views';

export type IssuesCommandHost = {
  isOpen: () => boolean;
  newIssue: () => void;
  setViewMode: (mode: 'list' | 'board') => void;
  setGroupBy: (groupBy: IssuesGroupBy) => void;
  setActiveView: (viewId: string) => void;
  goToFocused: () => void;
  expandFocused: () => void;
  acceptTriage: () => void;
  declineTriage: () => void;
  listUserViews: () => Array<{ id: string; name: string }>;
};

export function buildIssuesCommands(host: IssuesCommandHost): Command[] {
  if (!host.isOpen()) return [];

  const commands: Command[] = [
    {
      id: 'issues.new',
      title: 'New issue',
      group: 'Issues',
      keywords: 'create add capture',
      shortcut: 'C',
      run: () => host.newIssue(),
    },
    {
      id: 'issues.view.list',
      title: 'Show list',
      group: 'Issues',
      run: () => host.setViewMode('list'),
    },
    {
      id: 'issues.view.board',
      title: 'Show board',
      group: 'Issues',
      run: () => host.setViewMode('board'),
    },
    {
      id: 'issues.view.all',
      title: 'View: All',
      group: 'Issues',
      run: () => host.setActiveView(SESSION_VIEW_ALL),
    },
    {
      id: 'issues.view.triage',
      title: 'View: Triage',
      group: 'Issues',
      keywords: 'inbox unreviewed',
      run: () => host.setActiveView(BUILTIN_VIEW_TRIAGE),
    },
    {
      id: 'issues.view.agents',
      title: 'View: Assigned to agents',
      group: 'Issues',
      run: () => host.setActiveView(BUILTIN_VIEW_AGENTS),
    },
    {
      id: 'issues.view.mine',
      title: 'View: My open',
      group: 'Issues',
      run: () => host.setActiveView(BUILTIN_VIEW_MY_OPEN),
    },
    {
      id: 'issues.open-focused',
      title: 'Open selected issue',
      group: 'Issues',
      shortcut: 'Enter',
      run: () => host.goToFocused(),
    },
    {
      id: 'issues.expand',
      title: 'Expand issue',
      group: 'Issues',
      keywords: 'sparkles rewrite fill title description',
      shortcut: 'E',
      run: () => host.expandFocused(),
    },
    {
      id: 'issues.triage.accept',
      title: 'Accept triage issue',
      group: 'Issues',
      shortcut: 'Y',
      keywords: 'promote backlog',
      run: () => host.acceptTriage(),
    },
    {
      id: 'issues.triage.decline',
      title: 'Decline triage issue',
      group: 'Issues',
      shortcut: 'N',
      keywords: 'cancel reject',
      run: () => host.declineTriage(),
    },
  ];

  for (const option of ISSUES_GROUP_BY_OPTIONS) {
    commands.push({
      id: `issues.group.${option.id}`,
      title: `Group by ${option.label}`,
      group: 'Issues',
      run: () => host.setGroupBy(option.id),
    });
  }

  for (const view of host.listUserViews()) {
    commands.push({
      id: `issues.view.user.${view.id}`,
      title: `View: ${view.name}`,
      group: 'Issues',
      run: () => host.setActiveView(view.id),
    });
  }

  return commands;
}
