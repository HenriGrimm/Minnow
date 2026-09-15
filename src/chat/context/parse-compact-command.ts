export interface ParsedCompactCommand {
  /** Text after the command: what the summary should keep (goes under [User notes]). */
  notes: string | null;
}

const COMPACT_RE = /^\s*\/(?:compact|compress|summarize)(?:\s+([\s\S]*))?$/i;

/** `/compact [focus]`, with `/compress` and `/summarize` as aliases. */
export function parseCompactSlashInput(rawText: string): ParsedCompactCommand | null {
  const match = COMPACT_RE.exec(rawText);
  if (!match) return null;
  const notes = match[1]?.trim() ?? '';
  return { notes: notes || null };
}
