/**
 * Server-side prompt markdown parser (mirrors src/chat/prompts/parse-front-matter.ts).
 */

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseScalarLine(line) {
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

function parseListBlock(lines, startIndex) {
  const values = [];
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

function parseMultilineBlock(lines, startIndex) {
  const parts = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break;
    parts.push(line.replace(/^\s{2}/, ''));
    i += 1;
  }
  return { value: parts.join('\n').trimEnd(), next: i };
}

function partIdFromKind(kind, explicit) {
  if (explicit) return explicit;
  if (kind === 'tool-usage') return 'tool-usage';
  if (kind === 'work-agent') return 'work-agent';
  return kind;
}

function inferKindFromPath(relativePath) {
  const norm = relativePath.replace(/\\/g, '/');
  const match = norm.match(
    /(?:^|\/)(base|modes|experts|tool-usage|info|work-agents|titles)\//,
  );
  if (!match) return 'base';
  const folder = match[1];
  if (folder === 'modes') return 'mode';
  if (folder === 'experts') return 'expert';
  if (folder === 'work-agents') return 'work-agent';
  if (folder === 'titles') return 'title';
  return folder;
}

/**
 * @param {string} raw
 * @param {string} relativePath
 */
export function parsePromptMarkdown(raw, relativePath) {
  const match = raw.match(FRONT_MATTER_RE);
  const yamlText = match?.[1] ?? '';
  const markdownBody = (match?.[2] ?? raw).trim();

  const record = {};
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
  const kind = String(record.kind ?? inferKindFromPath(relativePath));
  if (!id) {
    throw new Error(`Prompt file missing id: ${relativePath}`);
  }

  const body =
    record.fullBody ?? record.body ?? markdownBody;

  return {
    id,
    kind,
    part: partIdFromKind(kind, record.part),
    label: String(record.label ?? id),
    version: typeof record.version === 'number' ? record.version : 1,
    description: record.description ? String(record.description) : undefined,
    body: String(body),
    relativePath,
  };
}
