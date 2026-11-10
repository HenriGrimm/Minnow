import '../styles/graphite-new-thread.css';
import { isReviewStatus, isTriageStatus } from '../issues/taxonomy';
import { openNotificationTarget } from '../notifications/navigate';
import { getNotifications, subscribeNotifications } from '../notifications/store';
import { launchApp } from '../os/router';
import { subscribeIssuesChanges } from '../state/issues-events';
import { collectIssues, getOpenIssueStatuses, isIssuesStoreLoaded } from '../state/issues-store';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import { isHubMounted, teardownHub } from './hub';
import { createIcon } from './icon';
import { getWorkspaceGitSummary } from './sidebar-git-state';

export function mountGraphiteNewThread(): (visible: boolean) => void {
  const main = document.getElementById('mainColumn');
  if (!main) return () => undefined;
  if (isHubMounted()) teardownHub();
  const composer = main.querySelector(':scope > .input-bar');
  if (!composer) return () => undefined;
  const intro = document.createElement('section');
  intro.className = 'graphite-new-thread__intro';
  const heading = document.createElement('h2');
  heading.textContent = 'What should we build?';
  const workspace = document.createElement('p');
  intro.append(heading, workspace);

  const context = document.createElement('div');
  context.className = 'graphite-new-thread__context';
  const ready = document.createElement('section');
  const recent = document.createElement('section');
  context.append(ready, recent);
  composer.before(intro);
  const metrics = main.querySelector('#statsStrip');
  (metrics ?? composer).after(context);

  function button(label: string, run: () => void): HTMLButtonElement {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', run);
    return control;
  }
  function empty(container: HTMLElement, text: string): void {
    const message = document.createElement('p');
    message.textContent = text;
    container.append(message);
  }
  function refresh(): void {
    if (!main?.classList.contains('graphite-new-thread')) return;
    const path = getWorkspacePath();
    const branch = getWorkspaceGitSummary(path)?.branch;
    workspace.textContent = getWorkspaceLabel() || 'Workspace';
    if (branch) {
      const name = document.createElement('code');
      name.append(createIcon('gitBranch', { size: 12 }), branch);
      workspace.append(' · ', name);
    }
    const readyHeading = document.createElement('div');
    readyHeading.className = 'graphite-new-thread__section-title';
    const readyTitle = document.createElement('h3');
    readyTitle.textContent = 'Ready to pick up';
    readyHeading.append(readyTitle, button('All issues', () => launchApp('issues')));
    ready.replaceChildren(readyHeading);
    const taxonomy = getIssuesTaxonomySync();
    const open = getOpenIssueStatuses();
    const issues = (isIssuesStoreLoaded() ? collectIssues({ workspacePath: path }) : []).filter(issue => open.includes(issue.status) &&
      !isTriageStatus(taxonomy, issue.status) && !isReviewStatus(taxonomy, issue.status) &&
      !issue.chatIds?.length && !issue.boardChatId && !issue.agent).slice(0, 3);
    for (const issue of issues) {
      const row = button(issue.title, () => {
        void import('./issues-page').then(({ openIssues }) => openIssues({ issueId: issue.id }));
      });
      const code = document.createElement('code');
      code.textContent = issue.id;
      row.prepend(code);
      row.append(createIcon('chevronRight', { size: 14 }));
      ready.append(row);
    }
    if (!issues.length) empty(ready, 'No issues ready to pick up.');

    const recentTitle = document.createElement('h3');
    recentTitle.textContent = 'Since you left';
    recent.replaceChildren(recentTitle);
    const notifications = getNotifications().filter(item => !item.read &&
      (!item.workspacePath || item.workspacePath === path)).slice(0, 3);
    for (const item of notifications) {
      const row = button(item.title, () => void openNotificationTarget(item));
      row.prepend(createIcon('bell', { size: 14 }));
      recent.append(row);
    }
    if (!notifications.length) empty(recent, 'No unread activity.');
  }

  subscribeNotifications(refresh);
  subscribeIssuesChanges(refresh);
  return visible => {
    main.classList.toggle('graphite-new-thread', visible);
    intro.hidden = context.hidden = !visible;
    if (visible) refresh();
  };
}
