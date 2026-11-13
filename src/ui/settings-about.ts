import '../styles/settings-general.css';
import '../styles/settings-about.css';
import { detectConfigServer } from '../config/storage-mode';
import {
  appendSettingsGroup,
  linkToProductWiki,
  linkToRepositoryDoc,
  linkToSettingsSection,
} from './settings-layout';
import { createSettingsKvList } from './settings-controls';
import {
  fetchDiagnosticsHealth,
  type DiagnosticsHealthPayload,
} from './health-strip';
import { getBootMetrics } from '../boot/boot-metrics';
import { createIcon } from './icon';

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

function timing(value?: number): string {
  return value === undefined ? '—' : `${value.toFixed(0)} ms`;
}

function performanceCards(): HTMLElement {
  const boot = getBootMetrics();
  const firstPaint = performance.getEntriesByName?.('first-contentful-paint', 'paint')[0]?.startTime;
  const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  const cards = el('dl', 'about-build__metrics');
  cards.dataset.settingsSearchKey = 'about.boot';
  for (const [label, value, hint] of [
    ['Shell ready', timing(boot?.appReadyMs), 'From app startup'],
    ['Interactive', timing(boot?.interactiveMs), 'From app startup'],
    ['First content', timing(firstPaint), 'From page navigation'],
    ['Document ready', timing(navigation?.domContentLoadedEventEnd || undefined), 'From page navigation'],
  ]) {
    const card = el('div', 'about-build__metric');
    const detail = el('dd');
    detail.append(el('span', 'about-build__metric-value', value), el('span', 'about-build__metric-hint', hint));
    card.append(el('dt', '', label), detail);
    cards.appendChild(card);
  }
  return cards;
}

/** Populate Settings → About (build metadata). */
export async function renderAboutSettingsSection(): Promise<void> {
  const mount = clearMount('settingsAboutBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const serverUp = (await detectConfigServer()) === 'server';
  const health = serverUp ? await fetchDiagnosticsHealth() : null;

  const hero = el('div', 'about-build__hero');
  const mark = el('span', 'about-build__mark', 'm');
  mark.setAttribute('aria-hidden', 'true');
  const name = el('div', 'about-build__name');
  name.append(
    el('span', 'about-build__title', health?.version ? `Minnow ${health.version}` : 'Minnow'),
    el('span', 'about-build__caption', [
      health?.platform,
      health?.electronVersion ? `Electron ${health.electronVersion}` : formatElectronVersion(health),
      health?.nodeVersion ? `Node ${health.nodeVersion}` : null,
    ].filter(Boolean).join(' · ')),
  );
  const releases = el('a', 'settings-inline-btn', 'Release notes');
  releases.href = 'https://github.com/henrigrimm/minnow/releases';
  releases.target = '_blank';
  releases.rel = 'noopener noreferrer';
  hero.append(mark, name, releases);
  content.appendChild(hero);

  appendSettingsGroup(content, 'Performance diagnostics').appendChild(performanceCards());

  const links = el('div', 'about-build__links');
  const docs = linkToProductWiki('Documentation', 'documentation/manual/README.md');
  const licenses = linkToRepositoryDoc('Licenses', 'documentation/THIRD_PARTY_NOTICES.md');
  const diagnostics = linkToSettingsSection('Health and diagnostics', 'diagnostics');
  for (const [link, glyph] of [[docs, 'link'], [licenses, 'chevronRight'], [diagnostics, 'chevronRight']] as const) {
    link.appendChild(createIcon(glyph));
    links.appendChild(link);
  }
  content.appendChild(links);

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

}
