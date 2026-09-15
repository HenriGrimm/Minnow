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
];

/** All built-in slash commands for the picker. */
export function getSlashCommandCatalog(): readonly SlashCommandListItem[] {
  return SLASH_COMMANDS;
}

/** Filter commands by partial token after `/` (same rules as skill picker). */
export function filterSlashCommands(query: string): SlashCommandListItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(
    (command) =>
      command.id.toLowerCase().includes(q) ||
      command.label.toLowerCase().includes(q) ||
      command.description.toLowerCase().includes(q) ||
      command.insertion.toLowerCase().includes(q),
  );
}
