/**
 * Settings → Access: one read-only card with everything that decides what can
 * reach this computer — permission level, shell sandbox, network listeners and
 * paired devices. Each row links to the page that changes it; this card never
 * edits anything, so it cannot drift from the real controls.
 */

import { loadToolSecurityMeta, onToolSecurityMetaChange, type PermissionLevel } from '../config/tool-security-meta';
import { fetchDevices, fetchRemoteStatus, type RemoteStatus } from '../api/remote-admin';
import { linkToSettingsSection } from './settings-layout';

type Tone = 'ok' | 'notice' | 'warn';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const PERMISSION_COPY: Record<PermissionLevel, { value: string; detail: string; tone: Tone }> = {
  manual: { value: 'Manual', detail: 'Agents ask before every edit, command and website.', tone: 'ok' },
  auto: { value: 'Auto', detail: 'Routine edits and commands run; anything risky, remote or outside the project asks first.', tone: 'ok' },
  full: { value: 'Full access', detail: 'No prompts. Agents can change any file, run any command and use the internet.', tone: 'warn' },
};

const SANDBOX_COPY: Record<string, { value: string; detail: string; tone: Tone }> = {
  off: { value: 'Off', detail: 'Agent commands can read and write anything your user account can.', tone: 'notice' },
  prefer: { value: 'When available', detail: 'Agent commands are contained where this system supports it.', tone: 'ok' },
  require: { value: 'Required', detail: 'Agent commands that cannot be contained do not run.', tone: 'ok' },
};

function row(list: HTMLElement, label: string, sectionId: string, linkLabel: string): {
  value: HTMLElement;
  detail: HTMLElement;
  setTone: (tone: Tone) => void;
} {
  const item = el('li', 'settings-security__row');
  const head = el('div', 'settings-security__head');
  const name = el('span', 'settings-security__label', label);
  const value = el('span', 'settings-security__value', '…');
  head.append(name, value);
  const detail = el('p', 'settings-security__detail');
  item.append(head, detail, linkToSettingsSection(linkLabel, sectionId));
  list.append(item);
  return {
    value,
    detail,
    setTone: (tone) => {
      item.dataset.tone = tone;
    },
  };
}

function networkSummary(status: RemoteStatus): { value: string; detail: string; tone: Tone } {
  const parts: string[] = ['This computer (always)'];
  if (status.lan.state === 'on') parts.push(`Home network, port ${status.lan.port}`);
  if (status.anywhere.state === 'ready') {
    parts.push(status.anywhere.funnel ? 'Anywhere — public internet address (Tailscale Funnel)' : 'Anywhere — your Tailscale devices only');
  }
  const publicUrl = status.anywhere.state === 'ready' && status.anywhere.funnel;
  return {
    value: parts.length === 1 ? 'This computer only' : `${parts.length} ways in`,
    detail: `${parts.join(' · ')}. Paired devices still have to sign in.`,
    tone: publicUrl ? 'warn' : parts.length > 1 ? 'notice' : 'ok',
  };
}

/** Render the security summary card into the Access page. */
export async function renderSecuritySummary(mount: HTMLElement): Promise<void> {
  const list = el('ul', 'settings-security');
  list.dataset.settingsSearchKey = 'general.permissions';
  mount.append(list);

  const permission = row(list, 'Agent permission level', 'agent-center', 'Change in Agents and permissions');
  const sandbox = row(list, 'Agent shell sandbox', 'access', 'Change below');
  const network = row(list, 'Who can connect', 'devices', 'Change in Devices');
  const devices = row(list, 'Paired devices', 'devices', 'Manage in Devices');

  const applyMeta = (level: PermissionLevel, sandboxMode: string) => {
    const p = PERMISSION_COPY[level] ?? PERMISSION_COPY.auto;
    permission.value.textContent = p.value;
    permission.detail.textContent = p.detail;
    permission.setTone(p.tone);
    const s = SANDBOX_COPY[sandboxMode] ?? SANDBOX_COPY.off;
    sandbox.value.textContent = s.value;
    sandbox.detail.textContent = s.detail;
    sandbox.setTone(s.tone);
  };

  try {
    const meta = await loadToolSecurityMeta();
    applyMeta(meta.permissionLevel, meta.shellSandbox);
    const off = onToolSecurityMetaChange((next) => {
      if (!list.isConnected) {
        off();
        return;
      }
      applyMeta(next.permissionLevel, next.shellSandbox);
    });
  } catch {
    permission.value.textContent = 'Unknown';
    permission.detail.textContent = 'Open Minnow, then reopen Settings.';
  }

  const [status, paired] = await Promise.allSettled([fetchRemoteStatus(), fetchDevices()]);
  if (status.status === 'fulfilled') {
    const n = networkSummary(status.value);
    network.value.textContent = n.value;
    network.detail.textContent = n.detail;
    network.setTone(n.tone);
  } else {
    network.value.textContent = 'Unknown';
    network.detail.textContent = 'Could not read network status.';
  }
  if (paired.status === 'fulfilled') {
    const count = paired.value.length;
    devices.value.textContent = count === 0 ? 'None' : String(count);
    devices.detail.textContent = count === 0
      ? 'No phone or tablet can use this Minnow.'
      : paired.value.map((d) => d.name).filter(Boolean).join(', ');
    devices.setTone(count === 0 ? 'ok' : 'notice');
  } else {
    devices.value.textContent = 'Unknown';
    devices.detail.textContent = 'Could not read paired devices.';
  }
}
