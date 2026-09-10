import type { RunState } from './types';
export function artifactPaths(state: RunState): { specPath: string; researchPath: string; planPath: string };
export function checkStageArtifact(state: RunState, role: string): Promise<{ errors?: string[]; artifact?: { path: string; sha256: string; involvesUi?: boolean } }>;
export function ensurePromptSpec(state: RunState): Promise<{ path: string }>;
export function confirmSpecIdentity(state: RunState): Promise<Record<string, unknown>[]>;
