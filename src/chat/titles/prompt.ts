import { loadPromptById } from '../prompts/prompt-loader';
import type { ApiMessage } from '../../types';

const FALLBACK_SYSTEM = `You generate a short chat title (3–8 words) for a sidebar.
Output only the title: no quotes, no markdown, no "Title:" prefix, max ~40 characters.
Use the same language as the user when it is clearly not English.`;

/** Replace {{userMessage}} in the title prompt template. */
function applyUserMessageToken(template: string, seed: string): string {
  return template.replace(/\{\{userMessage\}\}/g, seed);
}

export function buildTitleMessages(seed: string): ApiMessage[] {
  const trimmedSeed = seed.trim() || 'Attachment';
  const loaded = loadPromptById('title', 'default');
  const systemBody = applyUserMessageToken(
    loaded?.body?.trim() || FALLBACK_SYSTEM,
    trimmedSeed,
  );

  return [
    { role: 'system', content: systemBody },
    { role: 'user', content: trimmedSeed },
  ];
}
