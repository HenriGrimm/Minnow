import { showToast } from './toast';
import { detectConfigServer } from '../config/storage-mode';
import {
  fetchNetworkStatus,
  loadConfigNetworkAccess,
  saveNetworkAccess,
  type NetworkAccess,
  type NetworkStatus,
} from '../config/network-access';
import { setStatus } from './status';
import { appendSettingsOfflineHint } from './settings-controls';
import { renderCompanionDevices } from './settings-network-devices';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function warningBanner(message: string): HTMLElement {
  const p = el('p', 'settings-network-warning');
  p.setAttribute('role', 'note');
  p.textContent = message;
  return p;
}

function restartBanner(): HTMLElement {
  const p = el('p', 'settings-network-restart');
  p.setAttribute('role', 'status');
  p.textContent = 'Restart Minnow to apply this change.';
  return p;
}

// ── Segments ─────────────────────────────────────────────────────────────────

function createSegmentButton(
  label: string,
  mode: NetworkAccess,
  group: HTMLElement,
  onSelect: (mode: NetworkAccess) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-network-segment';
  btn.dataset.network = mode;
  btn.textContent = label;
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => onSelect(mode));
  group.appendChild(btn);
  return btn;
}

function setActiveSegment(group: HTMLElement, mode: NetworkAccess): void {
  for (const btn of group.querySelectorAll<HTMLButtonElement>('.settings-network-segment')) {
    const active = btn.dataset.network === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function renderLanUrls(mount: HTMLElement, urls: string[]): void {
  const list = el('ul', 'settings-network-urls');
  for (const url of urls) {
    const item = el('li', 'settings-network-urls__item');
    const code = el('code', 'settings-network-urls__code', url);
    const copyBtn = el('button', 'settings-inline-btn settings-network-urls__copy', 'Copy');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(url).then(
        () => showToast('Link copied'),
        () => setStatus('err', 'Could not copy link'),
      );
    });
    item.append(code, copyBtn);
    list.appendChild(item);
  }
  mount.appendChild(list);
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Render network access controls into the General settings mount. */
export async function renderNetworkAccessSettings(mount: HTMLElement): Promise<void> {
  const serverUp = await detectConfigServer();
  if (serverUp !== 'server') {
    appendSettingsOfflineHint(
      mount,
      'Network access settings are saved on this device. Open Minnow, then reopen Settings.',
    );
    return;
  }

  const [status, savedMode] = await Promise.all([
    fetchNetworkStatus(),
    loadConfigNetworkAccess(),
  ]);

  const section = el('section', 'settings-network');
  section.dataset.settingsSearchKey = 'general.network';

  const segmentGroup = el('div', 'settings-network-segments');
  segmentGroup.setAttribute('role', 'group');
  segmentGroup.setAttribute('aria-label', 'Network access');

  let selectedMode: NetworkAccess = savedMode;
  let restartEl: HTMLElement | null = null;

  const localBtn = createSegmentButton('This device only', 'local', segmentGroup, (mode) => {
    void applyMode(mode);
  });
  const lanBtn = createSegmentButton('Local network', 'lan', segmentGroup, (mode) => {
    void applyMode(mode);
  });

  setActiveSegment(segmentGroup, selectedMode);
  section.appendChild(segmentGroup);
  section.appendChild(
    el(
      'p',
      'settings-field-hint',
      'The Electron shell on this PC always uses localhost.',
    ),
  );

  const warning = warningBanner(
    'Local network mode makes Minnow reachable on your Wi‑Fi. API access still requires a paired device token, but use only on networks you trust. Windows Firewall may block inbound connections until you allow Node.',
  );
  warning.hidden = selectedMode !== 'lan';
  section.appendChild(warning);

  const urlsMount = el('div', 'settings-network-urls-mount');
  section.appendChild(urlsMount);

  const voiceHint = el(
    'p',
    'settings-field-hint settings-network-voice-hint',
    'Voice input on phones and tablets usually requires HTTPS or localhost — it may not work over http://192.168.x.x.',
  );
  voiceHint.hidden = selectedMode !== 'lan' || status.lanUrls.length === 0;
  section.appendChild(voiceHint);

  const devicesMount = el('div', 'settings-network-devices-mount');
  section.appendChild(devicesMount);
  renderCompanionDevices(devicesMount, status.networkAccess === 'lan');

  mount.appendChild(section);

  function refreshUrlsPanel(mode: NetworkAccess, netStatus: NetworkStatus): void {
    urlsMount.replaceChildren();
    warning.hidden = mode !== 'lan';
    voiceHint.hidden = mode !== 'lan' || netStatus.lanUrls.length === 0;
    if (mode === 'lan' && netStatus.lanUrls.length > 0) {
      renderLanUrls(urlsMount, netStatus.lanUrls);
    } else if (mode === 'lan') {
      urlsMount.appendChild(
        el('p', 'settings-field-hint', 'No LAN addresses detected. Check your network adapter.'),
      );
    }
  }

  async function applyMode(mode: NetworkAccess): Promise<void> {
    if (mode === selectedMode) return;
    const prev = selectedMode;
    selectedMode = mode;
    setActiveSegment(segmentGroup, mode);
    refreshUrlsPanel(mode, status);

    try {
      await saveNetworkAccess(mode);
      const nextStatus = await fetchNetworkStatus();
      if (nextStatus.restartRequired) {
        if (!restartEl) {
          restartEl = restartBanner();
          section.insertBefore(restartEl, urlsMount);
        }
        restartEl.hidden = false;
      }
      showToast('Network access saved — restart required to apply');
    } catch {
      selectedMode = prev;
      setActiveSegment(segmentGroup, prev);
      refreshUrlsPanel(prev, status);
      setStatus('err', 'Could not save network access');
    }
  }

  refreshUrlsPanel(selectedMode, status);

  if (status.restartRequired) {
    restartEl = restartBanner();
    section.insertBefore(restartEl, urlsMount);
  }

  void localBtn;
  void lanBtn;
}
