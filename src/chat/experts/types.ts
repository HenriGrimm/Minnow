import type { ModeId } from '../modes/types';

export type ExpertAccent =
  | 'sage'
  | 'amber'
  | 'cyan'
  | 'coral'
  | 'violet'
  | 'rose';

export const EXPERT_ACCENT_VALUES: readonly ExpertAccent[] = [
  'sage',
  'amber',
  'cyan',
  'coral',
  'violet',
  'rose',
] as const;

export interface ExpertMeta {
  id: string;
  label: string;
  kind: 'expert';
  description?: string;
  icon?: string;
  accent?: ExpertAccent;
  tagline?: string;
  greeting?: string;
}

export interface ExpertRecord {
  meta: ExpertMeta;
  fullBody: string;
  source: 'builtin' | 'user';
}

/** User-controlled runtime defaults per expert (config.json → experts.profiles). */
export interface ExpertRuntimeProfile {
  providerId?: string;
  modelId?: string;
  modeId?: ModeId;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  /** When false, expert long-term memory is disabled for new chats. */
  memoryEnabled?: boolean;
}

/** Effective runtime captured when an expert chat is created. */
export interface ExpertRuntimeSnapshot {
  providerId?: string;
  modelId: string;
  modeId: ModeId;
  /** Null means inherit all mode-allowed tools; otherwise intersect with allowlist. */
  toolAllowlist: string[] | null;
  toolDenylist: string[];
  enabledToolNames: string[];
  memoryEnabled: boolean;
  warnings: string[];
  profileSource: 'inherit' | 'override';
}

export interface ExpertsConfig {
  enabled: boolean;
  profiles: Record<string, ExpertRuntimeProfile>;
}

export const DEFAULT_EXPERTS_CONFIG: ExpertsConfig = {
  enabled: true,
  profiles: {},
};

/** @deprecated Legacy picker — migrated to chat.expertId; read-only for hydration. */
export type ExpertSelectionMode = 'auto' | 'manual';

/** @deprecated Legacy picker — migrated to chat.expertId; read-only for hydration. */
export interface ExpertSelection {
  mode: ExpertSelectionMode;
  expertId: string | null;
}
