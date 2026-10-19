/**
 * Device access before normal app boot: connect, request access, reconnect
 * feedback, and the Home Screen / Anywhere follow-ups once connected.
 */

import '../styles/companion.css';
import { whenChromeReady } from '../boot/app-ready.ts';
import { fetchHostInfo, type HostInfo } from '../api/device-auth.ts';
import { hasHostSessionToken, isPairedDevice, migrateLegacyDeviceToken, setPairedDevice } from '../api/session-token.ts';
import { startCompanionConnectionMonitor } from './connection.ts';
import {
  consumeJustConnected,
  renderConnectScreen,
  renderDisconnectedScreen,
  renderNotConnectedScreen,
  updateReconnectBanner,
} from './connect-screens.ts';
import { captureInstallPrompt, maybeShowInstallGuide } from './install-guide.ts';

const COMPANION_MEDIA = '(max-width: 640px)';
/** Remembers that this browser was connected, to tell a revoke from a first visit. */
const PAIRED_KEY = 'minnow.companion.paired';
const HOST_NAME_KEY = 'minnow.companion.hostName';

function readLocal(key: string): string {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {}
}

function applyCompanionViewport(): void {
  const enabled = isPairedDevice() && window.matchMedia(COMPANION_MEDIA).matches;
  document.documentElement.classList.toggle('minnow-companion', enabled);
}

/** `/connect#t=<ticket>` from a scanned QR; the fragment never reaches the server. */
function takeConnectTicket(): string {
  if (window.location.pathname !== '/connect') return '';
  const ticket = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
  if (ticket) window.history.replaceState(null, '', `/connect${window.location.search}`);
  return /^[A-Za-z0-9_-]{22}$/.test(ticket) ? ticket : '';
}

function notConnectedReason(): 'handoff-expired' | 'none' {
  return new URLSearchParams(window.location.search).get('reason') === 'handoff-expired' ? 'handoff-expired' : 'none';
}

function renderConnecting(): HTMLElement {
  const waiting = document.createElement('main');
  waiting.className = 'companion-access';
  waiting.id = 'companionConnecting';
  waiting.setAttribute('role', 'status');
  const card = document.createElement('div');
  card.className = 'companion-access__card';
  const title = document.createElement('h1');
  title.className = 'companion-access__title';
  title.textContent = 'Connecting to Minnow';
  const copy = document.createElement('p');
  copy.className = 'companion-access__copy';
  copy.textContent = 'Waiting for your computer. This resumes on its own.';
  card.append(title, copy);
  waiting.append(card);
  document.body.appendChild(waiting);
  return waiting;
}

/**
 * Pair a remote browser before normal API boot. Returns false when an access
 * screen owns the page and Minnow must not make additional API requests.
 */
export async function initializeCompanionAccess(): Promise<boolean> {
  if (hasHostSessionToken()) {
    setPairedDevice(false);
    return true;
  }
  captureInstallPrompt();

  const ticket = takeConnectTicket();
  if (ticket) {
    const hostInfo = await fetchHostInfo();
    if (hostInfo.paired) {
      window.location.replace('/');
      return false;
    }
    renderConnectScreen({ ticket, hostInfo });
    return false;
  }

  await migrateLegacyDeviceToken();

  const cachedHostName = readLocal(HOST_NAME_KEY) || 'your computer';
  const waiting = renderConnecting();
  let hostInfo: HostInfo | null = null;
  const connection = startCompanionConnectionMonitor({
    onConnectionChange: (connected) => updateReconnectBanner(connected, readLocal(HOST_NAME_KEY) || cachedHostName),
    onSession: (session) => {
      if (session.hostName) writeLocal(HOST_NAME_KEY, session.hostName);
    },
    onRevoked: () => {
      updateReconnectBanner(true, cachedHostName);
      const wasPaired = readLocal(PAIRED_KEY) === '1';
      writeLocal(PAIRED_KEY, null);
      document.documentElement.classList.remove('minnow-companion');
      void (async () => {
        hostInfo ??= await fetchHostInfo();
        if (wasPaired) renderDisconnectedScreen(hostInfo);
        else renderNotConnectedScreen({ hostInfo, reason: notConnectedReason() });
      })();
    },
  });

  // Do not fall back to local session/config storage during a host outage at
  // boot. Wait for the saved pairing to reconnect before normal API bootstrap.
  if (!(await connection.ready)) {
    waiting.remove();
    return false;
  }

  setPairedDevice(true);
  writeLocal(PAIRED_KEY, '1');

  if (window.location.pathname === '/connect') window.history.replaceState(null, '', '/');
  const copy = waiting.querySelector('p');
  if (copy) copy.textContent = 'Loading your workspace…';
  const justConnected = consumeJustConnected();
  void whenChromeReady().then(() => {
    waiting.remove();
    const shownGuide = maybeShowInstallGuide({ justConnected });
    if (!shownGuide) void import('./move-prompt.ts').then(({ maybeOfferMove }) => maybeOfferMove());
  });

  applyCompanionViewport();
  window.matchMedia(COMPANION_MEDIA).addEventListener('change', applyCompanionViewport);
  return true;
}
