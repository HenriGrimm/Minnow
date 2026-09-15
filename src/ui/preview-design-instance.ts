import {
  disableDesignMode,
  enableDesignMode,
  getDesignModeSession,
  isDesignModeEnabled,
  refreshDesignModeArmedToolGuest,
  relocateDesignModeStrip,
} from '../design/design-mode';
import { isCrossOriginPreviewForInstance } from '../design/element-picker';
import {
  isDesignModeUsingIframeGuest,
  setDesignModeUsingIframeGuest,
} from './preview-design-mode-guest';
import { WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID } from './preview-design-mode-mount';
import { WORKSPACE_PREVIEW_SECONDARY_INSTANCE } from './right-pane-split';
import { resolvePreviewLoadUrl } from './preview-load-url';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import { getPreviewTab } from './preview-tab-store';
import { getSecondaryPreviewTabId } from './preview-secondary-slot';
import { setPreviewInstanceVisible } from './preview-instance-host';
import type { PreviewSource } from '../state/file-panel';

function usesElectronPreview(): boolean {
  return Boolean(window.minnow?.preview);
}

/** Iframe-vs-native guest strategy for a given preview design instance. */
export function usesDesignModeIframeGuestForInstance(instanceId: string): boolean {
  if (!usesElectronPreview() || !isDesignModeEnabled(instanceId)) return false;
  if (!isCrossOriginPreviewForInstance(instanceId)) return true;
  const armedTool = getDesignModeSession(instanceId)?.getArmedToolId();
  return armedTool !== 'select';
}

function getHostForInstance(instanceId: string): HTMLElement | null {
  if (instanceId === WORKSPACE_PREVIEW_SECONDARY_INSTANCE) {
    return document.getElementById('previewBodySecondary');
  }
  return document.getElementById('previewBody');
}

function getChromeForInstance(instanceId: string): HTMLElement | null {
  if (instanceId === WORKSPACE_PREVIEW_SECONDARY_INSTANCE) {
    return document.getElementById('previewDesignChromeSecondary');
  }
  return document.getElementById('previewDesignChrome');
}

function getPaneForInstance(instanceId: string): HTMLElement | null {
  if (instanceId === WORKSPACE_PREVIEW_SECONDARY_INSTANCE) {
    return document.getElementById('previewPaneSecondary');
  }
  return document.getElementById('previewPane');
}

let secondaryDesignFrame: HTMLIFrameElement | null = null;

function hideSecondaryDesignFrame(): void {
  if (secondaryDesignFrame) {
    secondaryDesignFrame.remove();
    secondaryDesignFrame = null;
  }
}

function showSecondaryDesignFrame(source: PreviewSource): void {
  const body = getHostForInstance(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
  if (!body) return;
  const url = resolvePreviewLoadUrl(source, undefined, getFileTreeListingWorkspaceRoot());
  if (secondaryDesignFrame?.getAttribute('src') === url && secondaryDesignFrame.parentElement === body) return;
  hideSecondaryDesignFrame();
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = 'Workspace preview (secondary design guest)';
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-forms allow-popups allow-modals allow-same-origin',
  );
  frame.src = url;
  body.appendChild(frame);
  secondaryDesignFrame = frame;
}

/** Swap Electron guest vs iframe for Design Mode on primary or secondary workspace preview. */
export async function syncDesignModeGuestForInstance(instanceId: string): Promise<void> {
  const body = getHostForInstance(instanceId);
  const chrome = getChromeForInstance(instanceId);
  if (!body) return;

  const usingIframe = usesDesignModeIframeGuestForInstance(instanceId);
  setDesignModeUsingIframeGuest(instanceId, usingIframe);

  const designOn = usesElectronPreview() && isDesignModeEnabled(instanceId);
  const session = getDesignModeSession(instanceId);
  if (designOn && session) {
    if (usingIframe) {
      chrome?.setAttribute('hidden', '');
      relocateDesignModeStrip(instanceId, body);
    } else {
      chrome?.setAttribute('hidden', '');
      relocateDesignModeStrip(instanceId, body, true);
    }
  } else {
    chrome?.setAttribute('hidden', '');
  }

  if (instanceId === WORKSPACE_PREVIEW_SECONDARY_INSTANCE) {
    if (usingIframe) {
      body.classList.add('preview-body--design-mode');
      const tabId = getSecondaryPreviewTabId();
      const source = tabId ? getPreviewTab(tabId)?.source : null;
      if (source) showSecondaryDesignFrame(source);
      setPreviewInstanceVisible(WORKSPACE_PREVIEW_SECONDARY_INSTANCE, false);
    } else {
      body.classList.remove('preview-body--design-mode');
      hideSecondaryDesignFrame();
      setPreviewInstanceVisible(WORKSPACE_PREVIEW_SECONDARY_INSTANCE, true);
      if (!designOn) {
        void import('./preview-secondary-slot').then((m) => {
          const tabId = getSecondaryPreviewTabId();
          if (tabId) void m.renderSecondaryPreviewSlot(tabId);
        });
      }
    }
    void import('./preview-electron-visibility').then((m) =>
      m.scheduleSecondaryPreviewHostLayoutSync(),
    );
  } else if (instanceId === WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID) {
    const { syncPrimaryDesignModeElectronGuest } = await import('./preview-panel');
    await syncPrimaryDesignModeElectronGuest();
  }

  if (getDesignModeSession(instanceId)?.getArmedToolId() === 'select') {
    refreshDesignModeArmedToolGuest(instanceId);
  }
}

export async function toggleDesignModeForInstance(
  instanceId: string,
  getToggleButton: () => HTMLButtonElement | null,
): Promise<void> {
  const host = getHostForInstance(instanceId);
  const pane = getPaneForInstance(instanceId);
  if (!host) return;

  const { isPreviewDesignModeAvailable } = await import('./preview-panel');
  if (!(await isPreviewDesignModeAvailable())) return;

  const designBtn = getToggleButton();

  if (isDesignModeEnabled(instanceId)) {
    disableDesignMode(instanceId);
    designBtn?.setAttribute('aria-pressed', 'false');
    designBtn?.classList.remove('is-active');
    await syncDesignModeGuestForInstance(instanceId);
    return;
  }

  designBtn?.setAttribute('aria-pressed', 'true');
  designBtn?.classList.add('is-active');

  const onExit = (): void => {
    void toggleDesignModeForInstance(instanceId, getToggleButton);
  };

  await enableDesignMode({
    instanceId,
    host,
    paneElement: pane ?? host,
    onExit,
    onArmedToolChange: async () => {
      await syncDesignModeGuestForInstance(instanceId);
    },
  });
}

/** Tear down secondary design iframe and session when the split closes. */
export function teardownSecondaryDesignModeGuest(): void {
  hideSecondaryDesignFrame();
  setDesignModeUsingIframeGuest(WORKSPACE_PREVIEW_SECONDARY_INSTANCE, false);
  if (isDesignModeEnabled(WORKSPACE_PREVIEW_SECONDARY_INSTANCE)) {
    disableDesignMode(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
  }
  const btn = document.getElementById('btnPreviewDesignToggleSecondary');
  btn?.setAttribute('aria-pressed', 'false');
  btn?.classList.remove('is-active');
  const body = getHostForInstance(WORKSPACE_PREVIEW_SECONDARY_INSTANCE);
  body?.classList.remove('preview-body--design-mode');
}
