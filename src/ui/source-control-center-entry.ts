const OPEN_BUTTON_ID = 'btnGitCenter';

let bound = false;

/** Open the center, lazily loading the surface on first use. */
export async function openSourceControlCenterLazy(options?: {
  section?: 'changes' | 'history' | 'branches' | 'stashes' | 'worktrees' | 'pulls' | 'checks';
  cwd?: string;
}): Promise<void> {
  const module = await import('./source-control-center');
  await module.openSourceControlCenter(options);
}

/** Close the center if it is open. */
export async function closeSourceControlCenterLazy(): Promise<void> {
  const module = await import('./source-control-center');
  module.closeSourceControlCenter();
}

/** Wire the sidebar button that opens the center. */
export function initSourceControlCenter(): void {
  if (bound) return;
  bound = true;

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.closest(`#${OPEN_BUTTON_ID}`)) return;

    event.preventDefault();
    void import('./git-panel').then(({ getGitPanelGitCwd }) => openSourceControlCenterLazy({ cwd: getGitPanelGitCwd() }));
  });
}

/** Reset module state (tests). */
export function resetSourceControlCenterEntryForTests(): void {
  bound = false;
}
