import { parsePromptMarkdown } from '../prompts/parse-front-matter';
import { parseExpertMetaFromMarkdown } from './expert-meta-parse';
import type { ExpertAccent, ExpertMeta } from './types';
import { EXPERT_ACCENT_VALUES } from './types';

export interface ParsedExpertFile {
  meta: ExpertMeta;
  fullBody: string;
}

export interface ExpertMarkdownMetaInput {
  id: string;
  label: string;
  version?: string;
  description?: string;
  tagline?: string;
  greeting?: string;
  icon?: string;
  accent?: ExpertAccent;
}

function quoteYaml(value: string): string {
  if (/[:#\n\r]/.test(value) || value.includes('"')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function formatFrontMatter(meta: ExpertMarkdownMetaInput): string {
  const lines = [
    '---',
    `id: ${meta.id}`,
    'kind: expert',
    `label: ${quoteYaml(meta.label)}`,
  ];
  if (meta.version?.trim()) {
    lines.push(`version: ${meta.version.trim()}`);
  }
  if (meta.description?.trim()) {
    lines.push(`description: ${quoteYaml(meta.description.trim())}`);
  }
  if (meta.tagline?.trim()) {
    lines.push(`tagline: ${quoteYaml(meta.tagline.trim())}`);
  }
  if (meta.greeting?.trim()) {
    lines.push(`greeting: ${quoteYaml(meta.greeting.trim())}`);
  }
  if (meta.icon?.trim()) {
    lines.push(`icon: ${quoteYaml(meta.icon.trim())}`);
  }
  if (meta.accent && EXPERT_ACCENT_VALUES.includes(meta.accent)) {
    lines.push(`accent: ${meta.accent}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Complete expert prompt file with front matter. */
export function buildExpertMarkdown(
  meta: ExpertMarkdownMetaInput,
  body: string,
): string {
  const trimmedBody = body.trim();
  const marker = `[[EXPERT:${meta.id}]]`;
  const bodyBlock = trimmedBody.includes(marker)
    ? trimmedBody
    : `${marker}\n\n${trimmedBody}`;
  return `${formatFrontMatter(meta)}\n\n${bodyBlock}\n`;
}

/** Parse the expert prompt and its metadata. */
export function parseExpertFile(
  fullRaw: string,
  relativePath = 'experts/custom/expert.full.md',
): ParsedExpertFile | null {
  const meta = parseExpertMetaFromMarkdown(fullRaw, relativePath);
  if (!meta) return null;

  let fullBody = '';
  try {
    fullBody = parsePromptMarkdown(fullRaw, relativePath).markdownBody.trim();
  } catch {
    return null;
  }
  return { meta, fullBody };
}
