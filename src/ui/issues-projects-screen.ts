import { formatIssueAge } from '../issues/age';
import {
  addIssueProject,
  archiveIssueProject,
  issueProjectProgress,
  listIssueProjects,
  listIssues,
  renameIssueProject,
  restoreIssueProject,
} from '../state/issues-store';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { getWorkspacePath } from '../state/workspace';
import { gitBranches } from '../state/git-api';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { flowColumn, groupIssues } from '../home/flow-model';
import { createIssueStatusChip } from '../issues/type-icons';
import type { IssueCard, IssueProject } from '../types';
import { appConfirm, appPrompt } from './app-dialog';
import { createIcon } from './icon';
import { openContextMenu } from './context-menu';
import { showToast } from './toast';

export interface IssuesProjectsScreenOptions {
  onViewProject: (projectId: string) => void;
  onOpenIssue?: (issueId: string) => void;
}

const selectedProjects = new Map<string, string>();

function button(label: string, action: () => void, className = 'issues-btn'): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

function projectRow(project: IssueProject, options: IssuesProjectsScreenOptions): HTMLElement {
  const row = document.createElement('article');
  row.className = 'issues-project-row';
  row.dataset.projectId = project.id;

  const identity = document.createElement('div');
  identity.className = 'issues-project-row__identity';
  const name = document.createElement('h3');
  name.textContent = project.name;
  const description = document.createElement('p');
  description.textContent = project.description || 'No description';
  identity.append(name, description);

  const progress = issueProjectProgress(project.id);
  const progressWrap = document.createElement('div');
  progressWrap.className = 'issues-project-row__progress';
  const progressLabel = document.createElement('span');
  progressLabel.textContent = progress.total === 0
    ? 'No issues'
    : `${progress.done} of ${progress.total} done`;
  const progressBar = document.createElement('progress');
  progressBar.max = Math.max(progress.total, 1);
  progressBar.value = progress.done;
  progressBar.setAttribute('aria-label', `${project.name}: ${progressLabel.textContent}`);
  progressWrap.append(progressLabel, progressBar);

  const updated = document.createElement('span');
  updated.className = 'issues-project-row__updated';
  updated.textContent = `Updated ${formatIssueAge(project.updatedAt)}`;

  const actions = document.createElement('div');
  actions.className = 'issues-project-row__actions';
  if (project.archivedAt) {
    row.classList.add('is-archived');
    actions.append(button('Restore', () => restoreIssueProject(project.id)));
  } else {
    actions.append(
      button('View issues', () => options.onViewProject(project.id)),
      button('Rename', () => void renameProject(project)),
      button('Archive', () => void archiveProject(project), 'issues-btn issues-btn--quiet-danger'),
    );
  }

  row.append(identity, progressWrap, updated, actions);
  return row;
}

async function renameProject(project: IssueProject): Promise<void> {
  const nextName = await appPrompt('Project name', project.name);
  if (nextName == null || nextName.trim() === project.name) return;
  try {
    renameIssueProject(project.id, nextName);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not rename the project', 'error');
  }
}

async function archiveProject(project: IssueProject): Promise<void> {
  const confirmed = await appConfirm(
    `Archive “${project.name}”? Its issues stay available and can be reassigned.`,
    { title: 'Archive project', confirmLabel: 'Archive' },
  );
  if (confirmed) archiveIssueProject(project.id);
}

function projectSection(title: string, projects: IssueProject[], options: IssuesProjectsScreenOptions): HTMLElement {
  const section = document.createElement('section');
  section.className = 'issues-project-section';
  const heading = document.createElement('h2');
  heading.textContent = `${title} ${projects.length}`;
  const list = document.createElement('div');
  list.className = 'issues-project-list';
  list.setAttribute('role', 'list');
  for (const project of projects) {
    const row = projectRow(project, options);
    row.setAttribute('role', 'listitem');
    list.appendChild(row);
  }
  section.append(heading, list);
  return section;
}

async function startProjectIssues(issues: IssueCard[], mode: 'build' | 'plan'): Promise<void> {
  const workspace = getWorkspacePath();
  const count = `${issues.length} ready issue${issues.length === 1 ? '' : 's'}`;
  const planning = mode === 'plan';
  const title = planning ? 'Plan on a board' : 'Start ready issues';
  const body = document.createElement('ul');
  for (const issue of issues.slice(0, 6)) {
    const item = document.createElement('li');
    item.textContent = `${issue.id} · ${issue.title}`;
    body.append(item);
  }
  if (issues.length > 6) {
    const remaining = document.createElement('li');
    remaining.textContent = `${issues.length - 6} more`;
    body.append(remaining);
  }
  if (!await appConfirm(planning
    ? `Start a chat to prepare an Orchestrate plan for ${count}? You can review the plan in Issues before approving it.`
    : `Send ${count} to agents in isolated worktrees?`, { title, confirmLabel: planning ? 'Start planning' : 'Start issues', body })) return;

  try {
    const [branches, { captureLaunchModel }, { initHomeFlow, sendHomeIssues }] = await Promise.all([
      gitBranches(workspace, AbortSignal.timeout(10_000)),
      import('../models/launch-selection'),
      import('../home/flow-actions'),
    ]);
    const branch = branches.local?.find(name => name === 'main') ?? branches.local?.find(name => name === 'master');
    if (!branches.ok || !branch) throw new Error('Set up a local main or master branch in Source Control first.');
    const model = await captureLaunchModel('');
    if (!workspacePathsEqual(getWorkspacePath(), workspace)) return;
    initHomeFlow();
    const started = await sendHomeIssues(planning ? [issues] : groupIssues(issues, 'files'), {
      ...model,
      mode,
      baseBranch: branch,
      instructions: planning ? 'Create an executable Orchestrate board plan for these issues using the orchestrate-plan skill.' : undefined,
    });
    showToast(started.length ? `${started.length} issue${started.length === 1 ? '' : 's'} sent to ${planning ? 'planning' : 'agents'}` : 'Those issues are no longer ready');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not start project issues', 'error');
  }
}

function graphiteProjectDetail(project: IssueProject, issues: IssueCard[], options: IssuesProjectsScreenOptions): HTMLElement {
  const pane = document.createElement('section');
  pane.className = 'issues-graphite-projects__detail';
  const meta = document.createElement('p');
  meta.className = 'issues-graphite-projects__meta';
  meta.textContent = `Updated ${formatIssueAge(project.updatedAt)}`;
  const title = document.createElement('h2');
  title.textContent = project.name;
  const description = document.createElement('p');
  description.textContent = project.description || 'No description';
  description.className = 'issues-graphite-projects__description';
  const projectActions = document.createElement('div');
  projectActions.className = 'issues-graphite-projects__actions';
  const titleRow = document.createElement('div');
  titleRow.className = 'issues-graphite-projects__title';
  titleRow.append(title);
  const taxonomy = getIssuesTaxonomySync();
  if (project.archivedAt) {
    projectActions.append(button('Restore project', () => restoreIssueProject(project.id)));
  } else {
    const more = button('', () => openContextMenu({
      anchor: more,
      label: 'Project actions',
      items: [
        { id: 'view', label: 'View issues', onSelect: () => options.onViewProject(project.id) },
        { id: 'rename', label: 'Rename project', onSelect: () => void renameProject(project) },
        { id: 'archive', label: 'Archive project', onSelect: () => void archiveProject(project) },
      ],
    }));
    more.setAttribute('aria-label', 'Project actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.append(createIcon('more', { size: 15 }));
    titleRow.append(more);

    const workspace = getWorkspacePath();
    const ready = issues.filter((issue) => workspacePathsEqual(issue.workspacePath, workspace)
      && flowColumn(issue, taxonomy) === 'ready' && !issue.agent?.home && !issue.agent?.chatId);
    const start = button(`Start ${ready.length} ready`, () => void startProjectIssues(ready, 'build'));
    start.title = 'Review these ready issues before starting chats';
    const plan = button('Plan on a board', () => void startProjectIssues(ready, 'plan'), 'issues-btn issues-btn--primary');
    plan.prepend(createIcon('grid', { size: 14 }));
    plan.title = 'Review these ready issues and start a planning chat';
    start.disabled = plan.disabled = ready.length === 0;
    projectActions.append(start, plan);
  }

  const progress = issueProjectProgress(project.id);
  const completion = document.createElement('p');
  completion.className = 'issues-graphite-projects__completion';
  const percent = document.createElement('strong');
  percent.textContent = `${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%`;
  completion.append(percent, ` ${progress.done} of ${progress.total} done`);
  const statuses = taxonomy.statuses;
  const groups = new Map<string, IssueCard[]>();
  for (const issue of issues) {
    const group = groups.get(issue.status) ?? [];
    group.push(issue);
    groups.set(issue.status, group);
  }
  const ordered = new Set([...statuses.map((status) => status.id), ...groups.keys()]);
  const bar = document.createElement('div');
  bar.className = 'issues-graphite-projects__status-bar';
  bar.setAttribute('aria-hidden', 'true');
  const legend = document.createElement('ul');
  legend.className = 'issues-graphite-projects__legend';
  for (const id of ordered) {
    const members = groups.get(id);
    if (!members?.length) continue;
    const status = statuses.find((entry) => entry.id === id);
    const segment = document.createElement('span');
    const item = document.createElement('li');
    segment.dataset.role = item.dataset.role = status?.role ?? '';
    segment.style.flexGrow = String(members.length);
    bar.append(segment);
    item.textContent = `${status?.label ?? id} ${members.length}`;
    legend.append(item);
  }
  const actionsRow = document.createElement('div');
  actionsRow.className = 'issues-graphite-projects__section-head';
  const issuesHeading = document.createElement('h3');
  issuesHeading.textContent = 'Issues';
  actionsRow.append(issuesHeading, projectActions);
  pane.append(meta, titleRow, description, completion, bar, legend, actionsRow);

  for (const id of ordered) {
    const members = groups.get(id);
    if (!members?.length) continue;
    const group = document.createElement('section');
    group.className = 'issues-graphite-projects__group';
    const heading = document.createElement('h3');
    const status = statuses.find((entry) => entry.id === id);
    const badge = createIssueStatusChip(id, status);
    heading.append(badge, ` ${members.length}`);
    group.appendChild(heading);
    for (const issue of members) {
      const row = button('', () => options.onOpenIssue?.(issue.id), 'issues-graphite-projects__issue');
      row.setAttribute('aria-label', `${issue.id}: ${issue.title}`);
      const issueId = document.createElement('code');
      issueId.textContent = issue.id;
      const issueTitle = document.createElement('span');
      issueTitle.textContent = issue.title;
      row.append(issueId, issueTitle, createIcon('chevronRight', { size: 14 }));
      group.appendChild(row);
    }
    pane.appendChild(group);
  }
  return pane;
}

function renderGraphiteProjects(
  mount: HTMLElement,
  projects: IssueProject[],
  options: IssuesProjectsScreenOptions,
): void {
  const workspace = getWorkspacePath();
  const allIssues = listIssues();
  const membersByProject = new Map<string, IssueCard[]>();
  for (const issue of allIssues) {
    if (!issue.projectId) continue;
    const members = membersByProject.get(issue.projectId) ?? [];
    members.push(issue);
    membersByProject.set(issue.projectId, members);
  }
  const screen = document.createElement('div');
  screen.className = 'issues-graphite-projects';
  const rail = document.createElement('nav');
  rail.className = 'issues-graphite-projects__rail';
  rail.setAttribute('aria-label', 'Projects');
  const header = document.createElement('div');
  header.className = 'issues-graphite-projects__rail-head';
  const title = document.createElement('h2');
  title.textContent = `Projects ${projects.length}`;
  const create = button('New project', () => {
    void appPrompt('Project name').then((name) => {
      if (!name?.trim()) return;
      try {
        const project = addIssueProject(name.trim());
        selectedProjects.set(workspace, project.id);
        if (screen.parentElement) {
          renderGraphiteProjects(screen.parentElement, listIssueProjects({ includeArchived: true }), options);
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Could not create the project', 'error');
      }
    });
  });
  create.prepend(createIcon('plus', { size: 14 }));
  header.append(title, create);
  rail.appendChild(header);

  const preferred = selectedProjects.get(workspace);
  const selected = projects.find((project) => project.id === preferred) ?? projects[0];
  const detail = document.createElement('div');
  detail.className = 'issues-graphite-projects__stage';
  const renderSelection = (project: IssueProject) => {
    selectedProjects.set(workspace, project.id);
    for (const node of rail.querySelectorAll<HTMLElement>('[data-project-id]')) {
      node.setAttribute('aria-current', String(node.dataset.projectId === project.id));
    }
    detail.replaceChildren(graphiteProjectDetail(project, membersByProject.get(project.id) ?? [], options));
  };

  for (const project of projects) {
    const progress = issueProjectProgress(project.id);
    const item = button('', () => renderSelection(project), 'issues-graphite-projects__row');
    item.dataset.projectId = project.id;
    const name = document.createElement('span');
    name.className = 'issues-graphite-projects__name';
    name.textContent = project.name;
    const summary = document.createElement('span');
    summary.className = 'issues-graphite-projects__meta';
    summary.textContent = project.archivedAt ? 'Archived' : `${progress.total} ${progress.total === 1 ? 'issue' : 'issues'}`;
    const completion = document.createElement('progress');
    completion.max = Math.max(progress.total, 1);
    completion.value = progress.done;
    completion.setAttribute('aria-label', `${project.name} completion`);
    item.append(name, completion, summary);
    rail.appendChild(item);
  }
  if (selected) renderSelection(selected);
  else {
    const empty = document.createElement('p');
    empty.className = 'issues-graphite-projects__empty';
    empty.textContent = 'Create a project to collect related issues.';
    detail.appendChild(empty);
  }
  screen.append(rail, detail);
  mount.replaceChildren(screen);
}

/** Render the dedicated Projects screen into the Issues app scrollport. */
export function renderIssuesProjectsScreen(
  mount: HTMLElement,
  options: IssuesProjectsScreenOptions,
): void {
  const projects = listIssueProjects({ includeArchived: true });
  if (document.documentElement.classList.contains('mn-graphite-apps')) {
    renderGraphiteProjects(mount, projects, options);
    return;
  }
  const active = projects.filter((project) => !project.archivedAt);
  const archived = projects.filter((project) => project.archivedAt);

  const screen = document.createElement('div');
  screen.className = 'issues-projects-screen';

  const intro = document.createElement('div');
  intro.className = 'issues-projects-screen__intro';
  const copy = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = 'Projects';
  const description = document.createElement('p');
  description.textContent = 'Group related issues and track their progress.';
  copy.append(title, description);

  const form = document.createElement('form');
  form.className = 'issues-project-create';
  const label = document.createElement('label');
  label.className = 'visually-hidden';
  label.htmlFor = 'issuesProjectName';
  label.textContent = 'Project name';
  const input = document.createElement('input');
  input.id = 'issuesProjectName';
  input.name = 'name';
  input.placeholder = 'Project name';
  input.autocomplete = 'off';
  const create = document.createElement('button');
  create.type = 'submit';
  create.className = 'issues-btn issues-btn--primary';
  create.textContent = 'New project';
  form.append(label, input, create);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    try {
      addIssueProject(name);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create the project', 'error');
    }
  });
  intro.append(copy, form);
  screen.appendChild(intro);

  if (projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'issues-projects-empty';
    const emptyTitle = document.createElement('h3');
    emptyTitle.textContent = 'No projects yet';
    const emptyCopy = document.createElement('p');
    emptyCopy.textContent = 'Create a project to collect related issues and see their progress in one place.';
    empty.append(emptyTitle, emptyCopy);
    screen.appendChild(empty);
  } else {
    if (active.length > 0) screen.appendChild(projectSection('Active', active, options));
    if (archived.length > 0) screen.appendChild(projectSection('Archived', archived, options));
  }

  mount.appendChild(screen);
}
