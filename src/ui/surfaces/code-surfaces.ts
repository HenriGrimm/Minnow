import { getFilePanelState } from '../../state/file-panel';
import { getWorkspacePath } from '../../state/workspace';
import { getActiveChat, sessionState } from '../../state/sessions';
import { openFileInViewer } from '../file-viewer';
import { applyFileSidebarVisuals } from '../file-layout';
import { openContextMenu, type MenuItem } from '../context-menu';
import { initFileTreeIfNeeded } from '../file-tree';
import { closeGitCommitDiffPanel, getGraphiteReviewPane } from '../git-commit-diff-panel';
import { openGitSurfaceTarget, setGitSurfaceVisible, syncGitSurfaceCommitLayout } from '../git-panel';
import { createIcon } from '../icon';
import { openTerminalSurfaceRun, setTerminalSurfaceVisible } from '../terminal-panel';
import { subscribeSidebarRender } from '../sidebar';
import { chatGitState, getWorkspaceGitSummary, subscribeSidebarGitState } from '../sidebar-git-state';
import { mountSurfacePanels, moveSurfaceNode, refreshSurfacePanels, registerSurface, usePhonePresentation } from './surfaces-column';
import type { SurfaceId } from './surface-state';
import { createWorkbenchContent } from './workbench-content';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function mountedNode(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function mountFileSurfaceChrome(files: HTMLElement): void {
  const search = files.querySelector<HTMLInputElement>('#fileTreeSearch');
  const wrap = search?.parentElement;
  if (!search || !wrap) return;
  search.dataset.onlinePlaceholder = 'Go to file';
  search.placeholder = 'Go to file';
  const icon = createIcon('search', { size: 14, className: 'graphite-file-search-icon' });
  wrap.prepend(icon);
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'graphite-surface-icon graphite-file-tools';
  more.title = 'File tools';
  more.setAttribute('aria-label', more.title);
  more.setAttribute('aria-haspopup', 'menu');
  more.append(createIcon('more', { size: 14 }));
  more.addEventListener('click', () => {
    const commands = [
      ['btnFileTreeRefresh', 'Refresh files'], ['btnFileSidebarCollapse', 'Collapse file tree'],
      ['btnPreviewToggle', 'Open Browser'], ['btnAgentBrowserViewer', 'Open Agent Browser'],
      ['btnGitPanelToggle', 'Open Diff'], ['btnIssuesPanelToggle', 'Open workspace issues'],
    ] as const;
    const items: MenuItem[] = [];
    for (const [id, label] of commands) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (!button || button.hidden || button.classList.contains('hidden')) continue;
      items.push({ id, label, disabled: button.disabled, onSelect: () => button.click() });
    }
    openContextMenu({ anchor: more, restoreFocus: more, label: more.title, items });
  });
  wrap.append(more);
}

export function initCodeGraphiteSurfaces(): void {
  const stage = mountedNode('workspaceSplit');
  const files = mountedNode('fileSidebar');
  const terminal = mountedNode('terminalPanel');
  const diff = mountedNode('gitPanelRoot');
  if (!stage || !files || !terminal || !diff || !mountedNode('fileViewerPaneSecondary') ||
    !mountedNode('previewPaneSecondary') || !mountedNode('graphiteThreadHeader') ||
    stage.classList.contains('graphite-surfaces')) return;

  const filesHost = document.createElement('div');
  filesHost.className = 'graphite-files-host';
  mountFileSurfaceChrome(files);
  const before = getFilePanelState();
  const content = createWorkbenchContent(stage);

  registerSurface('files', {
    render: () => filesHost,
    setVisible(visible) {
      if (!visible || files.classList.contains('file-sidebar--issues-drawer')) return;
      moveSurfaceNode(files, filesHost);
      applyFileSidebarVisuals();
      void initFileTreeIfNeeded();
    },
    async open({ chat, target }) {
      const { path, workspaceRoot, line, character, query } = record(target);
      if (typeof path === 'string' && path.trim()) {
        if (sessionState && getActiveChat()?.id !== chat.id) return;
        const selection = typeof line === 'number' && line >= 0
          ? { line, character: typeof character === 'number' && character >= 0 ? character : 0 }
          : undefined;
        await openFileInViewer(path, {
          workspaceRoot: typeof workspaceRoot === 'string' ? workspaceRoot : chat.worktreeRoot ?? chat.workspacePath,
          initialSelection: selection,
        });
      } else if (typeof query === 'string') {
        const search = document.getElementById('fileTreeSearch');
        if (search instanceof HTMLInputElement) {
          search.value = query;
          search.dispatchEvent(new Event('input', { bubbles: true }));
          search.focus();
        }
      }
    },
  });
  registerSurface('terminal', {
    render: () => terminal,
    setVisible: setTerminalSurfaceVisible,
    async open({ chat, target }) {
      const { runId } = record(target);
      if (typeof runId === 'string' && runId) await openTerminalSurfaceRun(chat.id, runId);
    },
  });
  registerSurface('review', {
    render: ({ chat }) => getGraphiteReviewPane(chat.id),
    availability: ({ chat }) => ({ available: Boolean(getGraphiteReviewPane(chat.id)) }),
    close: closeGitCommitDiffPanel,
  });
  registerSurface('changes', {
    render: () => {
      syncGitSurfaceCommitLayout(usePhonePresentation());
      return diff;
    },
    setVisible: (visible, { chat }) => {
      setGitSurfaceVisible(visible, chat);
      if (visible) syncGitSurfaceCommitLayout(usePhonePresentation());
    },
    availability({ chat }) {
      const cwd = chat.worktreeRoot ?? chat.workspacePath ?? getWorkspacePath();
      const counts = chatGitState(chat, cwd);
      const workspace = getWorkspaceGitSummary(cwd);
      const plus = counts.additions;
      const minus = counts.deletions;
      const available = Boolean(plus || minus || workspace?.changed);
      return available
        ? { available, hint: plus || minus ? `+${plus} −${minus}` : undefined, tabCount: workspace?.changed ?? undefined }
        : { available, reason: 'No changes yet' };
    },
    async open({ chat, target }) {
      const { kind } = record(target);
      if (kind === 'checkout' || kind === 'commit') await openGitSurfaceTarget(chat.id, kind);
    },
  });

  const open: SurfaceId[] = [];
  if (!before.rightPaneCollapsed) {
    if (before.rightPaneMode === 'preview') open.push('preview');
    if (before.rightPaneMode === 'viewer' || before.rightPaneMode === 'split') open.push('files');
  }
  if (!terminal.classList.contains('hidden')) open.push('terminal');
  mountSurfacePanels(stage, { legacyOpen: open, content });
  subscribeSidebarRender(refreshSurfacePanels);
  subscribeSidebarGitState(refreshSurfacePanels);
}
