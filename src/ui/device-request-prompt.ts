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
import { notify, type NotifyHandle, type NotifyOptions } from './toast.ts';
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

/** Open request cards by request id. */
const cards = new Map<string, NotifyHandle>();
/** Requests the user closed without answering; they stay in Activity and Settings. */
const closed = new Set<string>();

/** Same-kind devices the phone might be (e.g. its browser is already connected). */
function candidates(request: PendingAccessRequest, devices: CompanionDevice[]): CompanionDevice[] {
  return devices.filter((device) => device.kind === request.kind || device.kind === 'unknown');
}

function showCard(request: PendingAccessRequest, devices: CompanionDevice[], onAnswered: () => void): void {
  const content = el('div', 'device-request');
  content.dataset.requestId = request.id;
  const code = el('p', 'device-request__code', request.verifyCode.split('').join(' '));
  code.setAttribute('aria-label', `Number ${request.verifyCode}`);
  content.append(code);

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
    content.append(field);
  }

  const answer = async (action: () => Promise<void>, message: string): Promise<NotifyOptions> => {
    try {
      await action();
    } catch (err) {
      if (err instanceof Error && /expired/i.test(err.message)) {
        cards.get(request.id)?.dismiss();
        cards.delete(request.id);
      }
      throw err instanceof Error && err.message ? err : new Error('Could not answer the request');
    }
    cards.delete(request.id);
    notifyDevicesChanged();
    onAnswered();
    return { tone: 'success', icon: 'deviceMobile', message };
  };

  const handle = notify({
    tone: 'attention',
    icon: 'deviceMobile',
    source: 'Devices',
    title: `${request.name} wants to connect`,
    message: 'Approve only if the phone shows this number:',
    content,
    durationMs: null,
    dedupeKey: `device-request:${request.id}`,
    open: () => {
      void import('./settings-page').then(({ openSettings }) => openSettings('devices'));
    },
    openLabel: 'Open device settings',
    actions: [
      {
        label: 'Approve',
        variant: 'primary',
        run: () => answer(
          () => approveAccessRequest(request.id, select?.value ? { attachToDeviceId: select.value } : {}),
          `${request.name} connected`,
        ),
      },
      {
        label: 'Deny',
        run: () => answer(() => denyAccessRequest(request.id), `${request.name} declined`),
      },
    ],
    onDismiss: () => {
      cards.delete(request.id);
      closed.add(request.id);
    },
  });
  if (handle) cards.set(request.id, handle);
}

async function pushRequestNotification(request: PendingAccessRequest): Promise<void> {
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
  let polling = false;
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
    if (polling) return;
    polling = true;
    window.clearTimeout(timer);
    try {
      if (Date.now() - lastStatusAt > STATUS_REFRESH_MS) await refreshStatus();
      if (!remoteOn) return;
      const requests = await fetchAccessRequests();
      const live = new Set(requests.map((request) => request.id));
      for (const [id, handle] of cards) {
        if (live.has(id)) continue;
        handle.dismiss();
        cards.delete(id);
      }
      const fresh = requests.filter((request) => !cards.get(request.id)?.isOpen && !closed.has(request.id));
      if (fresh.length) {
        const devices = await fetchDevices().catch(() => []);
        for (const request of fresh) {
          showCard(request, devices, () => void poll());
          if (!seen.has(request.id)) {
            seen.add(request.id);
            void pushRequestNotification(request);
          }
        }
      }
    } catch {
      /* try again on the next tick */
    } finally {
      polling = false;
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
