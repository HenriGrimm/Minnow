import type { SettingsSectionId } from './settings-page-types';

const SUMMARIES: Partial<Record<SettingsSectionId, string>> = {
  general: 'What Minnow opens with.',
  appearance: 'How Minnow looks on this machine.',
  notifications: 'When Minnow taps you on the shoulder.',
  audio: 'Microphone, dictation and read-aloud.',
  devices: 'Use Minnow from your phone.',
  updates: 'Release channel and version.',
  shortcuts: 'Every keyboard shortcut in Minnow.',
  privacy: 'What stays on this computer and what goes online.',
  editor: 'The code editor in the Files panel.',
  terminal: 'Your terminal and the ones agents use.',
  lsp: 'Code intelligence (errors, go to definition) for the editor and agents.',
  browser: 'The preview browser and Agent Browser.',
  'external-connections': 'Connect service accounts through their CLIs. Agents can use the same sign-ins through the workspace shell.',
  issues: 'Where issues live and how they move.',
  'agent-center': 'What agents may do without asking, their prompts and sub-agent limits.',
  injection: 'What the model sees in every chat, and how long chats are kept.',
  rules: 'Instructions every agent reads.',
  tools: 'Tool families and limits.',
  autopilot: 'Advanced: how far board agents go without you.',
  watchdog: 'Advanced: stalls, retries and crash recovery.',
  plugins: 'Tools, panels and skills from plugin packages.',
  skills: 'Slash skills that ship with Minnow.',
  'skills-library': 'Skill packs you can install.',
  'agent-packs': 'Preset teams of agents.',
  search: 'The engine behind web search.',
  mcp: 'Add tools for your agents from other apps and services.',
  'mcp-hub': 'Let other apps use Minnow.',
  servers: 'Advanced: helper services Minnow can install and run on this computer.',
  webhooks: 'Advanced: notify other services when chats or jobs finish.',
  backups: 'Everything under ~/.minnow, on a schedule.',
  access: 'A summary of what agents and other devices can reach on this computer.',
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
