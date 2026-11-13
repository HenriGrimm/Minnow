import type { SettingsSectionId } from './settings-page-types';

const SUMMARIES: Partial<Record<SettingsSectionId, string>> = {
  general: 'What Minnow opens with.',
  appearance: 'How Minnow looks on this machine.',
  notifications: 'When Minnow taps you on the shoulder.',
  audio: 'Microphone, dictation and read-aloud.',
  devices: 'Use Minnow from your phone.',
  updates: 'Release channel and version.',
  editor: 'The code editor in the Files panel.',
  terminal: 'Your terminal and the ones agents use.',
  lsp: 'Language intelligence for the editor and agents.',
  browser: 'The preview browser and Agent Browser.',
  github: 'Pull requests, CI and the gh CLI.',
  issues: 'Where issues live and how they move.',
  'agent-center': 'One level for every tool, command, URL, MCP server and plugin.',
  injection: 'What every thread can see.',
  rules: 'Instructions every agent reads.',
  tools: 'Tool families and limits.',
  autopilot: 'How far agents go without you.',
  watchdog: 'Stalls, retries and crash recovery.',
  plugins: 'Tools, panels and skills from plugin packages.',
  skills: 'Slash skills that ship with Minnow.',
  'skills-library': 'Skill packs you can install.',
  'agent-packs': 'Preset teams of agents.',
  search: 'The engine behind web search.',
  mcp: 'Model Context Protocol servers.',
  'mcp-hub': 'Let other apps use Minnow.',
  servers: 'Local services Minnow runs.',
  webhooks: 'Trigger jobs from outside Minnow.',
  backups: 'Everything under ~/.minnow, on a schedule.',
  access: 'Permissions and safeguards for this computer.',
  about: 'Version and performance.',
  diagnostics: 'Check every part of the stack.',
};

/** Shared workbench headings. Section renderers retain their forms and field anchors. */
export function initGraphiteSettingsPresentation(root: HTMLElement): void {
  root.classList.add('settings-page--graphite');
  for (const [id, summary] of Object.entries(SUMMARIES)) {
    const title = root.querySelector(`#settingsSection-${id} > h2`);
    if (!title || title.nextElementSibling?.matches('.settings-section-summary')) continue;
    const description = root.ownerDocument.createElement('p');
    description.className = 'settings-section-summary';
    description.textContent = summary;
    title.after(description);
  }
}
