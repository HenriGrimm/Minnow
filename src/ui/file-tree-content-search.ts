export interface FileContentMatch {
  path: string;
  line: number;
  snippet: string;
}

/** The grep tool returns `path:line:text`; keep the first hit for each file. */
export function parseFileContentMatches(output: string): FileContentMatch[] {
  const matches: FileContentMatch[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (!match) continue;
    const path = match[1]!.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!path || seen.has(path)) continue;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    seen.add(path);
    matches.push({ path, line, snippet: match[3]!.trim().slice(0, 180) });
  }
  return matches;
}
