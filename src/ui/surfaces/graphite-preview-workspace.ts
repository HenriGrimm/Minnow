import { createIcon, type IconName } from '../icon';
import { scheduleElectronPreviewHostLayoutSync, scheduleSecondaryPreviewHostLayoutSync } from '../preview-electron-visibility';
import type { SurfaceContext } from './surface-registry';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, name: string, value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = name;
  if (value !== undefined) node.textContent = value;
  return node;
}

function iconButton(name: string, icon: IconName, run: () => void): HTMLButtonElement {
  const button = element('button', 'graphite-surface-icon');
  button.type = 'button';
  button.title = name;
  button.setAttribute('aria-label', name);
  button.append(createIcon(icon, { size: 14 }));
  button.addEventListener('click', run);
  return button;
}

export function mountGraphitePreviewWorkspace(host: HTMLElement, stage: HTMLElement, previews: HTMLElement[]): {
  setVisible(visible: boolean, context: SurfaceContext): void;
} {
  const widths = [
    ['desktop', 'Desktop', 'deviceDesktop'], ['tablet', 'Tablet', 'deviceTablet'], ['phone', 'Phone', 'deviceMobile'],
  ] as const;
  const deviceButtons: HTMLButtonElement[] = [];
  for (const preview of previews) {
    const tools = preview.querySelector('.preview-header__tools, .preview-header__trail');
    if (!tools) continue;
    const devices = element('div', 'graphite-preview-devices');
    devices.setAttribute('role', 'group');
    devices.setAttribute('aria-label', 'Preview width');
    for (const [id, label, icon] of widths) {
      const button = iconButton(label + ' preview width', icon, () => {
        host.dataset.previewWidth = id;
        for (const other of deviceButtons) other.setAttribute('aria-pressed', String(other.dataset.width === id));
        scheduleElectronPreviewHostLayoutSync();
        scheduleSecondaryPreviewHostLayoutSync();
      });
      button.dataset.width = id;
      button.setAttribute('aria-pressed', String(id === 'desktop'));
      deviceButtons.push(button);
      devices.append(button);
    }
    tools.before(devices);
    if (window.minnow?.window?.openAgentBrowserViewer) {
      const agent = iconButton('Open Agent Browser', 'eye', () => document.getElementById('btnAgentBrowserViewer')?.click());
      agent.classList.add('graphite-preview-agent');
      tools.insertBefore(agent, tools.querySelector('#btnPreviewDevTools'));
    }
    const design = preview.querySelector('#btnPreviewDesignToggle, #btnPreviewDesignToggleSecondary');
    design?.replaceChildren(createIcon('cursor', { size: 14 }));
  }

  let visible = false;
  function syncVisibility(): void {
    const panel = host.closest('#surfaceSide, #surfaceBottom');
    const maximized = (panel?.id === 'surfaceSide' ? 'side' : panel?.id === 'surfaceBottom' ? 'bottom' : null)
      === stage.dataset.surfaceMax;
    host.classList.toggle('graphite-browser-host--expanded', visible && maximized);
  }

  new MutationObserver(syncVisibility).observe(stage, { attributes: true, attributeFilter: ['data-surface-max'] });
  return {
    setVisible(nextVisible) {
      visible = nextVisible;
      syncVisibility();
    },
  };
}
