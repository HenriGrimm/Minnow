import { filterSlashCommands, type SlashCommandListItem } from './registry';
import { getSkillCatalog } from '../../skills/client';
import type { SkillListItem } from '../../skills/types';
import type { IconName } from '../../ui/icon';

export type SlashPickerKind = 'skill' | 'command';
/** `recent` only appears for an empty query. */
export type SlashPickerSection = 'recent' | 'commands' | 'skills';

export interface SlashPickerSkillRow {
  kind: 'skill';
  skill: SkillListItem;
  section: SlashPickerSection;
  icon?: IconName;
}

export interface SlashPickerCommandRow {
  kind: 'command';
  command: SlashCommandListItem;
  section: SlashPickerSection;
}

export type SlashPickerRow = SlashPickerSkillRow | SlashPickerCommandRow;

/** Skills that replaced the composer modes; listed with the commands. */
export const WORKFLOW_SKILLS: ReadonlyArray<{ id: string; icon: IconName; order: number }> = [
  { id: 'ask', icon: 'slashAsk', order: 1 },
  { id: 'plan', icon: 'slashPlan', order: 2 },
  { id: 'debug', icon: 'slashDebug', order: 3 },
];

const RECENT_KEY = 'minnow.slashMenu.recent';
const RECENT_LIMIT = 3;

/** Picker id shared by recents and rendering. */
export function slashPickerRowId(row: SlashPickerRow): string {
  return row.kind === 'skill' ? `skill:${row.skill.id}` : `command:${row.command.id}`;
}

export function readSlashRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Remember a picked row so it leads the menu next time. */
export function recordSlashRecent(row: SlashPickerRow): void {
  const id = slashPickerRowId(row);
  const next = [id, ...readSlashRecents().filter((v) => v !== id)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: recents are a convenience */
  }
}

/**
 * Rank a candidate for the typed query: prefix on the id, then the label,
 * then substring, then the description. -1 drops it.
 */
export function rankSlashMatch(query: string, id: string, label: string, description: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const i = id.toLowerCase();
  const l = label.toLowerCase().replace(/^\//, '');
  if (i.startsWith(q)) return 0;
  if (l.startsWith(q)) return 1;
  if (i.includes(q) || l.includes(q)) return 2;
  if (description.toLowerCase().includes(q)) return 3;
  return -1;
}

function commandToken(command: SlashCommandListItem): string {
  return command.insertion.replace(/^\//, '').split(/\s+/)[0]?.toLowerCase() || command.id;
}

/** Commands, then skills, filtered and ranked by the token typed after `/`. */
export function listSlashPickerRows(query: string): SlashPickerRow[] {
  const catalog = getSkillCatalog();
  const skillIds = new Set(catalog.map((skill) => skill.id));
  const workflow = new Map(WORKFLOW_SKILLS.map((row) => [row.id, row]));

  type Ranked = { row: SlashPickerRow; rank: number; order: number; label: string };
  const commands: Ranked[] = [];
  const skills: Ranked[] = [];

  for (const command of filterSlashCommands('')) {
    const token = commandToken(command);
    if (command.insertion && skillIds.has(token) && !command.skillId) continue;
    const rank = rankSlashMatch(query, token, command.label, command.description);
    if (rank < 0) continue;
    commands.push({ row: { kind: 'command', command, section: 'commands' }, rank, order: command.order ?? 50, label: command.label });
  }

  for (const skill of catalog) {
    const rank = rankSlashMatch(query, skill.id, skill.label, skill.description);
    if (rank < 0) continue;
    const promoted = workflow.get(skill.id);
    const entry: Ranked = {
      row: { kind: 'skill', skill, section: promoted ? 'commands' : 'skills', ...(promoted ? { icon: promoted.icon } : {}) },
      rank,
      order: promoted?.order ?? 100,
      label: skill.label,
    };
    (promoted ? commands : skills).push(entry);
  }

  const byRank = (a: Ranked, b: Ranked) =>
    a.rank - b.rank || a.order - b.order || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  commands.sort(byRank);
  skills.sort(byRank);

  const ordered = [...commands, ...skills].map((entry) => entry.row);
  if (query.trim()) return ordered;

  const recentIds = readSlashRecents();
  const recent: SlashPickerRow[] = [];
  for (const id of recentIds) {
    const found = ordered.find((row) => slashPickerRowId(row) === id);
    if (found) recent.push({ ...found, section: 'recent' } as SlashPickerRow);
  }
  const recentSet = new Set(recent.map(slashPickerRowId));
  return [...recent, ...ordered.filter((row) => !recentSet.has(slashPickerRowId(row)))];
}
