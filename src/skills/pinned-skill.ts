/**
 * Resolve the turn's slash skill and any persistent chat pin.
 */

import {
  CAVEMAN_SKILL_ID,
  DEFAULT_CAVEMAN_INTENSITY,
  isCavemanIntensity,
  parseCavemanIntensity,
} from './caveman-client';
import { isPartyModeStopPhrase, PARTYMODE_SKILL_ID } from './partymode-client';
import type { PinnedSkillState } from './types';

export type { PinnedSkillState };

export interface ResolveTurnSkillInput {
  slashSkillId: string | null;
  userText: string;
  pinned: PinnedSkillState | null | undefined;
  isSkillEnabled: (id: string) => boolean;
}

export interface ResolveTurnSkillResult {
  skillId: string | null;
  nextPinned: PinnedSkillState | null;
  /** True when skillId came from chat.pinnedSkill, not a slash on this message. */
  fromPin: boolean;
}

const CAVEMAN_STOP_RE = /\b(stop\s+caveman|normal\s+mode)\b/i;

/** Detect user intent to exit caveman mode. */
export function isCavemanStopPhrase(text: string): boolean {
  return CAVEMAN_STOP_RE.test(text.trim());
}

function cavemanPin(
  userText: string,
  previous: PinnedSkillState | null,
): PinnedSkillState {
  const intensity = parseCavemanIntensity(userText) ??
    (isCavemanIntensity(previous?.intensity) ? previous.intensity : DEFAULT_CAVEMAN_INTENSITY);
  return { id: CAVEMAN_SKILL_ID, intensity };
}

/**
 * A slash skill takes precedence for this turn. Caveman and Party Mode also pin themselves.
 */
export function resolveTurnSkill(input: ResolveTurnSkillInput): ResolveTurnSkillResult {
  const { slashSkillId, userText, isSkillEnabled } = input;
  let nextPinned = input.pinned ?? null;

  if (isCavemanStopPhrase(userText)) {
    if (nextPinned?.id === CAVEMAN_SKILL_ID) {
      nextPinned = null;
    }
    if (!slashSkillId) {
      return { skillId: null, nextPinned, fromPin: false };
    }
  }

  if (isPartyModeStopPhrase(userText)) {
    if (nextPinned?.id === PARTYMODE_SKILL_ID) {
      nextPinned = null;
    }
    if (!slashSkillId) {
      return { skillId: null, nextPinned, fromPin: false };
    }
  }

  if (slashSkillId) {
    if (!isSkillEnabled(slashSkillId)) {
      return { skillId: null, nextPinned, fromPin: false };
    }
    if (slashSkillId === CAVEMAN_SKILL_ID) nextPinned = cavemanPin(userText, nextPinned);
    if (slashSkillId === PARTYMODE_SKILL_ID) nextPinned = { id: PARTYMODE_SKILL_ID };
    return { skillId: slashSkillId, nextPinned, fromPin: false };
  }

  if (nextPinned && isSkillEnabled(nextPinned.id)) {
    return { skillId: nextPinned.id, nextPinned, fromPin: true };
  }

  return { skillId: null, nextPinned, fromPin: false };
}

/** Strip leading caveman intensity from user text when slash invoked /caveman. */
export function normalizeCavemanUserText(
  skillId: string | null,
  slashSkillId: string | null,
  userText: string,
): string {
  if (skillId !== CAVEMAN_SKILL_ID || slashSkillId !== CAVEMAN_SKILL_ID) {
    return userText;
  }
  const parsed = parseCavemanIntensity(userText);
  if (!parsed) return userText;
  return userText.trim().slice(parsed.length).trim();
}

/** Normalize persisted pinned skill on chat load. */
export function ensurePinnedSkill(raw: unknown): PinnedSkillState | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<PinnedSkillState>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const intensity =
    typeof row.intensity === 'string' && isCavemanIntensity(row.intensity.trim())
      ? row.intensity.trim()
      : undefined;
  return intensity ? { id, intensity } : { id };
}
