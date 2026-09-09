/**
 * Split composer / bubble text so known `/skill-id` tokens can render as chips.
 */

import { getSlashCommandCatalog } from '../chat/slash-commands/registry';
import builtinManifest from './builtin-manifest.json';
import { getAllSkillCatalog } from './client';

export type SkillTextPart =
  | { kind: 'text'; value: string }
  | { kind: 'chip'; value: string; skillId: string };

const SLASH_TOKEN_RE = /(?:^|\s)(\/[a-z0-9][a-z0-9-]*)\b/gi;

const BUILTIN_SKILL_IDS = new Set(
  (builtinManifest as { skills: Array<{ id: string }> }).skills.map((skill) => skill.id),
);

/** Ids that should paint as command chips (catalog + builtins + slash commands). */
export function getKnownSlashTokenIds(extraIds?: Iterable<string>): Set<string> {
  const ids = new Set<string>(BUILTIN_SKILL_IDS);
  for (const skill of getAllSkillCatalog()) {
    ids.add(skill.id);
  }
  for (const command of getSlashCommandCatalog()) {
    const token = command.insertion.replace(/^\//, '').split(/\s+/)[0];
    if (token) ids.add(token.toLowerCase());
  }
  if (extraIds) {
    for (const id of extraIds) {
      if (id) ids.add(id.toLowerCase());
    }
  }
  return ids;
}

/** Put the consumed slash token back in front of stored user text. */
export function restoreLeadingSkillToken(displayText: string, skillId: string | null): string {
  if (!skillId) return displayText;
  const token = `/${skillId}`;
  const trimmed = displayText.trimStart();
  if (
    trimmed === token ||
    trimmed.startsWith(`${token} `) ||
    trimmed.startsWith(`${token}\n`)
  ) {
    return displayText;
  }
  if (!displayText.trim()) return token;
  return `${token} ${displayText}`;
}

/** Walk text into plain runs and `/skill-id` chip runs. */
export function splitSlashSkillTokens(
  text: string,
  extraIds?: Iterable<string>,
): SkillTextPart[] {
  if (!text) return [];
  const known = getKnownSlashTokenIds(extraIds);
  const parts: SkillTextPart[] = [];
  let lastIndex = 0;
  const re = new RegExp(SLASH_TOKEN_RE.source, 'gi');

  for (const match of text.matchAll(re)) {
    if (match.index == null) continue;
    const full = match[0];
    const token = match[1];
    const skillId = token.slice(1).toLowerCase();
    const leadingWs = full.length > token.length ? full.length - token.length : 0;
    const tokenStart = match.index + leadingWs;

    if (!known.has(skillId)) continue;

    if (tokenStart > lastIndex) {
      parts.push({ kind: 'text', value: text.slice(lastIndex, tokenStart) });
    }
    parts.push({ kind: 'chip', value: token, skillId });
    lastIndex = tokenStart + token.length;
  }

  if (lastIndex < text.length) {
    parts.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  if (parts.length === 0) {
    parts.push({ kind: 'text', value: text });
  }
  return parts;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Overlay HTML for a composer highlight layer (text is escaped). */
export function highlightedSkillTextHtml(text: string, extraIds?: Iterable<string>): string {
  return splitSlashSkillTokens(text, extraIds)
    .map((part) =>
      part.kind === 'chip'
        ? `<span class="skill-chip">${escapeHtml(part.value)}</span>`
        : escapeHtml(part.value),
    )
    .join('');
}

/** Paint chip spans into a bubble without using innerHTML for user text. */
export function appendHighlightedSkillText(
  parent: HTMLElement,
  text: string,
  extraIds?: Iterable<string>,
): void {
  for (const part of splitSlashSkillTokens(text, extraIds)) {
    if (part.kind === 'text') {
      parent.appendChild(document.createTextNode(part.value));
      continue;
    }
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
    chip.textContent = part.value;
    parent.appendChild(chip);
  }
}
