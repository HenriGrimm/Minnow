/** Manual workspace entry points shared by Code's empty views. */
export function createCodeReadinessActions(): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'code-readiness-actions';
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'file-tree-readiness-action';
  browse.textContent = 'Browse files';
  browse.addEventListener('click', () => {
    void import('./file-layout').then((m) => m.openFileSidebar());
  });
  const terminal = document.createElement('button');
  terminal.type = 'button';
  terminal.className = 'file-tree-readiness-action';
  terminal.textContent = 'Open terminal';
  terminal.addEventListener('click', () => {
    void import('./terminal-panel').then((m) => m.openTerminalPanel());
  });
  actions.append(browse, terminal);
  return actions;
}
