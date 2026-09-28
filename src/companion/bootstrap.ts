/**
 * Authenticated narrow-screen companion bootstrap and host reconnect feedback.
 */

import '../styles/companion.css';
import { markAppReady } from '../boot/app-ready.ts';
import { exchangePairingCode, initializeDevicePairing } from '../api/device-auth.ts';
import { isInstalledPwa } from '../api/pwa-context.ts';
import { clearDeviceToken, getDeviceToken, hasHostSessionToken } from '../api/session-token.ts';
import { listComposerModes } from '../chat/modes/registry.ts';
import { isModeId } from '../chat/modes/types.ts';
import { getActiveChat } from '../state/sessions.ts';
import { setChatMode } from '../ui/mode-selector.ts';

const COMPANION_MEDIA = '(max-width: 640px)';
const RECONNECT_INTERVAL_MS = 5_000;
const PAIRING_CODE_DIGITS = 6;

let reconnectTimer: number | undefined;
let modePickerObserver: MutationObserver | null = null;

function installModePicker(): void {
  const target =
    document.querySelector<HTMLElement>('#desktopComposerRoot .composer-model-trigger-row') ??
    document.querySelector<HTMLElement>('.chat-app-top');
  if (!target) return;

  let select = document.getElementById('companionModeSelect') as HTMLSelectElement | null;
  if (!select) {
    select = document.createElement('select');
    select.id = 'companionModeSelect';
    select.className = 'companion-mode-select';
    select.setAttribute('aria-label', 'Chat mode');
    for (const mode of listComposerModes()) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      if (!select || !isModeId(select.value)) return;
      const result = setChatMode(select.value);
      if (!result.ok) syncValue();
    });
  }
  const syncValue = () => {
    try {
      const modeId = getActiveChat().modeId ?? 'general';
      select!.value = listComposerModes().some((mode) => mode.id === modeId) ? modeId : 'general';
    } catch {
      select!.value = 'general';
    }
  };
  if (select.dataset.companionBound !== 'true') {
    select.dataset.companionBound = 'true';
    select.addEventListener('focus', syncValue);
  }
  syncValue();
  if (select.parentElement !== target) {
    target.appendChild(select);
  }

  if (target.closest('#desktopComposerRoot')) {
    modePickerObserver?.disconnect();
    modePickerObserver = null;
  }
}

function watchForCompanionComposer(): void {
  installModePicker();
  if (modePickerObserver) return;
  modePickerObserver = new MutationObserver(installModePicker);
  modePickerObserver.observe(document.body, { childList: true, subtree: true });
}

function renderPairingCodeForm(showError: boolean): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'companion-access__form';
  form.noValidate = true;

  const label = document.createElement('label');
  label.className = 'companion-access__label';
  label.htmlFor = 'companionPairingCode';
  label.textContent = 'Pairing code';

  const input = document.createElement('input');
  input.id = 'companionPairingCode';
  input.className = 'companion-access__input';
  input.name = 'pairingCode';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'one-time-code';
  input.spellcheck = false;
  input.maxLength = PAIRING_CODE_DIGITS;
  input.pattern = '[0-9]{6}';
  input.placeholder = '6-digit code';
  input.required = true;

  const error = document.createElement('p');
  error.className = 'companion-access__error';
  error.hidden = !showError;
  error.textContent = 'That pairing code is invalid, expired, or already used.';

  const submit = document.createElement('button');
  submit.className = 'companion-access__submit';
  submit.type = 'submit';
  submit.textContent = 'Connect';

  form.append(label, input, error, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    void exchangePairingCode(input.value)
      .then(() => {
        window.location.replace(`${window.location.pathname}${window.location.search}#/desktop`);
        window.location.reload();
      })
      .catch(() => {
        error.hidden = false;
        submit.disabled = false;
        input.focus();
        input.select();
      });
  });

  return form;
}

function renderAccessScreen(kind: 'required' | 'failed' | 'revoked'): void {
  document.documentElement.classList.add('minnow-companion-access');
  markAppReady();

  const existing = document.getElementById('companionAccess');
  existing?.remove();

  const screen = document.createElement('main');
  screen.id = 'companionAccess';
  screen.className = 'companion-access';
  screen.setAttribute('aria-labelledby', 'companionAccessTitle');

  const title = document.createElement('h1');
  title.id = 'companionAccessTitle';
  title.textContent = kind === 'revoked' ? 'Device access revoked' : 'Pair this device';

  const installed = isInstalledPwa();
  const copy = document.createElement('p');
  copy.textContent =
    kind === 'failed'
      ? 'This pairing link is invalid, expired, or already used. Create a new link in Minnow Settings.'
      : kind === 'revoked'
        ? 'This device no longer has access. Create a new pairing from the host to reconnect.'
        : installed
          ? 'Enter the pairing code from the host (Settings → Network access). QR scans open the browser, which uses separate storage from the installed app.'
          : 'Scan the QR from the host, or enter the pairing code shown under the QR in Settings → Network access.';

  const hint = document.createElement('p');
  hint.className = 'companion-access__hint';
  hint.textContent = installed
    ? 'Each installed app needs its own pairing. Create a new code on the host if you already paired in the browser.'
    : 'Minnow companion works only while the host is running on the same network.';

  screen.append(title, copy, hint, renderPairingCodeForm(kind === 'failed'));
  document.body.appendChild(screen);
  screen.querySelector<HTMLInputElement>('#companionPairingCode')?.focus();
}

function ensureReconnectBanner(): HTMLElement {
  let banner = document.getElementById('companionReconnect');
  if (banner) return banner;
  banner = document.createElement('div');
  banner.id = 'companionReconnect';
  banner.className = 'companion-reconnect';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.textContent = 'Host unreachable — reconnecting…';
  banner.hidden = true;
  document.body.appendChild(banner);
  return banner;
}

async function probeHost(): Promise<void> {
  if (!document.documentElement.classList.contains('minnow-companion')) return;
  const banner = ensureReconnectBanner();
  try {
    const response = await fetch('/api/tools/ping', { cache: 'no-store' });
    if (response.status === 401) {
      clearDeviceToken();
      renderAccessScreen('revoked');
      return;
    }
    banner.hidden = response.ok;
  } catch {
    banner.hidden = false;
  }
}

function startReconnectMonitor(): void {
  if (reconnectTimer !== undefined) return;
  const probe = () => void probeHost();
  window.addEventListener('online', probe);
  window.addEventListener('offline', probe);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') probe();
  });
  window.addEventListener('minnow-auth-revoked', () => {
    clearDeviceToken();
    renderAccessScreen('revoked');
  });
  reconnectTimer = window.setInterval(probe, RECONNECT_INTERVAL_MS);
  probe();
}

function applyCompanionViewport(): void {
  const enabled =
    !hasHostSessionToken() &&
    Boolean(getDeviceToken()) &&
    window.matchMedia(COMPANION_MEDIA).matches;
  document.documentElement.classList.toggle('minnow-companion', enabled);
  if (!enabled) return;

  if (window.location.hash !== '#/desktop') {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/desktop`);
  }
  watchForCompanionComposer();
  startReconnectMonitor();
}

/**
 * Pair a remote browser before normal API boot. Returns false when the access
 * screen owns the page and Minnow must not make additional API requests.
 */
export async function initializeCompanionAccess(): Promise<boolean> {
  const state = await initializeDevicePairing();
  if (state === 'pairing-required') {
    renderAccessScreen('required');
    return false;
  }
  if (state === 'pairing-failed') {
    renderAccessScreen('failed');
    return false;
  }

  applyCompanionViewport();
  window.matchMedia(COMPANION_MEDIA).addEventListener('change', applyCompanionViewport);
  return true;
}
