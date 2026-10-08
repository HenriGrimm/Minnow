/**
 * Authenticated narrow-screen companion bootstrap and host reconnect feedback.
 */

import '../styles/companion.css';
import { markAppReady, whenChromeReady } from '../boot/app-ready.ts';
import { configureCompanionManifest, exchangePairingCode, initializeDevicePairing } from '../api/device-auth.ts';
import { isInstalledPwa } from '../api/pwa-context.ts';
import { getDeviceToken, hasHostSessionToken } from '../api/session-token.ts';
import { startCompanionConnectionMonitor } from './connection.ts';

const COMPANION_MEDIA = '(max-width: 640px)';
const PAIRING_CODE_DIGITS = 6;

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
          ? 'Enter the pairing code from the host (Settings → Network access) to connect this installation.'
          : 'Scan the QR from the host, or enter the pairing code shown under the QR in Settings → Network access.';

  const hint = document.createElement('p');
  hint.className = 'companion-access__hint';
  hint.textContent = installed
    ? 'For an existing Home Screen app, enter a code here. New installs carry pairing from the connected browser.'
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

function applyCompanionViewport(): void {
  const enabled =
    !hasHostSessionToken() &&
    Boolean(getDeviceToken()) &&
    window.matchMedia(COMPANION_MEDIA).matches;
  document.documentElement.classList.toggle('minnow-companion', enabled);
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

  if (state === 'device') {
    // Keep a visible, independent status surface while boot waits for the host.
    // The loader's safety timeout may otherwise reveal an uninitialized shell.
    const waiting = document.createElement('main');
    waiting.className = 'companion-access';
    waiting.id = 'companionConnecting';
    waiting.setAttribute('role', 'status');
    const title = document.createElement('h1');
    title.textContent = 'Connecting to Minnow';
    const copy = document.createElement('p');
    copy.textContent = 'Waiting for the host. Keep Minnow running on the same network. Connection resumes automatically.';
    waiting.append(title, copy);
    document.body.appendChild(waiting);
    const connection = startCompanionConnectionMonitor({
      onConnectionChange: (connected) => { ensureReconnectBanner().hidden = connected; },
      onRevoked: () => {
        ensureReconnectBanner().hidden = true;
        renderAccessScreen('revoked');
      },
    });
    // Do not fall back to local session/config storage during a host outage at
    // boot. Wait for the saved pairing to reconnect before normal API bootstrap.
    if (!(await connection.ready)) {
      waiting.remove();
      return false;
    }
    configureCompanionManifest();
    title.textContent = 'Opening Minnow';
    copy.textContent = 'Loading your workspace…';
    void whenChromeReady().then(() => waiting.remove());
  }

  applyCompanionViewport();
  window.matchMedia(COMPANION_MEDIA).addEventListener('change', applyCompanionViewport);
  return true;
}
