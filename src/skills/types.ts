/** Built-in repo skills vs user ~/.minnow/skills. */
export type SkillSource = 'builtin' | 'user';

/** Catalog row for slash picker (no body). */
export interface SkillListItem {
  id: string;
  label: string;
  description: string;
  source: SkillSource;
  path?: string;
  version?: string;
  disableModelInvocation?: boolean;
}

/** Full skill for send-path injection. */
export interface SkillDetail extends SkillListItem {
  body: string;
  /** Full SKILL.md source when loaded from API (editor). */
  raw?: string;
}

/** Resolved skill for the current send turn. */
export interface ActiveSkill {
  id: string;
  body: string;
  label: string;
}

/** Sticky slash skill pinned on a chat thread. */
export interface PinnedSkillState {
  id: string;
  /** Caveman-only: active compression level. */
  intensity?: string;
}
