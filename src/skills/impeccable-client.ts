/**
 * Client-side Impeccable sub-command parsing and composed skill body for /impeccable sends.
 */

import commandMetadata from './impeccable/scripts/command-metadata.json' with { type: 'json' };
import {
  HARNESS_ALIASES as IMPECCABLE_COMMAND_ALIASES,
  resolveHarnessCommand,
} from './impeccable/harness-registry.mjs';

export const IMPECCABLE_SKILL_ID = 'impeccable';

export function resolveImpeccableCommandAlias(command: string): string {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return normalized;
  return resolveHarnessCommand(normalized) ?? normalized;
}

export { IMPECCABLE_COMMAND_ALIASES };

const METADATA_COMMANDS = new Set(Object.keys(commandMetadata as Record<string, unknown>));
const PARSE_COMMAND_WORDS = new Set([
  ...METADATA_COMMANDS,
  ...Object.keys(IMPECCABLE_COMMAND_ALIASES),
]);

/** Harness references injected alongside the primary slash command. */
export const HARNESS_PREREQUISITE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  craft: ['shape'],
};

const COMMAND_WORD_RE = /^([a-z][a-z0-9-]*)\b/i;

export interface ParsedImpeccableSubcommand {
  command: string | null;
  target: string;
}

/**
 * Parse text after `/impeccable` (from parseSlashCommand userText).
 * First word must be a known command or alias; remainder is the target hint.
 */
export function parseImpeccableSubcommand(userText: string): ParsedImpeccableSubcommand {
  let rest = userText.trim();
  if (!rest) {
    return { command: null, target: '' };
  }

  const lower = rest.toLowerCase();
  if (lower.startsWith('/impeccable')) {
    rest = rest.slice('/impeccable'.length).trim();
  } else if (lower.startsWith('impeccable ')) {
    rest = rest.slice('impeccable'.length).trim();
  }

  if (!rest) {
    return { command: null, target: '' };
  }

  const match = rest.match(COMMAND_WORD_RE);
  if (!match) {
    return { command: null, target: rest };
  }

  const candidate = match[1].toLowerCase();
  if (!PARSE_COMMAND_WORDS.has(candidate)) {
    return { command: null, target: rest };
  }

  const command = resolveImpeccableCommandAlias(candidate);
  const target = rest.slice(match[0].length).trim();
  return { command, target };
}

/** True when user sent bare `/impeccable` with no sub-command or target text. */
export function isBareImpeccableInvocation(userText: string): boolean {
  const { command, target } = parseImpeccableSubcommand(userText);
  return command === null && target.trim() === '';
}

interface ImpeccableReferenceResponse {
  content?: string;
}

interface ImpeccableUpstreamResponse {
  content?: string;
}

/** Load vendored reference markdown for a sub-command from the tool server. */
export async function fetchImpeccableReference(command: string): Promise<string | null> {
  const normalized = resolveImpeccableCommandAlias(command);
  if (!normalized || !METADATA_COMMANDS.has(normalized)) {
    return null;
  }

  try {
    const res = await fetch(
      `/api/skills/impeccable/reference/${encodeURIComponent(normalized)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as ImpeccableReferenceResponse;
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    return content || null;
  } catch {
    return null;
  }
}

/** Load patched SKILL.upstream.md body (without frontmatter) from the tool server. */
export async function fetchImpeccableUpstreamBody(): Promise<string | null> {
  try {
    const res = await fetch('/api/skills/impeccable/upstream', { cache: 'no-store' });
    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as ImpeccableUpstreamResponse;
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    return content || null;
  } catch {
    return null;
  }
}

function formatActiveCommandSection(command: string, content: string): string {
  return `---
## Active Impeccable command: ${command}
(follow this workflow; do not run \`npx impeccable ${command}\` or \`run_impeccable\` for this command)
${content}`;
}

function formatPrerequisiteSection(command: string, content: string): string {
  return `---
## Prerequisite workflow: ${command}
(required by the active command above; follow in chat — do not call \`run_impeccable\` or \`npx impeccable ${command}\`)
${content}`;
}

/** Commands to load for a slash send: primary first, then prerequisites (deduped). */
export function commandsForImpeccableAugment(primaryCommand: string): string[] {
  const primary = resolveImpeccableCommandAlias(primaryCommand);
  const prereqs = HARNESS_PREREQUISITE_COMMANDS[primary] ?? [];
  const ordered: string[] = [primary];
  for (const prereq of prereqs) {
    const cmd = prereq.trim().toLowerCase();
    if (cmd && cmd !== primary && !ordered.includes(cmd)) {
      ordered.push(cmd);
    }
  }
  return ordered;
}

/** Impeccable harness commands grouped for picker menus and bare `/impeccable` sends. */
export const IMPECCABLE_COMMAND_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'Setup & context': ['init', 'document', 'extract'],
  'Plan & build': ['shape', 'craft'],
  'Review & refine': ['audit', 'critique', 'polish', 'clarify', 'distill'],
  'Visual & motion': ['animate', 'colorize', 'typeset', 'layout', 'delight', 'bolder', 'quieter', 'overdrive'],
  Production: ['harden', 'onboard', 'adapt', 'optimize', 'live'],
};

/** Sub-commands shown in the slash picker after /impeccable is selected. */
export function listImpeccablePickerOptions(): SkillPickerOption[] {
  const meta = commandMetadata as Record<string, { description?: string }>;
  const options: SkillPickerOption[] = [];

  for (const [group, commands] of Object.entries(IMPECCABLE_COMMAND_GROUPS)) {
    for (const id of commands) {
      const entry = meta[id];
      if (!entry) continue;
      options.push({
        id,
        label: id,
        description: entry.description?.slice(0, 140),
        group,
      });
    }
  }

  return options;
}

interface SkillPickerOption {
  id: string;
  label: string;
  description?: string;
  group?: string;
}
/** Grouped command menu for bare `/impeccable` sends. */
export function formatImpeccableCommandMenu(): string {
  const meta = commandMetadata as Record<
    string,
    { description?: string; argumentHint?: string }
  >;

  const lines = [
    '---',
    '## Impeccable command menu',
    '(User invoked bare `/impeccable`. Ask which workflow they want, or pick the best match from the table.)',
    '',
  ];

  for (const [heading, commands] of Object.entries(IMPECCABLE_COMMAND_GROUPS)) {
    lines.push(`### ${heading}`, '', '| Command | Usage | Summary |', '| --- | --- | --- |');
    for (const cmd of commands) {
      const entry = meta[cmd];
      if (!entry) continue;
      const hint = entry.argumentHint?.trim() || '';
      const usage = hint ? `\`${cmd} ${hint}\`` : `\`${cmd}\``;
      const summary = (entry.description ?? '').replace(/\|/g, '\\|').slice(0, 200);
      lines.push(`| \`${cmd}\` | ${usage} | ${summary} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Compose full Impeccable skill body: Minnow addendum + upstream routing + optional refs/menu.
 */
export async function composeImpeccableSkillBody(
  minnowAddendum: string,
  userText: string,
): Promise<string> {
  const upstreamBody = await fetchImpeccableUpstreamBody();
  const parts: string[] = [minnowAddendum.trim()];
  if (upstreamBody) {
    parts.push('---', upstreamBody);
  }

  let composed = parts.join('\n\n');
  const { command } = parseImpeccableSubcommand(userText);

  if (command) {
    const sections: string[] = [];
    for (const cmd of commandsForImpeccableAugment(command)) {
      const content = await fetchImpeccableReference(cmd);
      if (!content) {
        if (cmd === command) {
          return composed;
        }
        continue;
      }
      sections.push(
        cmd === command
          ? formatActiveCommandSection(cmd, content)
          : formatPrerequisiteSection(cmd, content),
      );
    }
    if (sections.length > 0) {
      composed = `${composed}\n${sections.join('\n')}`;
    }
  } else if (isBareImpeccableInvocation(userText)) {
    composed = `${composed}\n\n${formatImpeccableCommandMenu()}`;
  }

  return composed;
}

/** Whether the send path should run composeImpeccableSkillBody for this skill + user text. */
export function shouldComposeImpeccableBody(
  skillId: string | null,
  userText: string,
): boolean {
  if (skillId === IMPECCABLE_SKILL_ID) return true;
  if (skillId === 'ui-designer' && parseImpeccableSubcommand(userText).command) {
    return true;
  }
  return false;
}

/**
 * @deprecated Composer hints are chosen via the slash picker options menu.
 */
export function impeccableComposerHint(): string {
  const top = ['init', 'polish', 'audit', 'craft', 'shape', 'critique'];
  return top.join(' | ');
}

/**
 * @deprecated Use composeImpeccableSkillBody
 */
export async function augmentImpeccableSkillBody(
  skillBody: string,
  userText: string,
): Promise<string> {
  return composeImpeccableSkillBody(skillBody, userText);
}
