import { randomUUID } from '../lib/random-id';
/**
 * Global user rules persisted in ~/.minnow/rules.json (Settings → Rules).
 */

import { bumpPromptConfigEpoch } from '../chat/outbound-estimate-epochs';
import { detectConfigServer, isConfigServerMode } from './storage-mode';
import { getRules, putRules } from './api-client';
import { defaultUserRulesSettings } from './defaults';

/** Default group id for migrated and new rules. */
export const DEFAULT_USER_RULES_GROUP_ID = 'general';

export interface UserRuleGroup {
  id: string;
  name: string;
}

export interface UserRuleItem {
  id: string;
  title: string;
  text: string;
  enabled: boolean;
  groupId: string;
}

export interface UserRulesSettings {
  version: 2;
  enabled: boolean;
  groups: UserRuleGroup[];
  rules: UserRuleItem[];
}

const USER_RULES_STORAGE_KEY = 'minnow.userRules';

/** Max UTF-8 bytes for combined rule text (matches server validator). */
export const MAX_USER_RULES_BYTES = 16 * 1024;

let cachedRules: UserRulesSettings | null = null;

function newRuleId(): string {
  return randomUUID();
}

function newGroupId(): string {
  return randomUUID();
}

/** Empty v2 settings with a General group. */
export function createDefaultUserRulesGroups(): UserRuleGroup[] {
  return [{ id: DEFAULT_USER_RULES_GROUP_ID, name: 'General' }];
}

/** Create a group row for the rules editor. */
export function createUserRuleGroup(name: string): UserRuleGroup {
  return { id: newGroupId(), name: name.trim() || 'Untitled group' };
}

/** Outcome of removing a group without touching rules in other groups. */
export type RemoveUserRuleGroupResult =
  | { ok: true; settings: UserRulesSettings }
  | { ok: false; error: string };

/**
 * Remove a rule group from Settings → Rules.
 *
 * Block-until-empty: a group that still has rules is left in place so we never
 * drop those rows or let normalize remap them onto another group. The last
 * remaining group is also kept — an empty `groups` list is rewritten back to
 * the default General group on save/reload, so that delete would not stick.
 */
export function removeUserRuleGroup(
  settings: UserRulesSettings,
  groupId: string,
): RemoveUserRuleGroupResult {
  const group = settings.groups.find((row) => row.id === groupId);
  if (!group) {
    return { ok: false, error: 'That rule group is already gone.' };
  }

  const ruleCount = settings.rules.filter((rule) => rule.groupId === groupId).length;
  if (ruleCount > 0) {
    const ruleLabel = ruleCount === 1 ? '1 rule' : `${ruleCount} rules`;
    const pronoun = ruleCount === 1 ? 'it' : 'them';
    return {
      ok: false,
      error: `Cannot delete "${group.name}": it still has ${ruleLabel}. Move or delete ${pronoun} first.`,
    };
  }

  if (settings.groups.length <= 1) {
    return { ok: false, error: 'Keep at least one rule group.' };
  }

  return {
    ok: true,
    settings: {
      ...settings,
      groups: settings.groups.filter((row) => row.id !== groupId),
      rules: [...settings.rules],
    },
  };
}

/** Create a rule row bound to a group. */
export function createUserRuleItem(
  groupId: string,
  partial: Partial<Pick<UserRuleItem, 'title' | 'text' | 'enabled'>> = {},
): UserRuleItem {
  return {
    id: newRuleId(),
    title: partial.title?.trim() ?? 'New rule',
    text: partial.text ?? '',
    enabled: partial.enabled !== false,
    groupId,
  };
}

function migrateLegacyUserRules(
  raw: Record<string, unknown>,
): UserRulesSettings {
  const enabled = raw.enabled === true;
  const legacyText = typeof raw.text === 'string' ? raw.text.trim() : '';
  const groups = createDefaultUserRulesGroups();
  const rules: UserRuleItem[] = [];

  if (legacyText) {
    rules.push({
      id: newRuleId(),
      title: 'Imported rule',
      text: legacyText,
      enabled: true,
      groupId: DEFAULT_USER_RULES_GROUP_ID,
    });
  }

  return { version: 2, enabled, groups, rules };
}

function normalizeUserRuleGroup(raw: unknown, index: number): UserRuleGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `group-${index}`;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Untitled group';
  return { id, name };
}

function normalizeUserRuleItem(
  raw: unknown,
  groups: UserRuleGroup[],
  index: number,
): UserRuleItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const fallbackGroupId = groups[0]?.id ?? DEFAULT_USER_RULES_GROUP_ID;
  const groupId =
    typeof row.groupId === 'string' && groups.some((g) => g.id === row.groupId)
      ? row.groupId
      : fallbackGroupId;
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `rule-${index}`;
  const title = typeof row.title === 'string' ? row.title : 'Untitled rule';
  const text = typeof row.text === 'string' ? row.text : '';
  const enabled = row.enabled !== false;
  return { id, title, text, enabled, groupId };
}

/** Normalize persisted or API payload into v2 settings. */
export function normalizeUserRules(
  raw: Partial<UserRulesSettings> | Record<string, unknown> | null | undefined,
): UserRulesSettings {
  const base = defaultUserRulesSettings();
  if (!raw || typeof raw !== 'object') return base;

  const parsed = raw as Record<string, unknown>;
  if (parsed.version !== 2 || !Array.isArray(parsed.groups) || !Array.isArray(parsed.rules)) {
    return migrateLegacyUserRules(parsed);
  }

  const enabled = parsed.enabled === true;
  const groupsRaw = parsed.groups as unknown[];
  let groups = groupsRaw
    .map((group, index) => normalizeUserRuleGroup(group, index))
    .filter((group): group is UserRuleGroup => group != null);

  if (!groups.length) {
    groups = createDefaultUserRulesGroups();
  }

  const rules = (parsed.rules as unknown[])
    .map((rule, index) => normalizeUserRuleItem(rule, groups, index))
    .filter((rule): rule is UserRuleItem => rule != null);

  return { version: 2, enabled, groups, rules };
}

/** Total UTF-8 bytes across all rule bodies (for save validation). */
export function computeUserRulesTotalBytes(settings: UserRulesSettings): number {
  return new TextEncoder().encode(
    settings.rules.map((rule) => rule.text).join('\n'),
  ).length;
}

/** Compose markdown-ish payload from enabled rules for the second system message. */
export function composeUserRulesPayload(settings: UserRulesSettings): string {
  const groupOrder = new Map(settings.groups.map((group, index) => [group.id, index]));
  const activeRules = settings.rules.filter((rule) => rule.enabled && rule.text.trim());

  activeRules.sort((a, b) => {
    const groupDelta =
      (groupOrder.get(a.groupId) ?? 999) - (groupOrder.get(b.groupId) ?? 999);
    if (groupDelta !== 0) return groupDelta;
    return settings.rules.indexOf(a) - settings.rules.indexOf(b);
  });

  const parts: string[] = [];
  let currentGroupId: string | null = null;

  for (const rule of activeRules) {
    const group = settings.groups.find((row) => row.id === rule.groupId);
    if (rule.groupId !== currentGroupId) {
      currentGroupId = rule.groupId;
      if (group?.name) parts.push(`## ${group.name}`);
    }

    const title = rule.title.trim();
    const text = rule.text.trim();
    if (title) {
      parts.push(`### ${title}\n${text}`);
    } else {
      parts.push(text);
    }
  }

  return parts.join('\n\n');
}

/** Legacy single-string export for setup profiles. */
export function exportUserRulesLegacyText(settings: UserRulesSettings): string {
  return composeUserRulesPayload(settings);
}

function readLocalUserRules(): UserRulesSettings {
  try {
    const stored = localStorage.getItem(USER_RULES_STORAGE_KEY);
    if (!stored) return defaultUserRulesSettings();
    return normalizeUserRules(JSON.parse(stored) as Partial<UserRulesSettings>);
  } catch {
    return defaultUserRulesSettings();
  }
}

function writeLocalUserRules(settings: UserRulesSettings): void {
  localStorage.setItem(USER_RULES_STORAGE_KEY, JSON.stringify(settings));
}

/** Load user rules (cached until reset). Server-first when npm start is up. */
export async function loadUserRules(): Promise<UserRulesSettings> {
  if (cachedRules) return cachedRules;

  const serverUp = await detectConfigServer();
  if (isConfigServerMode(serverUp)) {
    try {
      cachedRules = normalizeUserRules(await getRules());
      writeLocalUserRules(cachedRules);
      return cachedRules;
    } catch {
      cachedRules = readLocalUserRules();
      return cachedRules;
    }
  }

  cachedRules = readLocalUserRules();
  return cachedRules;
}

/** Synchronous read of last loaded or local fallback. */
export function getUserRulesSync(): UserRulesSettings {
  return cachedRules ?? readLocalUserRules();
}

/** Persist user rules to server and localStorage mirror. */
export async function saveUserRules(settings: UserRulesSettings): Promise<void> {
  const normalized = normalizeUserRules(settings);
  const bytes = computeUserRulesTotalBytes(normalized);
  if (bytes > MAX_USER_RULES_BYTES) {
    throw new Error(`User rules text exceeds ${MAX_USER_RULES_BYTES} bytes`);
  }

  writeLocalUserRules(normalized);
  cachedRules = normalized;
  bumpPromptConfigEpoch();

  const serverUp = await detectConfigServer();
  if (!isConfigServerMode(serverUp)) return;

  await putRules(normalized);
}

/** Clear in-memory cache (tests or after external edits). */
export function resetUserRulesCache(): void {
  cachedRules = null;
}

/**
 * Trimmed rules body for the second system message on send.
 * Returns null when disabled or empty.
 */
export function getUserRulesPayloadForSend(settings: UserRulesSettings): string | null {
  if (!settings.enabled) return null;
  const composed = composeUserRulesPayload(settings).trim();
  return composed || null;
}
