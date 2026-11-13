import { isServerStorageMode } from '../config/storage-mode';
import { isProvidersApiAvailable } from '../providers/store';

const DRAWER_FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let drawerReturnFocus: HTMLElement | null = null;

/** Show banner when provider API is unavailable (Vite-only). */
export function refreshProvidersBanner(): void {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('providersServerBanner');
  if (!banner) return;
  const hide = isServerStorageMode() && isProvidersApiAvailable();
  banner.classList.toggle('hidden', hide);
}

export function toggleDrawer(): void {
  const drawer = document.getElementById('drawer')!;
  if (drawer.classList.contains('open')) {
    closeDrawer();
    return;
  }
  drawerReturnFocus = document.activeElement as HTMLElement | null;
  drawer.classList.add('open');
  document.getElementById('drawerOverlay')!.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.removeAttribute('inert');
  const overlay = document.getElementById('drawerOverlay')!;
  overlay.setAttribute('aria-hidden', 'false');
  (overlay as HTMLButtonElement).tabIndex = 0;
  document.getElementById('btnSettings')!.setAttribute('aria-expanded', 'true');
  const first = drawer.querySelector(DRAWER_FOCUSABLE) as HTMLElement | null;
  if (first) first.focus();
}

export function closeDrawer(): void {
  const drawer = document.getElementById('drawer')!;
  drawer.classList.remove('open');
  document.getElementById('drawerOverlay')!.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('inert', '');
  const overlay = document.getElementById('drawerOverlay')!;
  overlay.setAttribute('aria-hidden', 'true');
  (overlay as HTMLButtonElement).tabIndex = -1;
  document.getElementById('btnSettings')!.setAttribute('aria-expanded', 'false');
  if (drawerReturnFocus && typeof drawerReturnFocus.focus === 'function') {
    drawerReturnFocus.focus();
  }
  drawerReturnFocus = null;
}

export function onDrawerKeydown(e: KeyboardEvent): void {
  const drawer = document.getElementById('drawer')!;
  if (!drawer.classList.contains('open')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  const nodes = [...drawer.querySelectorAll(DRAWER_FOCUSABLE)].filter(
    (el) => !(el as HTMLButtonElement).disabled && (el as HTMLElement).offsetParent !== null
  ) as HTMLElement[];
  if (nodes.length < 2) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
