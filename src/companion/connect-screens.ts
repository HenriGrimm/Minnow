/**
 * Full-screen states a phone sees before Minnow itself loads: connect from a
 * scanned QR, ask for access, wait for approval, or learn it was disconnected.
 * Everything here is one primary action deep.
 */

import { markAppReady } from '../boot/app-ready.ts';
import {
  claimConnectCode,
  claimConnectTicket,
  pollAccessRequest,
  requestAccess,
  suggestedDeviceName,
  type HostInfo,
} from '../api/device-auth.ts';

const POLL_MS = 2_000;
const JUST_CONNECTED_KEY = 'minnow.companion.justConnected';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label: string, variant: 'primary' | 'secondary' | 'link' = 'primary'): HTMLButtonElement {
  const node = el('button', `companion-access__btn companion-access__btn--${variant}`, label);
  node.type = 'button';
  return node;
}

/** Replace whatever access screen is showing with a fresh one. */
export function mountAccessScreen(): HTMLElement {
  document.documentElement.classList.add('minnow-companion-access');
  markAppReady();
  document.getElementById('companionAccess')?.remove();
  document.getElementById('companionConnecting')?.remove();
  const screen = el('main', 'companion-access');
  screen.id = 'companionAccess';
  screen.setAttribute('aria-labelledby', 'companionAccessTitle');
  const card = el('div', 'companion-access__card');
  screen.append(card);
  document.body.appendChild(screen);
  return card;
}

function title(text: string): HTMLHeadingElement {
  const node = el('h1', 'companion-access__title', text);
  node.id = 'companionAccessTitle';
  return node;
}

function errorLine(): HTMLParagraphElement {
  const node = el('p', 'companion-access__error');
  node.setAttribute('role', 'alert');
  node.hidden = true;
  return node;
}

function showError(node: HTMLElement, err: unknown, fallback: string): void {
  // fetch() rejects with a TypeError ("Failed to fetch") when the host is unreachable.
  const fromHost = err instanceof Error && !(err instanceof TypeError) && err.message;
  node.textContent = fromHost || fallback;
  node.hidden = false;
}

function nameField(): { field: HTMLElement; input: HTMLInputElement } {
  const field = el('label', 'companion-access__field');
  field.append(el('span', 'companion-access__label', 'Name'));
  const input = el('input', 'companion-access__input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.maxLength = 64;
  input.value = suggestedDeviceName();
  input.spellcheck = false;
  field.append(input);
  return { field, input };
}

/** Land in the app now that the host has set this device's cookie. */
function enterApp(): void {
  try { window.localStorage.setItem(JUST_CONNECTED_KEY, '1'); } catch {}
  window.location.replace('/');
}

/** Whether the app just finished connecting (shows the Home Screen tip once). */
export function consumeJustConnected(): boolean {
  try {
    const value = window.localStorage.getItem(JUST_CONNECTED_KEY);
    window.localStorage.removeItem(JUST_CONNECTED_KEY);
    return value === '1';
  } catch {
    return false;
  }
}

/** Opened from a scanned QR: one tap connects. */
export function renderConnectScreen(opts: { ticket: string; hostInfo: HostInfo }): void {
  const card = mountAccessScreen();
  const { field, input } = nameField();
  const connect = button('Connect');
  const error = errorLine();
  card.append(
    title(`Connect to ${opts.hostInfo.hostName}?`),
    el('p', 'companion-access__copy', 'This device gets access to your Minnow chats and agents.'),
    field,
    error,
    connect,
  );
  connect.addEventListener('click', () => {
    error.hidden = true;
    connect.disabled = true;
    connect.textContent = 'Connecting…';
    void claimConnectTicket(opts.ticket, input.value.trim())
      .then(enterApp)
      .catch((err: Error & { code?: string }) => {
        if (err?.code === 'invalid_ticket') {
          renderNotConnectedScreen({ hostInfo: opts.hostInfo, reason: 'expired-ticket' });
          return;
        }
        connect.disabled = false;
        connect.textContent = 'Connect';
        showError(error, err, 'Could not reach your computer. Try again.');
      });
  });
  connect.focus();
}

type NotConnectedReason = 'none' | 'handoff-expired' | 'expired-ticket';

function reasonCopy(reason: NotConnectedReason, hostName: string): string {
  if (reason === 'handoff-expired') {
    return 'This app needs to connect once. Ask for access and approve it on your computer.';
  }
  if (reason === 'expired-ticket') {
    return 'That connect link was already used or has expired.';
  }
  return `On ${hostName}, open Settings → Devices → Connect a phone, then scan the code.`;
}

function canScan(): boolean {
  // Mirrors canScanInApp() in qr-scanner.ts, which stays lazily loaded.
  return (
    window.isSecureContext &&
    typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    navigator.maxTouchPoints > 0
  );
}

/** No pairing yet: scan, request access, or (home network) type a code. */
export function renderNotConnectedScreen(opts: { hostInfo: HostInfo; reason?: NotConnectedReason }): void {
  const card = mountAccessScreen();
  const { hostInfo } = opts;
  const error = errorLine();
  card.append(
    title('Connect this device'),
    el('p', 'companion-access__copy', reasonCopy(opts.reason ?? 'none', hostInfo.hostName)),
  );

  const actions = el('div', 'companion-access__actions');
  if (canScan()) {
    const scan = button('Scan QR');
    scan.addEventListener('click', () => {
      error.hidden = true;
      void import('./qr-scanner.ts')
        .then(({ scanConnectQr }) => scanConnectQr())
        .then((result) => {
          if (result.kind === 'ticket') return claimConnectTicket(result.ticket, suggestedDeviceName()).then(enterApp);
          if (result.kind === 'navigate') window.location.href = result.url;
          return undefined;
        })
        .catch((err) => showError(error, err, 'Could not read that code. Try again.'));
    });
    actions.append(scan);
  }
  const request = button('Request access', canScan() ? 'secondary' : 'primary');
  request.addEventListener('click', () => {
    error.hidden = true;
    request.disabled = true;
    void requestAccess(suggestedDeviceName())
      .then((created) => renderWaitingScreen({ hostInfo, request: created }))
      .catch((err) => {
        request.disabled = false;
        showError(error, err, 'Could not reach your computer. Try again.');
      });
  });
  actions.append(request);
  card.append(actions, error);

  if (hostInfo.codeEntry) card.append(renderCodeEntry());
}

function renderCodeEntry(): HTMLElement {
  const wrap = el('div', 'companion-access__code-entry');
  const toggle = button('Enter a code instead', 'link');
  const form = el('form', 'companion-access__code-form');
  form.hidden = true;
  form.noValidate = true;
  const input = el('input', 'companion-access__input companion-access__input--code');
  input.inputMode = 'numeric';
  input.autocomplete = 'one-time-code';
  input.maxLength = 7;
  input.placeholder = '000000';
  input.setAttribute('aria-label', '6-digit code');
  const submit = el('button', 'companion-access__btn companion-access__btn--secondary', 'Connect');
  submit.type = 'submit';
  const error = errorLine();
  form.append(input, submit, error);
  toggle.addEventListener('click', () => {
    form.hidden = false;
    toggle.hidden = true;
    input.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    void claimConnectCode(input.value, suggestedDeviceName())
      .then(enterApp)
      .catch((err) => {
        submit.disabled = false;
        showError(error, err, 'That code is invalid or has expired.');
        input.select();
      });
  });
  wrap.append(toggle, form);
  return wrap;
}

/** Show the number the host must match, and wait for its answer. */
export function renderWaitingScreen(opts: {
  hostInfo: HostInfo;
  request: { id: string; secret: string; verifyCode: string };
}): void {
  const card = mountAccessScreen();
  const status = el('p', 'companion-access__muted', 'Waiting for approval…');
  status.setAttribute('role', 'status');
  const cancel = button('Cancel', 'secondary');
  const code = el('p', 'companion-access__verify', opts.request.verifyCode.split('').join(' '));
  code.setAttribute('aria-label', `Number ${opts.request.verifyCode.split('').join(' ')}`);
  card.append(
    title('Approve on your computer'),
    el('p', 'companion-access__copy', `Check that Minnow on ${opts.hostInfo.hostName} shows this number:`),
    code,
    status,
    cancel,
  );

  let timer: number | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
  cancel.addEventListener('click', () => {
    stop();
    renderNotConnectedScreen({ hostInfo: opts.hostInfo });
  });
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await pollAccessRequest(opts.request);
      if (stopped) return;
      if (result === 'approved') {
        stop();
        enterApp();
        return;
      }
      if (result === 'denied' || result === 'expired') {
        stop();
        renderAnsweredScreen(opts.hostInfo, result);
        return;
      }
    } catch {
      /* Keep waiting through a Wi-Fi blip. */
    }
    timer = window.setTimeout(() => void tick(), POLL_MS);
  };
  timer = window.setTimeout(() => void tick(), POLL_MS);
}

function renderAnsweredScreen(hostInfo: HostInfo, result: 'denied' | 'expired'): void {
  const card = mountAccessScreen();
  const again = button('Try again');
  again.addEventListener('click', () => renderNotConnectedScreen({ hostInfo }));
  card.append(
    title(result === 'denied' ? 'Request declined' : 'Request timed out'),
    el(
      'p',
      'companion-access__copy',
      result === 'denied'
        ? `${hostInfo.hostName} declined this request.`
        : 'Nobody approved it in time. Ask again while you are at your computer.',
    ),
    again,
  );
}

/** The host revoked this device. Never shown for an outage. */
export function renderDisconnectedScreen(hostInfo: HostInfo): void {
  const card = mountAccessScreen();
  const again = button('Request access again');
  again.addEventListener('click', () => renderNotConnectedScreen({ hostInfo }));
  card.append(
    title('This device was disconnected'),
    el('p', 'companion-access__copy', `It was removed from ${hostInfo.hostName}. Ask for access to use Minnow here again.`),
    again,
  );
}

function reconnectHint(hostName: string): string {
  if (window.location.protocol === 'https:') {
    return "Check this device's internet connection. Your computer may be asleep or Minnow closed.";
  }
  return `Is this device on the same Wi-Fi as ${hostName}? Your computer may be asleep or Minnow closed.`;
}

/** Show or hide the "can't reach" banner. Retrying is automatic. */
export function updateReconnectBanner(connected: boolean, hostName: string): void {
  let banner = document.getElementById('companionReconnect');
  if (!banner) {
    banner = el('div', 'companion-reconnect');
    banner.id = 'companionReconnect';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.append(el('strong', 'companion-reconnect__title'), el('span', 'companion-reconnect__hint'));
    document.body.appendChild(banner);
  }
  banner.hidden = connected;
  if (connected) return;
  const [heading, hint] = banner.children as unknown as [HTMLElement, HTMLElement];
  heading.textContent = `Can't reach ${hostName}`;
  hint.textContent = `${reconnectHint(hostName)} Retrying automatically.`;
}
