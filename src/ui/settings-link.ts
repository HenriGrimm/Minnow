/**
 * Turn a "Settings → Section" hint in notification text into the Settings
 * page it names, so the card can open it. Kept free of the settings catalog
 * so the toast engine (entry bundle) stays light.
 */

import type { SettingsSectionId } from './settings-page-types';

/** Lower-case names people write after "Settings →", longest first per section. */
const SECTION_ALIASES: Array<[string, SettingsSectionId]> = [
  ['health & diagnostics', 'diagnostics'],
  ['diagnostics', 'diagnostics'],
  ['filesystem access', 'access'],
  ['backup and restore', 'backups'],
  ['backups', 'backups'],
  ['model routing', 'model-routing'],
  ['routing', 'model-routing'],
  ['providers', 'providers'],
  ['sampler', 'sampler'],
  ['thinking', 'thinking'],
  ['usage', 'usage'],
  ['voice', 'voice'],
  ['web search', 'search'],
  ['search', 'search'],
  ['deep research', 'deep-research'],
  ['tool permissions', 'tools'],
  ['tools', 'tools'],
  ['browser', 'browser'],
  ['watchdog', 'watchdog'],
  ['timeouts & recovery', 'watchdog'],
  ['context policy', 'injection'],
  ['injection', 'injection'],
  ['chat context', 'injection'],
  ['agents', 'agent-center'],
  ['rules', 'rules'],
  ['modes', 'modes'],
  ['prompts', 'prompting'],
  ['skills library', 'skills-library'],
  ['skills', 'skills'],
  ['github', 'github'],
  ['issues', 'issues'],
  ['devices', 'devices'],
  ['appearance', 'appearance'],
  ['notifications', 'notifications'],
  ['updates', 'updates'],
  ['app updates', 'updates'],
  ['editor', 'editor'],
  ['terminal', 'terminal'],
  ['language servers', 'lsp'],
  ['mcp servers', 'mcp'],
  ['servers', 'servers'],
  ['plugins', 'plugins'],
  ['webhooks', 'webhooks'],
  ['data & privacy', 'data'],
];

export interface SettingsLink {
  section: SettingsSectionId;
  /** The path as written, e.g. "Settings → Tools → Browser". */
  label: string;
}

const PATH_RE = /Settings((?:\s*(?:→|->)\s*[A-Za-z][\w&' -]*)+)/;

function matchSegment(segment: string): [string, SettingsSectionId] | null {
  const text = segment.trim().toLowerCase();
  let best: [string, SettingsSectionId] | null = null;
  for (const alias of SECTION_ALIASES) {
    const [name] = alias;
    if (text !== name && !text.startsWith(`${name} `)) continue;
    if (!best || name.length > best[0].length) best = alias;
  }
  return best;
}

/** The Settings page a message points at, or null when it names none we know. */
export function findSettingsLink(text: string | undefined): SettingsLink | null {
  if (!text) return null;
  const match = PATH_RE.exec(text);
  if (!match) return null;
  const segments = match[1].split(/\s*(?:→|->)\s*/).filter(Boolean);
  // The deepest named section wins: "Agents → Watchdog" opens Watchdog.
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const hit = matchSegment(segments[i]);
    if (!hit) continue;
    // Drop trailing prose ("Tools for headless mode" → "Tools").
    const last = segments[i].trim().slice(0, hit[0].length);
    const label = ['Settings', ...segments.slice(0, i).map((s) => s.trim()), last].join(' → ');
    return { section: hit[1], label };
  }
  return null;
}
