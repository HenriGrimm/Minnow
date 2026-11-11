import {
  deleteExpertEntity,
  fetchPromptFileRaw,
  savePromptFileOverride,
} from '../prompts/prompt-file-api';
import { buildExpertMarkdown, parseExpertFile } from './expert-markdown';
import { isUserOwnedExpert } from './expert-ownership';
import {
  getBuiltinExpertIds,
  getExpert,
  syncExpertRegistryFromServer,
} from './registry';
import type { ExpertAccent, ExpertMeta } from './types';

export interface SaveUserExpertInput {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  accent?: ExpertAccent;
  tagline?: string;
  greeting?: string;
  fullBody: string;
}

/** Persist edited metadata and prompt for a user-owned expert. */
export async function saveUserExpert(input: SaveUserExpertInput): Promise<void> {
  const record = getExpert(input.id);
  if (!isUserOwnedExpert(record, getBuiltinExpertIds())) {
    throw new Error('This expert cannot be edited here.');
  }

  const meta: ExpertMeta = {
    id: input.id,
    label: input.label.trim() || input.id,
    kind: 'expert',
    description: input.description?.trim() || undefined,
    tagline: input.tagline?.trim() || undefined,
    greeting: input.greeting?.trim() || undefined,
    icon: input.icon?.trim() || undefined,
    accent: input.accent,
  };

  const markdownMeta = {
    id: meta.id,
    label: meta.label,
    description: meta.description,
    tagline: meta.tagline,
    greeting: meta.greeting,
    icon: meta.icon,
    accent: meta.accent,
  };

  const fullMarkdown = buildExpertMarkdown(markdownMeta, input.fullBody);

  const fullSaved = await savePromptFileOverride('experts', input.id, fullMarkdown);
  if (!fullSaved) {
    throw new Error('Could not save expert. Open or restart Minnow.');
  }

  await syncExpertRegistryFromServer();
}

/** Remove a user-owned expert directory from ~/.minnow. */
export async function deleteUserExpert(id: string): Promise<void> {
  const record = getExpert(id);
  if (!isUserOwnedExpert(record, getBuiltinExpertIds())) {
    throw new Error('This expert cannot be deleted.');
  }

  const removed = await deleteExpertEntity(id);
  if (!removed) {
    throw new Error('Could not delete expert files.');
  }

  await syncExpertRegistryFromServer();
}

/** Load edit form fields for a user-owned expert. */
export async function loadUserExpertForEdit(id: string): Promise<{
  meta: ExpertMeta;
  fullBody: string;
} | null> {
  const record = getExpert(id);
  if (!isUserOwnedExpert(record, getBuiltinExpertIds())) return null;

  const fullRaw = await fetchPromptFileRaw('experts', id);
  if (!fullRaw?.content) return null;

  const parsed = parseExpertFile(fullRaw.content);
  if (!parsed) return null;

  return {
    meta: parsed.meta,
    fullBody: parsed.fullBody,
  };
}
