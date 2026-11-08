/**
 * Minnow setup profile bundle types (~/.minnow/profiles/<id>.json).
 */

import type { PromptConfigPartSettings } from '../chat/prompts/types';
import type { PlanGranularity, PromptProfileName } from './prompt-meta';

export const PROFILE_SCHEMA_VERSION = 1;

export type ProfilePromptSource = 'embedded' | 'prompt-config' | 'full' | 'lite';

export interface ProfilePromptSection {
  promptProfile: PromptProfileName;
  activePromptConfigId: string | null;
  activeInfoPresetId: string;
  planGranularity?: PlanGranularity;
  source?: ProfilePromptSource;
  parts?: Record<string, PromptConfigPartSettings>;
}

export interface ProfileAgentsSection {
  workAgents?: Record<string, Record<string, unknown>>;
  subAgents?: Record<string, unknown>;
}

export interface ProfileToolsSection {
  keys?: Record<string, string>;
}

export interface ProfileRulesSection {
  enabled?: boolean;
  text?: string;
}

export interface ProfileSkillsSection {
  enabled?: Record<string, boolean>;
}

export interface MinnowProfileBundle {
  id: string;
  label: string;
  schemaVersion: number;
  meta?: {
    description?: string;
    createdAt?: string;
    updatedAt?: string;
    minnowVersion?: string;
  };
  prompt: ProfilePromptSection;
  agents: ProfileAgentsSection;
  tools: ProfileToolsSection;
  rules?: ProfileRulesSection;
  skills?: ProfileSkillsSection;
}

export interface ProfileListItem {
  id: string;
  label: string;
  updatedAt?: string;
}

export interface ActivateProfileResult {
  ok: boolean;
  appliedAt: string;
  previousSnapshotId?: string;
  invalidate?: string[];
}
