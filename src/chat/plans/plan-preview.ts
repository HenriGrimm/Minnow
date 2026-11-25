import { readWorkspaceTextFile } from '../../attachments/workspace-text-read.ts';
import { setAssistantBubbleContent } from '../../markdown/renderer.ts';

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** One todo entry from plan YAML front matter. */
export interface PlanPreviewTodo {
  id: string;
  content: string;
  status?: string;
}

/** Parsed plan front matter (body markdown is passed separately to the DOM builder). */
export interface PlanPreviewParsed {
  name?: string;
  overview?: string;
  todos: PlanPreviewTodo[];
}

export interface BuildPlanPreviewDomOptions {
  modeId?: string;
  /** Shown when the artifact file is missing or has no displayable body. */
  emptyLabel?: string;
}

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

function parseTodosBlock(lines: string[], startIndex: number): { todos: PlanPreviewTodo[]; next: number } {
  const todos: PlanPreviewTodo[] = [];
  let current: PlanPreviewTodo | null = null;
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const listItem = trimmed.match(/^-\s+(.+)$/);
    if (listItem) {
      const rest = listItem[1] ?? '';
      const inlineId = rest.match(/^id:\s*(.+)$/i);
      if (inlineId) {
        if (current?.id) todos.push(current);
        current = { id: inlineId[1]!.trim(), content: '' };
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    const field = parseScalarLine(line.replace(/^\s{2,}/, ''));
    if (!field) break;

    if (field.key === 'id') {
      if (current?.id) todos.push(current);
      current = { id: field.value, content: '' };
      i += 1;
      continue;
    }

    if (!current) {
      i += 1;
      continue;
    }

    if (field.key === 'content') {
      current.content = field.value;
    } else if (field.key === 'status') {
      current.status = field.value;
    }
    i += 1;
  }

  if (current?.id) todos.push(current);
  return { todos, next: i };
}

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse YAML front matter between `---` fences (name, overview, todos with id/content/status).
 */
export function parsePlanFrontMatter(markdown: string): PlanPreviewParsed {
  const match = markdown.match(FRONT_MATTER_RE);
  const yamlText = match?.[1] ?? '';
  const lines = yamlText.split(/\r?\n/);

  let name: string | undefined;
  let overview: string | undefined;
  let todos: PlanPreviewTodo[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === 'todos:' || trimmed.startsWith('todos:')) {
      const block = parseTodosBlock(lines, i + 1);
      todos = block.todos;
      i = block.next - 1;
      continue;
    }

    const scalar = parseScalarLine(line);
    if (!scalar) continue;

    if (scalar.key === 'name') {
      name = scalar.value;
    } else if (scalar.key === 'overview') {
      overview = scalar.value;
    }
  }

  return { name, overview, todos };
}

/** Split plan markdown into front matter fields and body (after closing `---`). */
export function splitPlanMarkdown(markdown: string): {
  parsed: PlanPreviewParsed;
  bodyMarkdown: string;
} {
  const match = markdown.match(FRONT_MATTER_RE);
  const bodyMarkdown = (match?.[2] ?? markdown).trim();
  return { parsed: parsePlanFrontMatter(markdown), bodyMarkdown };
}

export function planMarkdownForDisplay(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';

  const { parsed, bodyMarkdown } = splitPlanMarkdown(trimmed);
  const body = bodyMarkdown.trim();
  if (body) return body;

  const parts: string[] = [];
  if (parsed.name?.trim()) {
    parts.push(`# ${parsed.name.trim()}`);
  }
  if (parsed.overview?.trim()) {
    parts.push(parsed.overview.trim());
  }
  if (parsed.todos.length > 0) {
    parts.push('## Plan tasks');
    for (const todo of parsed.todos) {
      const checked = todo.status === 'completed' ? 'x' : ' ';
      const label = todo.content.trim() || todo.id;
      parts.push(`- [${checked}] ${label}`);
    }
  }
  return parts.join('\n\n');
}

/** Placeholder class when a plan file has no readable body. */
export const PLAN_PREVIEW_EMPTY_CLASS = 'plan-preview__empty';

// ── Read ─────────────────────────────────────────────────────────────────────

export async function readPlanArtifactMarkdown(
  path: string,
  options?: { cacheBust?: number },
): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed) return '';
  try {
    return await readWorkspaceTextFile(trimmed, undefined, options?.cacheBust);
  } catch {
    return '';
  }
}

// ── Mount ────────────────────────────────────────────────────────────────────

/**
 * Paint plan markdown into a scroll host (full GFM body via assistant markdown renderer).
 */
export function mountPlanPreviewContent(
  container: HTMLElement,
  markdown: string,
  options: BuildPlanPreviewDomOptions = {},
): void {
  container.replaceChildren();
  const displayMarkdown = planMarkdownForDisplay(markdown);
  if (!displayMarkdown) {
    const empty = document.createElement('p');
    empty.className = PLAN_PREVIEW_EMPTY_CLASS;
    empty.textContent = options.emptyLabel?.trim() || '(empty plan file)';
    container.appendChild(empty);
    return;
  }
  container.appendChild(buildPlanPreviewDom(displayMarkdown, options));
}

/** Build preview panel: single markdown column (same rendering as assistant chat bubbles). */
export function buildPlanPreviewDom(
  displayMarkdown: string,
  options: BuildPlanPreviewDomOptions = {},
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'plan-preview';

  const body = document.createElement('div');
  body.className = 'plan-preview__body msg-bubble msg-bubble--md';
  setAssistantBubbleContent(body, displayMarkdown, { modeId: options.modeId });
  root.appendChild(body);

  return root;
}
