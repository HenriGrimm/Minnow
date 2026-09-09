export type { ActiveSkill, PinnedSkillState, SkillDetail, SkillListItem, SkillSource } from './types';

export { parseSkillFrontmatter, defaultSkillLabel } from './parse-frontmatter';

export { mergeSkillLists, resolveSkillDetail } from './loader';

export {

  parseSlashCommand,

  formatHistoryWithSkillTag,

  type ParsedSlashCommand,

} from './parse-slash';

export {

  appendHighlightedSkillText,

  highlightedSkillTextHtml,

  restoreLeadingSkillToken,

  splitSlashSkillTokens,

  type SkillTextPart,

} from './skill-chip';

export {

  fetchSkillById,

  getSkillCatalog,

  refreshSkillCatalog,

  resolveActiveSkill,

} from './client';

export {

  IMPECCABLE_SKILL_ID,

  parseImpeccableSubcommand,

  fetchImpeccableReference,

  composeImpeccableSkillBody,

  shouldComposeImpeccableBody,

  impeccableComposerHint,

  /** @deprecated Use composeImpeccableSkillBody */
  augmentImpeccableSkillBody,

  type ParsedImpeccableSubcommand,

} from './impeccable-client';

export {

  CAVEMAN_SKILL_ID,

  CAVEMAN_INTENSITIES,

  DEFAULT_CAVEMAN_INTENSITY,

  parseCavemanIntensity,

  stripLeadingCavemanIntensity,

  augmentCavemanSkillBody,

  isCavemanIntensity,

  type CavemanIntensity,

} from './caveman-client';

export {

  PARTYMODE_SKILL_ID,

  augmentPartyModeSkillBody,

  isPartyModePinned,

  isPartyModeStopPhrase,

} from './partymode-client';

export {

  GIT_SETUP_SKILL_ID,

  prepareGitSetupTurn,

} from './git-setup-client';

export {

  ensurePinnedSkill,

  isCavemanStopPhrase,

  normalizeCavemanUserText,

  resolveTurnSkill,

  type ResolveTurnSkillInput,

  type ResolveTurnSkillResult,

} from './pinned-skill';

export {

  getSkillConfig,

  getCavemanSettings,

  saveCavemanSettings,

  buildDefaultPinnedSkillForNewChat,

  isSkillEnabled,

  listCavemanIntensityOptions,

  type CavemanSkillSettings,

  type SkillConfig,

} from './config';

