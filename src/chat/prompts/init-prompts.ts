import { BUILTIN_RAW } from './builtin-globs';
import { initBuiltinPromptRegistry, setUserPromptRegistry } from './prompt-loader';
import type { ParsedPrompt } from './types';

/** Fetch user prompt overrides when config server is up. */
export async function initPromptSystem(): Promise<void> {
  initBuiltinPromptRegistry(BUILTIN_RAW);

  try {
    const res = await fetch('/api/prompts/registry', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { prompts?: ParsedPrompt[] };
    const userOnly = (body.prompts ?? []).filter((p) => p.source === 'user');
    if (userOnly.length > 0) {
      setUserPromptRegistry(userOnly);
    }
  } catch {}
}
