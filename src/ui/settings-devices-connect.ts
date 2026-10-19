/**
 * The Connect a phone sheet. If phones can't reach this computer yet, the first
 * step asks where the phone should work; then it shows a QR and reports the
 * phone by name the moment it connects.
 */

import { toCanvas } from 'qrcode';
import {
  createConnectSession,
  fetchConnectSession,
  fetchRemoteStatus,
  isRemoteAccessOn,
  notifyDevicesChanged,
  setAnywhere,
  setLanEnabled,
  type ConnectSession,
  type RemoteStatus,
} from '../api/remote-admin.ts';
import { iconHtml } from './icon.ts';
import { isAnywhereSettling, renderAnywhereState } from './settings-devices-anywhere.ts';

const SESSION_POLL_MS = 1_500;
const STATUS_POLL_MS = 2_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(label: string, primary = false): HTMLButtonElement {
  const node = el('button', primary ? 'settings-action-btn settings-action-btn--primary' : 'settings-action-btn', label);
  node.type = 'button';
  return node;
}

export interface ConnectSheetOptions {
  initialStatus?: RemoteStatus;
  onStatus?: (status: RemoteStatus) => void;
  onConnected?: (device: { id: string; name: string }) => void;
}

/** Open the sheet. Resolves when it closes. */
export function openConnectSheet(opts: ConnectSheetOptions = {}): Promise<void> {
  document.getElementById('devicesConnectSheet')?.remove();
  const backdrop = el('div', 'devices-sheet-backdrop');
  backdrop.id = 'devicesConnectSheet';
  backdrop.dataset.aboveShellOverlay = '';
  const sheet = el('div', 'devices-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'devicesSheetTitle');
  const close = el('button', 'devices-sheet__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = iconHtml('close', { size: 18 });
  const content = el('div', 'devices-sheet__content');
  sheet.append(close, content);
  backdrop.append(sheet);
  document.body.appendChild(backdrop);

  let closed = false;
  let timer: number | undefined;
  const previousFocus = document.activeElement as HTMLElement | null;
  let resolveClosed: () => void;
  const done = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const finish = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    previousFocus?.focus?.();
    resolveClosed();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish();
    }
  };
  document.addEventListener('keydown', onKey, true);
  close.addEventListener('click', finish);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) finish();
  });

  const heading = (text: string) => {
    const node = el('h3', 'devices-sheet__title', text);
    node.id = 'devicesSheetTitle';
    return node;
  };

  const publish = (status: RemoteStatus) => {
    opts.onStatus?.(status);
    notifyDevicesChanged();
  };

  /** Step 1 (first time only): where should this phone work? */
  const showChoice = () => {
    content.replaceChildren(
      heading('Where should this phone work?'),
      el('p', 'devices-sheet__lead', 'You can change this later in Settings → Devices.'),
    );
    const options = el('div', 'devices-choice');
    const option = (title: string, detail: string) => {
      const button = el('button', 'devices-choice__option');
      button.type = 'button';
      button.append(el('span', 'devices-choice__title', title), el('span', 'devices-choice__detail', detail));
      options.append(button);
      return button;
    };
    const wifi = option('On my Wi-Fi', 'Nothing to set up. Works while the phone is at home.');
    const anywhere = option('Anywhere', 'Sign in to Tailscale once. Works at home and away, nothing to install on the phone.');
    const error = el('p', 'devices-sheet__error');
    error.hidden = true;
    content.append(options, error);
    wifi.addEventListener('click', () => {
      wifi.disabled = true;
      void setLanEnabled(true).then((status) => {
        publish(status);
        if (status.lan.state === 'on') void showQr();
        else {
          wifi.disabled = false;
          error.hidden = false;
          error.textContent = status.lan.error?.message ?? 'Home network access could not start.';
        }
      });
    });
    anywhere.addEventListener('click', () => {
      anywhere.disabled = true;
      void setAnywhere(true).then((status) => {
        publish(status);
        showAnywhereSetup(status);
      });
    });
    wifi.focus();
  };

  /** Inline Anywhere setup, continuing to the QR once ready. */
  const showAnywhereSetup = (status: RemoteStatus) => {
    if (closed) return;
    if (status.anywhere.state === 'ready') {
      void showQr();
      return;
    }
    content.replaceChildren(heading('Set up Anywhere'));
    const body = el('div', 'devices-sheet__anywhere');
    content.append(body);
    renderAnywhereState(body, status.anywhere, (next) => {
      publish(next);
      showAnywhereSetup(next);
    });
    if (status.anywhere.state === 'unavailable' || status.anywhere.state === 'off') {
      const back = actionButton('Use my Wi-Fi instead');
      back.addEventListener('click', showChoice);
      content.append(back);
      return;
    }
    if (isAnywhereSettling(status.anywhere)) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void fetchRemoteStatus().then((next) => {
          if (closed) return;
          opts.onStatus?.(next);
          showAnywhereSetup(next);
        });
      }, STATUS_POLL_MS);
    }
  };

  /** Step 2: the QR, live until a phone claims it. */
  const showQr = async () => {
    if (closed) return;
    window.clearTimeout(timer);
    let session: ConnectSession;
    try {
      session = await createConnectSession();
    } catch {
      content.replaceChildren(heading('Connect a phone'), el('p', 'devices-sheet__error', 'Could not create a connect code. Try again.'));
      return;
    }
    if (closed) return;
    const target = session.targets[0];
    const lanTarget = session.targets.find((candidate) => candidate.kind === 'lan');
    const canvas = el('canvas', 'devices-qr');
    await toCanvas(canvas, target.url, { width: 232, margin: 2, errorCorrectionLevel: 'M' });
    if (closed) return;

    const where = target.kind === 'anywhere'
      ? 'Works anywhere. Your phone needs nothing installed.'
      : 'Works while the phone is on the same Wi-Fi as this computer.';
    const status = el('p', 'devices-sheet__status', 'Waiting for your phone…');
    status.setAttribute('role', 'status');
    const fallback = el('details', 'devices-fallback');
    fallback.append(el('summary', '', "Can't scan?"));
    const fallbackBody = el('div', 'devices-fallback__body');
    if (lanTarget && session.code) {
      fallbackBody.append(
        el('p', '', 'On a phone on this Wi-Fi, open:'),
        el('code', 'devices-address__url', lanTarget.baseUrl),
        el('p', '', 'Then choose Enter a code instead and type:'),
        el('code', 'devices-code', session.code.replace(/(\d{3})(\d{3})/, '$1 $2')),
      );
    } else {
      fallbackBody.append(
        el('p', '', 'On your phone, open:'),
        el('code', 'devices-address__url', target.baseUrl),
        el('p', '', 'Then tap Request access and approve it here.'),
      );
    }
    fallback.append(fallbackBody);
    content.replaceChildren(
      heading('Scan with your phone'),
      el('p', 'devices-sheet__lead', 'Open the Camera app and point it at this code.'),
      canvas,
      el('p', 'devices-sheet__where', where),
      status,
      fallback,
    );

    const poll = async () => {
      if (closed) return;
      try {
        const result = await fetchConnectSession(session.id);
        if (closed) return;
        if (result.status === 'claimed' && result.device) {
          opts.onConnected?.(result.device);
          notifyDevicesChanged();
          showConnected(result.device.name);
          return;
        }
        if (result.status === 'expired') {
          status.textContent = 'This code expired.';
          const again = actionButton('Make a new code', true);
          again.addEventListener('click', () => void showQr());
          status.after(again);
          return;
        }
      } catch {
        /* keep polling */
      }
      timer = window.setTimeout(() => void poll(), SESSION_POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), SESSION_POLL_MS);
  };

  const showConnected = (name: string) => {
    const mark = el('div', 'devices-sheet__success');
    mark.innerHTML = iconHtml('check', { size: 28 });
    const actions = el('div', 'devices-sheet__actions');
    const another = actionButton('Connect another');
    another.addEventListener('click', () => void showQr());
    const doneButton = actionButton('Done', true);
    doneButton.addEventListener('click', finish);
    actions.append(another, doneButton);
    content.replaceChildren(
      mark,
      heading(`${name} is connected`),
      el('p', 'devices-sheet__lead', 'It stays connected through restarts and network changes. Disconnect it here any time.'),
      actions,
    );
    doneButton.focus();
  };

  void (async () => {
    const status = opts.initialStatus ?? (await fetchRemoteStatus().catch(() => null));
    if (closed) return;
    if (status && isRemoteAccessOn(status)) void showQr();
    else if (status && isAnywhereSettling(status.anywhere)) showAnywhereSetup(status);
    else showChoice();
  })();

  return done;
}
