import { formatIssueAge } from '../issues/age';
import {
  addIssueProject,
  archiveIssueProject,
  issueProjectProgress,
  listIssueProjects,
  renameIssueProject,
  restoreIssueProject,
} from '../state/issues-store';
import type { IssueProject } from '../types';
import { appConfirm, appPrompt } from './app-dialog';
import { showToast } from './toast';

export interface IssuesProjectsScreenOptions {
  onViewProject: (projectId: string) => void;
}

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

/** Render the dedicated Projects screen into the Issues app scrollport. */
export function renderIssuesProjectsScreen(
  mount: HTMLElement,
  options: IssuesProjectsScreenOptions,
): void {
  const projects = listIssueProjects({ includeArchived: true });
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
