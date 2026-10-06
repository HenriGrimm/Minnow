export function isIssuesSidebarActive(): boolean {
  return document.getElementById('fileSidebar')?.classList.contains('file-sidebar--issues') ?? false;
}

export function setIssuesSidebarActive(active: boolean): void {
  const sidebar = document.getElementById('fileSidebar');
  sidebar?.classList.toggle('file-sidebar--issues', active);
  sidebar?.setAttribute('aria-label', active ? 'Workspace issues' : 'Project files');
  document.getElementById('issuesSidebarRoot')?.toggleAttribute('hidden', !active);
  document.getElementById('fileSidebarFilesView')?.toggleAttribute('hidden', active);
  const title = document.getElementById('fileSidebarTitle');
  if (title) title.textContent = active ? 'Issues' : 'Files';
  const button = document.getElementById('btnIssuesPanelToggle');
  button?.classList.toggle('is-active', active);
  button?.setAttribute('aria-pressed', String(active));
  document.getElementById('btnFileTreeRefresh')?.toggleAttribute('hidden', active);
}
