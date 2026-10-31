import type { UserRulesSettings } from './user-rules';

/** Shared pure formatter; persistence and browser state stay outside prompt assembly. */
export function composeUserRulesPayload(settings: UserRulesSettings): string {
  const groupOrder = new Map(settings.groups.map((group, index) => [group.id, index]));
  const activeRules = settings.rules.filter((rule) => rule.enabled && rule.text.trim());
  activeRules.sort((a, b) => {
    const delta = (groupOrder.get(a.groupId) ?? 999) - (groupOrder.get(b.groupId) ?? 999);
    return delta || settings.rules.indexOf(a) - settings.rules.indexOf(b);
  });
  const parts: string[] = [];
  let currentGroupId: string | null = null;
  for (const rule of activeRules) {
    const group = settings.groups.find(row => row.id === rule.groupId);
    if (rule.groupId !== currentGroupId) {
      currentGroupId = rule.groupId;
      if (group?.name) parts.push(`## ${group.name}`);
    }
    const title = rule.title.trim();
    const text = rule.text.trim();
    parts.push(title ? `### ${title}\n${text}` : text);
  }
  return parts.join('\n\n');
}

export function getUserRulesPayloadForSend(settings: UserRulesSettings): string | null {
  if (!settings.enabled) return null;
  return composeUserRulesPayload(settings).trim() || null;
}
