import { getSkillCatalog } from '../../skills/client';

export interface SlashCommandListItem {
  /** Stable picker id (may differ from the first token, e.g. goal-clear). */
  id: string;
  label: string;
  description: string;
  /** Composer text inserted on picker selection (includes leading `/`). */
  insertion: string;
}

/** Registry of non-skill slash commands. Add new commands here. */
const SLASH_COMMANDS: SlashCommandListItem[] = [
  {
    id: 'compact',
    label: 'Compact',
    description: 'Fold older turns into a summary now; add text to say what to keep (aliases: /compress, /summarize)',
    insertion: '/compact',
  },
  {
    id: 'goal',
    label: 'Goal',
    description: 'Set a completion condition; an agentic verifier runs tests and checks code before confirming',
    insertion: '/goal ',
  },
  {
    id: 'goal-clear',
    label: 'Goal — clear',
    description: 'Stop the active goal loop (aliases: stop, off, reset)',
    insertion: '/goal clear',
  },
  {
    id: 'loop',
    label: 'Loop',
    description: 'Re-run a prompt on an interval (5m) or self-paced; bare /loop uses .minnow/loop.md',
    insertion: '/loop ',
  },
  {
    id: 'followup',
    label: 'Follow-up',
    description: 'Open the next task in a new chat with a summary of this one; add a count to chain (e.g. /followup 3 review the build)',
    insertion: '/followup ',
  },
];

export interface PluginSlashCommand {
  id: string;
  label: string;
  description: string;
  alias?: string;
  run: (input: { args: string; chatId: string; workspacePath: string }) => void | Promise<void>;
}

interface RegisteredPluginSlash {
  name: string;
  command: PluginSlashCommand;
  running: boolean;
}
const pluginCommands = new Map<string, RegisteredPluginSlash>();
const builtinTokens = new Set(['compress', 'summarize', ...SLASH_COMMANDS.map(c => c.insertion.slice(1).split(/\s/)[0])]);
const reserved = (name: string) => builtinTokens.has(name) || getSkillCatalog().some(skill => skill.id === name);

/** Canonical names cannot shadow skills or core commands; short aliases are optional. */
export function registerPluginSlashCommand(pluginId: string, command: PluginSlashCommand): () => void {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(command.id)) throw new Error('Invalid slash command id');
  if (!command.label?.trim() || !command.description?.trim() || typeof command.run !== 'function') throw new Error('Slash commands need a label, description and run function');
  const name = `plugin-${pluginId}--${command.id.replaceAll('_', '-')}`;
  if (pluginCommands.has(name)) throw new Error('Duplicate plugin slash command');
  if (command.alias && (!/^[a-z][a-z0-9-]{0,47}$/.test(command.alias) || reserved(command.alias) || [...pluginCommands.values()].some(row => row.name === command.alias || row.command.alias === command.alias))) throw new Error('Slash command alias is invalid or already in use');
  const row: RegisteredPluginSlash = { name, command, running: false };
  pluginCommands.set(name, row);
  return () => { if (pluginCommands.get(name) === row) pluginCommands.delete(name); };
}

function findPluginCommand(text: string): { row: RegisteredPluginSlash; args: string } | null {
  const match = text.trim().match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const row = [...pluginCommands.values()].find(row => row.name === match[1] || (row.command.alias === match[1] && !reserved(match[1])));
  return row ? { row, args: match[2] ?? '' } : null;
}

export function isPluginSlashCommand(text: string): boolean { return findPluginCommand(text) !== null; }

/** True means handled locally; errors stay out of the model send path. */
export async function dispatchPluginSlashCommand(text: string, input: { chatId: string; workspacePath: string }): Promise<boolean> {
  const found = findPluginCommand(text);
  if (!found) return false;
  if (found.row.running) throw new Error('Plugin command is already running');
  found.row.running = true;
  try { await found.row.command.run({ ...input, args: found.args }); }
  finally { found.row.running = false; }
  return true;
}

function pluginCatalog(): SlashCommandListItem[] {
  return [...pluginCommands.values()].map(({ name, command }) => ({
    id: name, label: command.label,
    description: `${command.description} (/${name})`,
    insertion: `/${command.alias && !reserved(command.alias) ? command.alias : name} `,
  }));
}

/** All built-in slash commands for the picker. */
export function getSlashCommandCatalog(): readonly SlashCommandListItem[] {
  return [...SLASH_COMMANDS, ...pluginCatalog()];
}

/** Filter commands by partial token after `/` (same rules as skill picker). */
export function filterSlashCommands(query: string): SlashCommandListItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [...getSlashCommandCatalog()];
  return getSlashCommandCatalog().filter(
    (command) =>
      command.id.toLowerCase().includes(q) ||
      command.label.toLowerCase().includes(q) ||
      command.description.toLowerCase().includes(q) ||
      command.insertion.toLowerCase().includes(q),
  );
}
