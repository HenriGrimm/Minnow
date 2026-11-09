import { bumpPromptConfigEpoch } from '../outbound-estimate-epochs';
import { setUserPromptRegistry } from './prompt-loader';
import type { ParsedPrompt } from './types';

/** Re-read user overrides so the next send composes the edited prompt. */
export async function refreshUserPromptRegistry(): Promise<void> {
  try {
    const res = await fetch('/api/prompts/registry', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { prompts?: ParsedPrompt[] };
    setUserPromptRegistry((body.prompts ?? []).filter((p) => p.source === 'user'));
  } catch {
    /* offline: keep the current registry */
  }
}

export type PromptFileFamily = 'modes' | 'experts' | 'sub-agents' | 'base' | 'tool-usage' | 'info';
export type PromptFileProfile = 'full' | 'lite';

export interface PromptFileResponse {
  content: string;
  source: 'builtin' | 'override';
}

export async function fetchPromptFile(
  family: PromptFileFamily,
  entityId: string,
  profile: PromptFileProfile = 'full',
): Promise<PromptFileResponse | null> {
  try {
    const res = await fetch(
      `/api/prompts/${family}/${encodeURIComponent(entityId)}/prompt?profile=${profile}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as PromptFileResponse;
  } catch {
    return null;
  }
}

/** Shipped repo prompt only (ignores ~/.minnow file overrides). */
export async function fetchPromptBuiltinBaseline(
  family: PromptFileFamily,
  entityId: string,
  profile: PromptFileProfile = 'full',
): Promise<PromptFileResponse | null> {
  try {
    const res = await fetch(
      `/api/prompts/${family}/${encodeURIComponent(entityId)}/prompt?profile=${profile}&baseline=builtin`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as PromptFileResponse;
  } catch {
    return null;
  }
}

export async function savePromptFileOverride(
  family: PromptFileFamily,
  entityId: string,
  profile: PromptFileProfile,
  content: string,
): Promise<PromptFileResponse | null> {
  try {
    const res = await fetch(
      `/api/prompts/${family}/${encodeURIComponent(entityId)}/prompt?profile=${profile}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, content }),
      },
    );
    if (!res.ok) return null;
    bumpPromptConfigEpoch();
    void refreshUserPromptRegistry();
    return (await res.json()) as PromptFileResponse;
  } catch {
    return null;
  }
}

export async function resetPromptFileOverride(
  family: PromptFileFamily,
  entityId: string,
  profile: PromptFileProfile,
): Promise<PromptFileResponse | null> {
  try {
    const res = await fetch(
      `/api/prompts/${family}/${encodeURIComponent(entityId)}/prompt?profile=${profile}`,
      { method: 'DELETE' },
    );
    if (!res.ok) return null;
    bumpPromptConfigEpoch();
    void refreshUserPromptRegistry();
    return (await res.json()) as PromptFileResponse;
  } catch {
    return null;
  }
}

/** Full file bytes including YAML front matter (for expert registry sync / edit). */
export async function fetchPromptFileRaw(
  family: PromptFileFamily,
  entityId: string,
  profile: PromptFileProfile = 'full',
): Promise<PromptFileResponse | null> {
  try {
    const res = await fetch(
      `/api/prompts/${family}/${encodeURIComponent(entityId)}/prompt?profile=${profile}&raw=1`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as PromptFileResponse;
  } catch {
    return null;
  }
}

/** Delete a user expert folder under ~/.minnow/prompts/experts/. */
export async function deleteExpertEntity(entityId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/prompts/experts/${encodeURIComponent(entityId)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}
