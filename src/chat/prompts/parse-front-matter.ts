import type { PromptFrontMatter, PromptKind, PromptPartId } from './types';

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse a single front matter line into key/value. */
function parseScalarLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return null;
  const key = trimmed.slice(0, colon).trim();
  let value = trimmed.slice(colon + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/** Parse simple YAML list items (- item). */
function parseListBlock(lines: string[], startIndex: number): { values: string[]; next: number } {
  const values: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (!line.trimStart().startsWith('- ')) break;
    values.push(line.trimStart().slice(2).trim());
    i += 1;
  }
  return { values, next: i };
}

/** Parse multiline literal block (key: |). */
function parseMultilineBlock(
  lines: string[],
  startIndex: number,
): { value: string; next: number } {
  const parts: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break;
    parts.push(line.replace(/^\s{2}/, ''));
    i += 1;
  }
  return { value: parts.join('\n').trimEnd(), next: i };
}

/** Map kind string to composer part id. */
export function partIdFromKind(kind: PromptKind, explicit?: string): PromptPartId {
  if (explicit && isPromptPartId(explicit)) return explicit;
  if (kind === 'tool-usage') return 'tool-usage';
  if (kind === 'work-agent') return 'work-agent';
  if (kind === 'base') return 'base';
  if (kind === 'mode') return 'mode';
  if (kind === 'expert') return 'expert';
  if (kind === 'info') return 'info';
  return 'base';
}

function isPromptPartId(value: string): value is PromptPartId {
  return [
    'base',
    'mode',
    'expert',
    'tool-usage',
    'info',
    'memory',
    'code-map',
    'context-documents',
    'work-agent',
    'skill',
  ].includes(value);
}

function isPromptKind(value: string): value is PromptKind {
  return ['base', 'mode', 'expert', 'tool-usage', 'info', 'work-agent', 'title'].includes(
    value,
  );
}

/**
 * Split markdown into front matter map and markdown body.
 */
export function parsePromptMarkdown(
  raw: string,
  relativePath: string,
): { frontMatter: PromptFrontMatter; markdownBody: string } {
  const match = raw.match(FRONT_MATTER_RE);
  const yamlText = match?.[1] ?? '';
  const markdownBody = (match?.[2] ?? raw).trim();

  const record: Record<string, unknown> = {};
  const lines = yamlText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.endsWith(': |')) {
      const key = trimmed.slice(0, -2).trim();
      const block = parseMultilineBlock(lines, i + 1);
      record[key] = block.value;
      i = block.next - 1;
      continue;
    }

    if (trimmed.endsWith(':') && !trimmed.includes(': ')) {
      const key = trimmed.slice(0, -1).trim();
      const list = parseListBlock(lines, i + 1);
      if (list.values.length > 0) {
        record[key] = list.values;
        i = list.next - 1;
      }
      continue;
    }

    const scalar = parseScalarLine(line);
    if (!scalar) continue;

    if (scalar.value === '' && lines[i + 1]?.trimStart().startsWith('- ')) {
      const list = parseListBlock(lines, i + 1);
      record[scalar.key] = list.values;
      i = list.next - 1;
      continue;
    }

    if (scalar.key === 'version') {
      record[scalar.key] = Number.parseInt(scalar.value, 10) || 1;
    } else {
      record[scalar.key] = scalar.value;
    }
  }

  const id = String(record.id ?? '').trim();
  const kindRaw = String(record.kind ?? 'base').trim();
  const kind: PromptKind = isPromptKind(kindRaw) ? kindRaw : 'base';

  if (!id) {
    throw new Error(`Prompt file missing id: ${relativePath}`);
  }

  const frontMatter: PromptFrontMatter = {
    id,
    kind,
    label: String(record.label ?? id),
    version: typeof record.version === 'number' ? record.version : 1,
    description: record.description ? String(record.description) : undefined,
    part: record.part
      ? partIdFromKind(kind, String(record.part))
      : partIdFromKind(kind),
    modeBindings: Array.isArray(record.modeBindings)
      ? record.modeBindings.map(String)
      : undefined,
    expertTriggers: Array.isArray(record.expertTriggers)
      ? record.expertTriggers.map(String)
      : undefined,
    toolPolicy: record.toolPolicy ? String(record.toolPolicy) : undefined,
    body: record.body ? String(record.body) : undefined,
    fullBody: record.fullBody ? String(record.fullBody) : undefined,
  };

  return { frontMatter, markdownBody };
}
