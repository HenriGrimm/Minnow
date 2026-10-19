/**
 * Host-side approval cards for devices asking to connect. Appears anywhere in
 * the app (not only in Settings) so tapping Request access on a phone gets an
 * answer within seconds. Each card shows the 4-digit number the phone shows.
 */

import { hasHostSessionToken } from '../api/session-token.ts';
import {
  approveAccessRequest,
  denyAccessRequest,
  fetchAccessRequests,
  fetchDevices,
  fetchRemoteStatus,
  isRemoteAccessOn,
  notifyDevicesChanged,
  type CompanionDevice,
  type PendingAccessRequest,
} from '../api/remote-admin.ts';
import { showToast } from './toast.ts';
import '../styles/device-request-prompt.css';

const VISIBLE_POLL_MS = 3_000;
const HIDDEN_POLL_MS = 15_000;
const STATUS_REFRESH_MS = 30_000;

let started = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function stack(): HTMLElement {
  let node = document.getElementById('deviceRequestPrompts');
  if (!node) {
    node = el('div', 'device-request-stack');
    node.id = 'deviceRequestPrompts';
    node.dataset.aboveShellOverlay = '';
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
  }
  return node;
}

/** Same-kind devices the phone might be (e.g. its browser is already connected). */
function candidates(request: PendingAccessRequest, devices: CompanionDevice[]): CompanionDevice[] {
  return devices.filter((device) => device.kind === request.kind || device.kind === 'unknown');
}

function renderCard(request: PendingAccessRequest, devices: CompanionDevice[], onAnswered: () => void): HTMLElement {
  const card = el('section', 'device-request');
  card.dataset.requestId = request.id;
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-labelledby', `deviceRequestTitle-${request.id}`);
  const title = el('strong', 'device-request__title', `${request.name} wants to connect`);
  title.id = `deviceRequestTitle-${request.id}`;
  const copy = el('p', 'device-request__copy', 'Approve only if the phone shows this number:');
  const code = el('p', 'device-request__code', request.verifyCode.split('').join(' '));

  const options = candidates(request, devices);
  let select: HTMLSelectElement | null = null;
  if (options.length) {
    const field = el('label', 'device-request__field');
    field.append(el('span', '', 'Connect as'));
    select = el('select', 'device-request__select');
    const option = (label: string, value: string) => {
      const node = el('option', '', label);
      node.value = value;
      return node;
    };
    select.append(option('A new device', ''));
    for (const device of options) select.append(option(device.name, device.id));
    // A Home Screen app asking for access is usually a device that is already connected.
    const sameName = options.find((device) => device.name === request.name);
    if (request.installed && sameName) select.value = sameName.id;
    field.append(select);
    card.append(title, copy, code, field);
  } else {
    card.append(title, copy, code);
  }

  const actions = el('div', 'device-request__actions');
  const deny = el('button', 'settings-action-btn', 'Deny');
  deny.type = 'button';
  const approve = el('button', 'settings-action-btn settings-action-btn--primary', 'Approve');
  approve.type = 'button';
  const answer = (action: () => Promise<void>, message: string) => {
    deny.disabled = true;
    approve.disabled = true;
    void action().then(
      () => {
        card.remove();
        showToast(message);
        notifyDevicesChanged();
        onAnswered();
      },
      (err: Error) => {
        deny.disabled = false;
        approve.disabled = false;
        showToast(err.message || 'Could not answer the request', 'error');
        if (/expired/i.test(err.message)) card.remove();
      },
    );
  };
  deny.addEventListener('click', () => answer(() => denyAccessRequest(request.id), `${request.name} declined`));
  approve.addEventListener('click', () =>
    answer(
      () => approveAccessRequest(request.id, select?.value ? { attachToDeviceId: select.value } : {}),
      `${request.name} connected`,
    ),
  );
  actions.append(deny, approve);
  card.append(actions);
  return card;
}

async function notify(request: PendingAccessRequest): Promise<void> {
  try {
    const { pushNotification } = await import('../notifications/push.ts');
    pushNotification({
      kind: 'device_request',
      title: `${request.name} wants to connect`,
      preview: `Check the number ${request.verifyCode}, then approve in Minnow.`,
      appId: 'settings',
      dedupeKey: `device-request:${request.id}`,
      os: true,
    });
  } catch {
    /* The card itself is the primary surface. */
  }
}

/** Start watching for access requests (host window only, once). */
export function initDeviceRequestPrompt(): void {
  if (started || !hasHostSessionToken()) return;
  started = true;

  let remoteOn = false;
  let lastStatusAt = 0;
  let timer: number | undefined;
  const seen = new Set<string>();

  const refreshStatus = async () => {
    try {
      remoteOn = isRemoteAccessOn(await fetchRemoteStatus());
    } catch {
      /* keep the previous answer */
    }
    lastStatusAt = Date.now();
  };

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void poll(), document.visibilityState === 'visible' ? VISIBLE_POLL_MS : HIDDEN_POLL_MS);
  };

  const poll = async () => {
    try {
      if (Date.now() - lastStatusAt > STATUS_REFRESH_MS) await refreshStatus();
      if (!remoteOn) return;
      const requests = await fetchAccessRequests();
      const container = stack();
      const live = new Set(requests.map((request) => request.id));
      for (const node of [...container.children] as HTMLElement[]) {
        if (!live.has(node.dataset.requestId ?? '')) node.remove();
      }
      const fresh = requests.filter((request) => !container.querySelector(`[data-request-id="${request.id}"]`));
      if (fresh.length) {
        const devices = await fetchDevices().catch(() => []);
        for (const request of fresh) {
          container.append(renderCard(request, devices, () => void poll()));
          if (!seen.has(request.id)) {
            seen.add(request.id);
            void notify(request);
          }
        }
      }
    } catch {
      /* try again on the next tick */
    } finally {
      schedule();
    }
  };

  // Settings changes (turning remote access on) take effect without waiting.
  window.addEventListener('minnow-devices-changed', () => {
    lastStatusAt = 0;
    void poll();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll();
  });
  void poll();
}
