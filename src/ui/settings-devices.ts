/**
 * Settings → Devices: connect a phone, choose where it works (home network or
 * Anywhere), and manage connected devices. Access requests surface globally
 * through the approval prompt (device-request-prompt.ts).
 */

import {
  fetchDevices,
  fetchRemoteStatus,
  renameDevice,
  revokeDevice,
  setLanEnabled,
  type CompanionDevice,
  type LanStatus,
  type RemoteStatus,
} from '../api/remote-admin.ts';
import { appConfirm, appPrompt } from './app-dialog.ts';
import { iconHtml } from './icon.ts';
import { showToast } from './toast.ts';
import { isAnywhereSettling, renderAnywhereState } from './settings-devices-anywhere.ts';
import '../styles/settings-devices.css';

const STATUS_POLL_MS = 2_000;
const LIST_REFRESH_MS = 15_000;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

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

function card(title: string, icon: 'externalLink' | 'link'): { root: HTMLElement; status: HTMLElement; body: HTMLElement } {
  const root = el('section', 'devices-card');
  const head = el('div', 'devices-card__head');
  const glyph = el('span', 'devices-card__icon');
  glyph.innerHTML = iconHtml(icon, { size: 16 });
  const heading = el('h4', 'devices-card__title', title);
  const status = el('span', 'devices-pill');
  head.append(glyph, heading, status);
  const body = el('div', 'devices-card__body');
  root.append(head, body);
  return { root, status, body };
}

function setPill(pill: HTMLElement, text: string, tone: 'on' | 'off' | 'busy' | 'error'): void {
  pill.textContent = text;
  pill.dataset.tone = tone;
}

function renderLan(body: HTMLElement, pill: HTMLElement, lan: LanStatus, onChange: (status: RemoteStatus) => void): void {
  body.replaceChildren();
  const actions = el('div', 'devices-card__actions');
  const toggle = (enabled: boolean, button: HTMLButtonElement) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      void setLanEnabled(enabled)
        .then(onChange)
        .catch((err: Error) => {
          button.disabled = false;
          showToast(err.message, 'error');
        });
    });
  };
  if (lan.state === 'on') {
    setPill(pill, 'On', 'on');
    const list = el('ul', 'devices-address-list');
    for (const url of lan.urls.slice(0, 3)) {
      const item = el('li', 'devices-address');
      item.append(el('code', 'devices-address__url', url));
      const copy = el('button', 'settings-inline-btn', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(url).then(() => showToast('Address copied'), () => showToast('Could not copy the address', 'error'));
      });
      item.append(copy);
      list.append(item);
    }
    body.append(
      list,
      el('p', 'devices-card__copy', 'Phones on this Wi-Fi can open Minnow. Only devices you connect can use it.'),
    );
    const off = actionButton('Turn off');
    toggle(false, off);
    actions.append(off);
  } else if (lan.state === 'error') {
    setPill(pill, 'Problem', 'error');
    body.append(
      el(
        'p',
        'devices-card__copy',
        lan.error?.code === 'port-in-use'
          ? `Port ${lan.port} is in use by another program. Quit that program, then try again.`
          : lan.error?.message ?? 'Home network access could not start.',
      ),
    );
    const retry = actionButton('Try again', true);
    toggle(true, retry);
    const off = actionButton('Turn off');
    toggle(false, off);
    actions.append(retry, off);
  } else {
    setPill(pill, 'Off', 'off');
    body.append(el('p', 'devices-card__copy', 'Phones on your Wi-Fi connect with nothing to install or sign in to.'));
    const on = actionButton('Turn on');
    toggle(true, on);
    actions.append(on);
  }
  body.append(actions);
}

function anywherePill(pill: HTMLElement, status: RemoteStatus['anywhere']): void {
  if (status.state === 'ready') setPill(pill, 'On', 'on');
  else if (status.state === 'error') setPill(pill, 'Problem', 'error');
  else if (status.state === 'off' || status.state === 'unavailable') setPill(pill, 'Off', 'off');
  else setPill(pill, 'Setting up', 'busy');
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return 'Not used yet';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'Not used yet';
  const delta = Date.now() - at;
  if (delta < ACTIVE_WINDOW_MS) return 'Active now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Last seen ${days} ${days === 1 ? 'day' : 'days'} ago`;
  return `Last seen ${new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function viaLabel(ingress: string | undefined): string {
  if (ingress === 'lan') return 'home network';
  if (ingress === 'funnel' || ingress === 'tailnet') return 'Anywhere';
  return '';
}

function deviceIcon(kind: CompanionDevice['kind']): string {
  if (kind === 'tablet') return iconHtml('deviceTablet', { size: 18 });
  if (kind === 'computer') return iconHtml('deviceDesktop', { size: 18 });
  return iconHtml('deviceMobile', { size: 18 });
}

function renderDeviceRow(device: CompanionDevice, refresh: () => void): HTMLLIElement {
  const row = el('li', 'devices-row');
  const icon = el('span', 'devices-row__icon');
  icon.innerHTML = deviceIcon(device.kind);
  const identity = el('div', 'devices-row__identity');
  const name = el('span', 'devices-row__name', device.name);
  if (device.credentials.some((credential) => credential.label === 'home-screen')) {
    name.append(el('span', 'devices-badge', 'Home Screen app'));
  }
  const seen = relativeTime(device.lastSeenAt);
  const via = viaLabel(device.lastIngress);
  identity.append(name, el('span', 'devices-row__meta', via && device.lastSeenAt ? `${seen} · via ${via}` : seen));

  const actions = el('div', 'devices-row__actions');
  const rename = el('button', 'settings-inline-btn', 'Rename');
  rename.type = 'button';
  rename.addEventListener('click', () => {
    void appPrompt('Name this device', device.name, { title: 'Rename device', confirmLabel: 'Save' }).then((value) => {
      const next = value?.trim();
      if (!next || next === device.name) return;
      void renameDevice(device.id, next).then(refresh, (err: Error) => showToast(err.message, 'error'));
    });
  });
  const disconnect = el('button', 'settings-inline-btn settings-inline-btn--danger', 'Disconnect');
  disconnect.type = 'button';
  disconnect.addEventListener('click', () => {
    void appConfirm(`${device.name} loses access right away, including its Home Screen app.`, {
      title: `Disconnect ${device.name}?`,
      confirmLabel: 'Disconnect',
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      disconnect.disabled = true;
      void revokeDevice(device.id).then(
        () => {
          showToast(`${device.name} disconnected`);
          refresh();
        },
        (err: Error) => {
          disconnect.disabled = false;
          showToast(err.message, 'error');
        },
      );
    });
  });
  actions.append(rename, disconnect);
  row.append(icon, identity, actions);
  return row;
}

/** Render Settings → Devices into its section body. */
export async function renderDevicesSettings(mount: HTMLElement): Promise<void> {
  const root = el('div', 'devices-settings');
  root.dataset.settingsSearchKey = 'general.devices';
  mount.replaceChildren(root);

  const header = el('div', 'devices-header');
  const intro = el('div', 'devices-header__intro');
  intro.append(
    el('h3', 'devices-header__title', 'Use Minnow on your phone'),
    el('p', 'settings-section-lead', 'Chat, check on agents, and approve their work from a phone or tablet while this computer runs Minnow.'),
  );
  const connect = actionButton('Connect a phone', true);
  connect.id = 'devicesConnectButton';
  header.append(intro, connect);

  const cards = el('div', 'devices-cards');
  const anywhere = card('Anywhere', 'externalLink');
  anywhere.root.dataset.settingsSearchKey = 'general.devices.anywhere';
  const lan = card('Home network', 'link');
  lan.root.dataset.settingsSearchKey = 'general.devices.lan';
  cards.append(anywhere.root, lan.root);

  const listHead = el('h4', 'devices-list__title', 'Your devices');
  const list = el('ul', 'devices-list');
  const empty = el('p', 'settings-field-hint devices-list__empty', 'No devices yet. Connect a phone to use Minnow away from your desk.');
  root.append(header, cards, listHead, empty, list);

  let disposed = false;
  let statusTimer: number | undefined;
  let status: RemoteStatus | null = null;

  const renderStatus = (next: RemoteStatus) => {
    status = next;
    renderLan(lan.body, lan.status, next.lan, renderStatus);
    anywherePill(anywhere.status, next.anywhere);
    renderAnywhereState(anywhere.body, next.anywhere, renderStatus);
    window.clearTimeout(statusTimer);
    if (!disposed && isAnywhereSettling(next.anywhere)) {
      statusTimer = window.setTimeout(() => void loadStatus(), STATUS_POLL_MS);
    }
  };
  const loadStatus = async () => {
    if (disposed || !root.isConnected) {
      disposed = true;
      return;
    }
    try {
      renderStatus(await fetchRemoteStatus());
    } catch {
      anywhere.body.replaceChildren(el('p', 'devices-card__copy', 'Could not load remote access status.'));
    }
  };
  const loadDevices = async () => {
    if (disposed || !root.isConnected) {
      disposed = true;
      return;
    }
    try {
      const devices = await fetchDevices();
      list.replaceChildren(...devices.map((device) => renderDeviceRow(device, () => void loadDevices())));
      empty.hidden = devices.length > 0;
    } catch {
      empty.hidden = false;
      empty.textContent = 'Could not load devices.';
    }
  };

  connect.addEventListener('click', () => {
    void import('./settings-devices-connect.ts').then(({ openConnectSheet }) =>
      openConnectSheet({
        onStatus: renderStatus,
        onConnected: () => void loadDevices(),
        initialStatus: status ?? undefined,
      }),
    );
  });

  const onChanged = () => {
    void loadDevices();
    void loadStatus();
  };
  window.addEventListener('minnow-devices-changed', onChanged);
  const listTimer = window.setInterval(() => {
    if (!root.isConnected) {
      disposed = true;
      window.clearInterval(listTimer);
      window.clearTimeout(statusTimer);
      window.removeEventListener('minnow-devices-changed', onChanged);
      return;
    }
    if (document.visibilityState === 'visible') void loadDevices();
  }, LIST_REFRESH_MS);

  await Promise.all([loadStatus(), loadDevices()]);
}
