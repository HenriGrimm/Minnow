export const NOTHING_TO_DO: 'NOTHING_TO_DO';
export const GITHUB_REPOSITORY_RE: RegExp;

export type PresetEngine = 'pr-review' | 'github-watch' | 'prompt';
export type PresetGroup = 'github' | 'workspace';
export interface PresetField {
  key: string;
  type: 'toggle' | 'text' | 'select';
  label: string;
  help?: string;
  placeholder?: string;
  options?: { id: string; label: string }[];
}
export interface AutomationPreset {
  id: string;
  name: string;
  group: PresetGroup;
  engine: PresetEngine;
  icon: string;
  summary: string;
  trigger: string;
  can: string[];
  schedule: { kind: 'interval' | 'cron'; value: string };
  modeId: string;
  fields: PresetField[];
}
export interface PrReviewConfig {
  repository: string;
  interval: string;
  claim: boolean;
  skipCommented: boolean;
  skipDrafts: boolean;
  reviewers: string[];
  onPass: 'queue' | 'merge' | 'approve' | 'comment';
  onFail: 'request_changes' | 'comment';
  guidance: string;
}
export const PR_REVIEWERS: readonly { id: string; label: string; brief: string }[];
export const PR_PASS_ACTIONS: readonly { id: PrReviewConfig['onPass']; label: string; detail: string; clause: string }[];
export const PR_INTERVALS: readonly string[];
export const AUTOMATION_PRESETS: readonly AutomationPreset[];
export function getAutomationPreset(id: string): AutomationPreset | null;
export function defaultPresetConfig(id: string): Record<string, any>;
export function normalizePresetConfig(id: string, raw: unknown): Record<string, any>;
export function presetCapabilities(id: string, config?: Record<string, any>): string[];
export function reviewerLabels(ids: string[]): string[];
export function describePrReviewSteps(config: Record<string, any>): { title: string; detail: string }[];
export function buildPresetPrompt(id: string, config: Record<string, any>): string;
