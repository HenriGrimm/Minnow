import '../styles/graphite-apps.css';
import { createGitHubMark, createIcon, type IconName } from '../ui/icon';
import { isNarrowLayout, NARROW_MQ } from '../ui/mobile-layout';

const MODEL_GROUPS = [
  ['Run', ['server', 'recommend', 'installed', 'voice', 'settings', 'engine']],
  ['Connect', ['providers', 'clis', 'routers', 'routing']],
  ['Tune', ['sampler', 'thinking', 'usage']],
] as const;

const MODEL_ICONS: Partial<Record<string, IconName>> = {
  voice: 'mic',
  providers: 'link',
  clis: 'terminal',
  routers: 'codeMapInjection',
  routing: 'gitBranch',
  sampler: 'tools',
  thinking: 'bulb',
  usage: 'appStats',
};

const SETTINGS_ICONS: Partial<Record<string, IconName | 'githubMark'>> = {
  general: 'power',
  appearance: 'palette',
  notifications: 'bell',
  audio: 'speaker',
  devices: 'devices',
  updates: 'download',
  editor: 'edit',
  terminal: 'terminal',
  lsp: 'fileCode',
  browser: 'browser',
  'external-connections': 'link',
  github: 'githubMark',
  issues: 'appIssues',
  models: 'appModels',
  'agent-center': 'shieldCheck',
  injection: 'comment',
  rules: 'clipboardChecklist',
  tools: 'tools',
  autopilot: 'workflow',
  watchdog: 'stopwatch',
  plugins: 'puzzle',
  skills: 'sparkles',
  'skills-library': 'books',
  'agent-packs': 'openPackage',
  search: 'search',
  mcp: 'plug',
  'mcp-hub': 'link',
  servers: 'appServers',
  webhooks: 'webhook',
  backups: 'archive',
  access: 'lock',
  about: 'info',
  diagnostics: 'pulse',
};

/** Change the placement of existing controls while retaining their handlers and route IDs. */
export function initGraphiteAppChrome(): () => void {
  const root = document.documentElement;
  const settings = document.getElementById('settingsView');
  const settingsHeader = settings?.querySelector<HTMLElement>('.settings-page-header');
  const settingsTitle = document.createElement('h1');
  settingsTitle.className = 'settings-graphite-title';
  settingsTitle.textContent = 'Settings';
  const settingsInput = document.getElementById('settingsSearchInput') as HTMLInputElement | null;
  const originalPlaceholder = settingsInput?.placeholder ?? '';
  const search = document.getElementById('settingsSearchFinderSlot');
  const searchHome = search?.parentElement;
  const searchNext = search?.nextElementSibling;
  const settingsNav = settings?.querySelector<HTMLElement>('.settings-nav');
  const details = [...settingsNav?.querySelectorAll<HTMLDetailsElement>('details') ?? []];
  const modelsNav = document.querySelector('#modelsView .models-nav');
  const groups = [...modelsNav?.querySelectorAll<HTMLElement>('.models-nav__group') ?? []];
  const originals = groups.map((group) => ({
    group,
    label: group.querySelector<HTMLElement>('.models-nav__group-label'),
    labelText: group.querySelector('.models-nav__group-label')?.textContent ?? '',
    buttons: [...group.querySelectorAll<HTMLButtonElement>('[data-models-nav]')],
  }));
  const modelButtons = new Map(originals.flatMap(({ buttons }) => buttons.map((button) => [button.dataset.modelsNav, button] as const)));
  for (const [id, button] of modelButtons) {
    const name = id && MODEL_ICONS[id];
    if (name && !button.querySelector('.icon-svg')) {
      button.prepend(createIcon(name, { size: 14, className: 'models-nav__graphite-icon' }));
    }
  }
  for (const button of settingsNav?.querySelectorAll<HTMLButtonElement>('.settings-nav__item') ?? []) {
    const name = SETTINGS_ICONS[button.dataset.settingsNavArea ?? 'models'];
    if (!name) continue;
    const options = { size: 14, className: 'settings-nav__graphite-icon' };
    button.prepend(name === 'githubMark' ? createGitHubMark(options) : createIcon(name, options));
  }

  let active = false;
  let originalDetails = new Map<HTMLDetailsElement, boolean>();
  const sync = (desktop: boolean) => {
    if (desktop === active) return;
    active = desktop;
    root.classList.toggle('mn-graphite-apps', desktop);
    if (search && searchHome && settingsNav) {
      if (desktop) settingsNav.prepend(search);
      else searchHome.insertBefore(search, searchNext ?? null);
    }
    if (desktop) {
      const back = settingsHeader?.querySelector('#btnSettingsPageBack');
      if (back) back.after(settingsTitle);
      else settingsHeader?.prepend(settingsTitle);
      if (settingsInput) settingsInput.placeholder = 'Search settings';
      originalDetails = new Map(details.map((entry) => [entry, entry.open]));
      for (const entry of details) entry.open = true;
      for (let index = 0; index < MODEL_GROUPS.length; index++) {
        const original = originals[index];
        if (!original) continue;
        const [label, ids] = MODEL_GROUPS[index];
        if (original.label) original.label.textContent = label;
        for (const id of ids) {
          const button = modelButtons.get(id);
          if (button) original.group.appendChild(button);
        }
      }
    } else {
      settingsTitle.remove();
      if (settingsInput) settingsInput.placeholder = originalPlaceholder;
      for (const [entry, open] of originalDetails) entry.open = open;
      for (const { group, label, labelText, buttons } of originals) {
        if (label) label.textContent = labelText;
        for (const button of buttons) group.appendChild(button);
      }
    }
  };
  const onBreakpointChange = () => sync(!isNarrowLayout());
  const breakpoint = window.matchMedia?.(NARROW_MQ);
  breakpoint?.addEventListener?.('change', onBreakpointChange);
  onBreakpointChange();
  return () => {
    breakpoint?.removeEventListener?.('change', onBreakpointChange);
    sync(false);
    settingsNav?.querySelectorAll('.settings-nav__graphite-icon').forEach((icon) => icon.remove());
    modelsNav?.querySelectorAll('.models-nav__graphite-icon').forEach((icon) => icon.remove());
  };
}
