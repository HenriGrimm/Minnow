import { extractMessageText } from '../../api/chat';
import { loadPromptById } from '../prompts/prompt-loader';
import { savePromptFileOverride } from '../prompts/prompt-file-api';
import { createTitleProviderPort } from '../titles/provider-port';
import { getActiveChat } from '../../state/sessions';
import { parseExpertMetaFromMarkdown } from './expert-meta-parse';
import { parseExpertFile } from './expert-markdown';
import {
  dedupeExpertId,
  isValidExpertId,
  slugifyExpertLabel,
} from './create-expert-slug';
import { listExperts, syncExpertRegistryFromServer } from './registry';
import type { ExpertAccent } from './types';
import { EXPERT_ACCENT_VALUES } from './types';

export interface CreateExpertResult {
  expertId: string;
  label: string;
}

export interface CreateExpertOptions {
  description: string;
  signal?: AbortSignal;
}

interface LlmExpertPayload {
  id?: string;
  label?: string;
  description?: string;
  tagline?: string;
  greeting?: string;
  icon?: string;
  accent?: string;
  fullMarkdown?: string;
}

const FALLBACK_CREATOR_SYSTEM = `You create custom Experts for Minnow. Output only JSON with keys: id, label, description, tagline, greeting, icon, accent, fullMarkdown. No version or routing fields (keywords, regex, classifierHint, priority, default).`;

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function parseAccent(value: unknown): ExpertAccent | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return EXPERT_ACCENT_VALUES.includes(normalized as ExpertAccent)
    ? (normalized as ExpertAccent)
    : undefined;
}

function validateGeneratedExpert(
  payload: LlmExpertPayload,
  expectedId: string,
): { full: string; label: string } | string {
  const full = typeof payload.fullMarkdown === 'string' ? payload.fullMarkdown.trim() : '';
  if (!full) return 'Missing fullMarkdown';

  const fullMeta = parseExpertMetaFromMarkdown(full, `experts/${expectedId}/expert.full.md`);
  if (!fullMeta) return 'Invalid expert front matter';
  if (fullMeta.id !== expectedId) {
    return 'Expert id mismatch in generated files';
  }

  const parsed = parseExpertFile(full);
  if (!parsed?.fullBody?.trim()) return 'Empty expert body';

  const label = payload.label?.trim() || fullMeta.label;
  return { full, label };
}

/** Resolve model for a non-streaming sidecar completion. */
async function resolveSidecarModel(): Promise<{ modelId: string; providerId?: string }> {
  const chat = getActiveChat();
  const modelId = chat?.modelId?.trim();
  if (!modelId) {
    throw new Error('Select a model before creating an expert.');
  }
  return { modelId, providerId: chat?.providerId?.trim() || undefined };
}

/**
 * Call the LLM to generate expert files, save under ~/.minnow, and refresh registry.
 */
export async function createExpertFromDescription(
  options: CreateExpertOptions,
): Promise<CreateExpertResult> {
  const userDescription = options.description.trim();
  if (!userDescription) {
    throw new Error('Describe the expert you want to create.');
  }

  const { modelId, providerId } = await resolveSidecarModel();
  const loaded = loadPromptById('info', 'expert-creator');
  const systemBody = loaded?.body?.trim() || FALLBACK_CREATOR_SYSTEM;

  const port = createTitleProviderPort(providerId);
  const chunk = await port.complete(
    {
      model: modelId,
      messages: [
        { role: 'system', content: systemBody },
        { role: 'user', content: userDescription },
      ],
      temperature: 0.4,
      max_tokens: 8192,
    },
    options.signal ?? new AbortController().signal,
  );

  const rawText = extractMessageText(chunk.choices?.[0]?.message).trim();
  if (!rawText) {
    throw new Error('The model returned an empty response.');
  }

  let payload: LlmExpertPayload;
  try {
    payload = JSON.parse(stripJsonFences(rawText)) as LlmExpertPayload;
  } catch {
    throw new Error('Could not parse expert JSON from the model.');
  }

  const existingIds = new Set(listExperts().map((e) => e.meta.id));
  const baseSlug = slugifyExpertLabel(payload.label?.trim() || userDescription.slice(0, 40));
  const proposedId =
    typeof payload.id === 'string' && isValidExpertId(payload.id.trim())
      ? payload.id.trim()
      : baseSlug;
  const expertId = dedupeExpertId(proposedId, existingIds);

  const validated = validateGeneratedExpert(payload, expertId);
  if (typeof validated === 'string') {
    throw new Error(validated);
  }

  const fullSaved = await savePromptFileOverride('experts', expertId, validated.full);
  if (!fullSaved) {
    throw new Error('Could not save expert files. Open or restart Minnow.');
  }

  await syncExpertRegistryFromServer();

  return { expertId, label: validated.label };
}
