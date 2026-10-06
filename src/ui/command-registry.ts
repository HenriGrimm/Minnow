export interface Command {
  id: string;
  /** Row label. */
  title: string;
  /** Grouping header in the unfiltered list. */
  group: string;
  /** Extra words that should match this command. */
  keywords?: string;
  /** Right-aligned key hint. */
  shortcut?: string;
  /** Filter destination; commands without one are classified by their group. */
  category?: CommandCategory;
  /** Hidden when this returns false (e.g. forge commands off GitHub). */
  available?: () => boolean;
  run: () => void | Promise<void>;
}

export type CommandCategory = 'Chats' | 'Code' | 'Workspace' | 'Models' | 'Settings' | 'Actions';

export function commandCategory(command: Command): CommandCategory {
  if (command.category) return command.category;
  if (command.group === 'Chat') return 'Chats';
  if (command.group === 'Code') return 'Code';
  if (command.group === 'Apps' || command.group === 'Workspace') return 'Workspace';
  if (command.group === 'Models' || command.group === 'Settings') return command.group;
  return 'Actions';
}

export type CommandSource = () => Command[];

interface Registration {
  id: string;
  order: number;
  source: CommandSource;
}

const sources = new Map<string, Registration>();

export function registerCommandSource(
  id: string,
  source: CommandSource,
  options: { order?: number } = {},
): () => void {
  sources.set(id, { id, order: options.order ?? 100, source });
  return () => {
    sources.delete(id);
  };
}

export function unregisterCommandSource(id: string): void {
  sources.delete(id);
}

/** Collect every currently available command. */
export function listCommands(): Command[] {
  const ordered = [...sources.values()].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const entry of ordered) {
    let commands: Command[] = [];
    try {
      commands = entry.source();
    } catch {
      commands = [];
    }
    for (const command of commands) {
      if (seen.has(command.id)) continue;
      if (command.available?.() === false) continue;
      seen.add(command.id);
      out.push(command);
    }
  }
  return out;
}

/** Registered source ids in resolved order (diagnostics and tests). */
export function listCommandSourceIds(): string[] {
  return [...sources.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

/** Drop every registration (tests). */
export function resetCommandRegistryForTests(): void {
  sources.clear();
}
