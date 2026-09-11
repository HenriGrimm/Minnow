import type { RunState } from './types';

export const PLANS_DIR: string;
export const REFERENCES_DIR: string;

export function specPathFor(slug: string): string;
export function researchPathFor(slug: string): string;
export function planPathFor(slug: string): string;
export function artifactPaths(state: RunState): { specPath: string; researchPath: string; planPath: string };
export function resolveArtifactPath(workspacePath: string, relative: string): string;
export function normalizeRelativePath(raw: unknown): string;
export function readArtifact(workspacePath: string, relative: string): Promise<string | null>;
export function writeArtifact(workspacePath: string, relative: string, content: string): Promise<void>;
export function artifactExists(workspacePath: string, relative: string): Promise<boolean>;
export function contentSha256(markdown: string): string;
export function titleOf(markdown: string): string;
export function mentionsUi(markdown: string): boolean;

export interface ArtifactCheck {
  ok: boolean;
  errors: string[];
  title: string;
  sha256: string | null;
  bytes: number;
  involvesUi: boolean;
}

export function checkSpec(markdown: string | null, relative: string): ArtifactCheck;
export function checkPlan(
  markdown: string | null,
  relative: string,
  options?: { previousSha256?: string | null; requireChange?: boolean },
): ArtifactCheck & { tasks: number };

export function slugFromTitle(title: string): string;
export function slugFromPrompt(prompt: string, max?: number): string;
export function chooseSlug(state: RunState, title: string): Promise<string>;
export function moveArtifact(workspacePath: string, from: string, to: string): Promise<void>;
