/**
 * Tag <html> with the Electron shell platform so titlebar CSS can clear the
 * native macOS traffic lights. macOS 26 (Tahoe) spaces them wider than earlier
 * releases, so `data-mac-titlebar="wide"` swaps in the larger inset
 * (`--mn-mac-traffic-lights-end` in minnowos-tokens.css).
 *
 * The traffic lights are native and ignore page zoom, so `--mn-shell-zoom`
 * tracks the live zoom factor and the CSS divides the inset by it.
 */

/** Major macOS version at which the traffic lights got their wider spacing. */
const WIDE_TRAFFIC_LIGHTS_MACOS_MAJOR = 26;

export function isWideMacTrafficLights(osVersion: string | undefined): boolean {
  const major = Number.parseInt(osVersion ?? '', 10);
  return Number.isFinite(major) && major >= WIDE_TRAFFIC_LIGHTS_MACOS_MAJOR;
}

function readZoomFactor(): number {
  try {
    const zoom = window.minnow?.app?.getZoomFactor?.();
    return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  } catch {
    return 1;
  }
}

/** Apply platform attributes and keep `--mn-shell-zoom` live. Returns a cleanup. */
export function applyShellPlatform(root: HTMLElement = document.documentElement): () => void {
  const app = window.minnow?.app;
  if (!app?.platform) return () => {};
  root.dataset.platform = app.platform;
  if (app.platform !== 'darwin') return () => clearShellPlatform(root);

  if (isWideMacTrafficLights(app.osVersion)) root.dataset.macTitlebar = 'wide';
  else delete root.dataset.macTitlebar;

  // Zoom changes resize the CSS viewport, so `resize` covers shell zoom and Cmd +/−.
  const syncZoom = (): void => {
    root.style.setProperty('--mn-shell-zoom', String(readZoomFactor()));
  };
  syncZoom();
  window.addEventListener('resize', syncZoom);
  return () => {
    window.removeEventListener('resize', syncZoom);
    clearShellPlatform(root);
  };
}

export function clearShellPlatform(root: HTMLElement = document.documentElement): void {
  root.removeAttribute('data-platform');
  root.removeAttribute('data-mac-titlebar');
  root.style.removeProperty('--mn-shell-zoom');
}
