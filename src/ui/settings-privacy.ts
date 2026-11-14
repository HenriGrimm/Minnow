/**
 * Settings → Data and privacy → Privacy: a plain-language answer to "does my
 * data stay on this computer?". Read-only; every line links to the page that
 * controls it, so this page can never disagree with the real setting.
 */

import { linkToModelsSection, linkToSettingsSection } from './settings-layout';
import { appendSettingsGroup } from './settings-layout';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type PrivacyLine = {
  title: string;
  body: string;
  link?: HTMLButtonElement;
};

function renderList(mount: HTMLElement, lines: PrivacyLine[]): void {
  const list = el('ul', 'settings-privacy__list');
  for (const line of lines) {
    const item = el('li', 'settings-privacy__item');
    item.append(el('span', 'settings-privacy__title', line.title), el('span', 'settings-privacy__body', line.body));
    if (line.link) item.append(line.link);
    list.append(item);
  }
  mount.append(list);
}

/** Render the Privacy summary into its section body. */
export function renderPrivacySettings(mount: HTMLElement): void {
  mount.replaceChildren();
  const shell = el('div', 'settings-general settings-privacy');
  mount.append(shell);

  const local = appendSettingsGroup(
    shell,
    'Stays on this computer',
    'Minnow keeps your work in the Minnow folder in your home directory (~/.minnow). Nothing here is uploaded unless you turn on a feature below.',
    'privacy.local',
    { emphasis: true },
  );
  renderList(local, [
    { title: 'Chats, projects and issues', body: 'Saved on this computer only.' },
    { title: 'Brain notes and memories', body: 'Saved on this computer only.' },
    {
      title: 'Passwords and keys you enter',
      body: 'Encrypted on this computer. Backups include them only when you set a backup passphrase.',
      link: linkToSettingsSection('Backups', 'backups'),
    },
    {
      title: 'Usage analytics and crash reports',
      body: 'Minnow does not collect them. Health checks and error logs stay on this computer.',
      link: linkToSettingsSection('Health and diagnostics', 'diagnostics'),
    },
  ]);

  const online = appendSettingsGroup(
    shell,
    'Goes online only when you use it',
    'Each of these is off until you set it up, and talks only to the service you chose.',
    'privacy.online',
    { emphasis: true },
  );
  renderList(online, [
    {
      title: 'Online AI models',
      body: 'Local models (LM Studio, llama.cpp) never leave this computer. An online provider you add receives the chats you send to it.',
      link: linkToModelsSection('Models and connections', 'providers'),
    },
    {
      title: 'Web search',
      body: 'When an agent searches the web, the query goes to the search service you picked.',
      link: linkToSettingsSection('Web search', 'search'),
    },
    {
      title: 'Agents reaching websites',
      body: 'Agents can open web pages or run commands that use the internet, within your permission level.',
      link: linkToSettingsSection('Agents and permissions', 'agent-center'),
    },
    {
      title: 'Add-on tools and accounts',
      body: 'MCP servers, plugins and connected accounts (GitHub and others) talk to their own services.',
      link: linkToSettingsSection('MCP servers', 'mcp'),
    },
    {
      title: 'Phone access',
      body: 'Off by default. Home network keeps traffic on your Wi-Fi; Anywhere routes it through Tailscale.',
      link: linkToSettingsSection('Devices', 'devices'),
    },
    {
      title: 'Updates, downloads and fonts',
      body: 'Update checks, model and tool downloads, and web fonts (only when you pick one) fetch files from their publishers.',
      link: linkToSettingsSection('Updates', 'updates'),
    },
  ]);
}
