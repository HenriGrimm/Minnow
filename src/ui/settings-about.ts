import '../styles/settings-general.css';
import '../styles/settings-about.css';
import { detectConfigServer } from '../config/storage-mode';
import {
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import { createSettingsKvList } from './settings-controls';
import {
  fetchDiagnosticsHealth,
  type DiagnosticsHealthPayload,
} from './health-strip';
import { getBootMetrics } from '../boot/boot-metrics';

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

function clearMount(id: string): HTMLElement | null {
  const mount = document.getElementById(id);
  if (!mount) return null;
  mount.replaceChildren();
  return mount;
}

/** Mono span for technical build values. */
function monoValue(text: string): HTMLElement {
  return el('span', 'about-build__mono', text);
}

/** Human-readable Electron label when the health API omits a version string. */
function formatElectronVersion(
  health: DiagnosticsHealthPayload | null,
): string {
  if (health?.electronVersion) return health.electronVersion;
  if (window.minnow) return 'Desktop shell';
  return 'Browser tab';
}

/** Populate Settings → About (build metadata). */
export async function renderAboutSettingsSection(): Promise<void> {
  const mount = clearMount('settingsAboutBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Version and runtime details for this install. Health probes and error logs live under ',
    linkToSettingsSection('Health & diagnostics', 'diagnostics'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const serverUp = await detectConfigServer();

  let health: DiagnosticsHealthPayload | null = null;
  if (serverUp) {
    health = await fetchDiagnosticsHealth();
  }

  const build = appendSettingsGroup(
    content,
    'This install',
    'App shell, runtime, and where Minnow stores settings on disk.',
    'about.info',
    { emphasis: true },
  );

  const version = health?.version ?? '—';
  const platform = health?.platform ?? navigator.platform;
  const nodeVersion = health?.nodeVersion ?? '—';
  const electronVersion = formatElectronVersion(health);

  build.appendChild(
    createSettingsKvList(
      [
        { term: 'App version', value: monoValue(version) },
        { term: 'Platform', value: monoValue(platform) },
        { term: 'Node', value: monoValue(nodeVersion) },
        { term: 'Electron', value: monoValue(electronVersion) },
        { term: 'Storage', value: monoValue('~/.minnow') },
      ],
      { className: 'settings-kv about-build__kv', searchKey: 'about.version' },
    ),
  );

  const boot = getBootMetrics();
  const perfDetails = el('details', 'about-build__perf-diag');
  perfDetails.appendChild(el('summary', 'about-build__perf-summary', 'Performance diagnostics'));
  const perfBody = el('div', 'about-build__perf-body');
  const bootLabel =
    boot != null ? `${boot.appReadyMs.toFixed(1)} ms to shell ready` : 'Shell ready — pending first boot';
  perfBody.appendChild(
    createSettingsKvList(
      [{ term: 'Boot (app-ready)', value: monoValue(bootLabel) }],
      { className: 'settings-kv about-build__kv', searchKey: 'about.boot' },
    ),
  );
  perfDetails.appendChild(perfBody);
  build.appendChild(perfDetails);
}
