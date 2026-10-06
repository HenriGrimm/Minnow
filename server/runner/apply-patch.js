const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/**
 * Parse the line-oriented apply_patch format without accessing the filesystem.
 * The envelope is forgiving about what models get wrong in practice — a
 * missing `*** Begin Patch` before a file header, a missing `*** End Patch`, or
 * a stray `*** End of File` after it — because none of those make the edit
 * itself ambiguous. Hunk content stays strict.
 */
export function parsePatch(patch) {
  if (typeof patch !== 'string') throw new Error('patch must be a string');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (lines[0] === '*** Begin Patch') lines.shift();
  else if (!FILE_HEADER.test(lines[0] ?? '')) throw new Error('Expected *** Begin Patch and *** End Patch');
  while (lines.at(-1) === '*** End of File' && lines.at(-2) === '*** End Patch') lines.pop();
  if (lines.at(-1) === '*** End Patch') lines.pop();
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    const header = FILE_HEADER.exec(lines[i++]);
    if (!header) throw new Error(`Expected Add, Update, or Delete File header, got: ${lines[i - 1]}`);
    const file = { kind: header[1], path: header[2], move: undefined, hunks: [], content: '' };
    if (file.kind === 'Add') {
      const added = [];
      while (i < lines.length && lines[i].startsWith('+')) added.push(lines[i++].slice(1));
      file.content = added.length ? added.join('\n') + '\n' : '';
    } else if (file.kind === 'Update') {
      if (lines[i]?.startsWith('*** Move to: ')) file.move = lines[i++].slice(13);
      while (i < lines.length && (lines[i] === '@@' || lines[i].startsWith('@@ '))) {
        const anchor = lines[i++].slice(3);
        const before = [], after = [], ops = [];
        while (i < lines.length && isHunkLine(lines, i)) {
          // A bare empty line is a blank context line whose leading space
          // was stripped (editors and models both do this).
          const line = lines[i++] || ' ';
          if (line[0] !== '+') before.push(line.slice(1));
          if (line[0] !== '-') after.push(line.slice(1));
          ops.push(line[0]);
        }
        const eof = lines[i] === '*** End of File';
        if (eof) i++;
        if (!before.length && !after.length) throw new Error('Empty patch hunk');
        file.hunks.push({ anchor, before, after, eof, ops });
      }
      if (!file.hunks.length) throw new Error('Update requires at least one @@ hunk');
    }
    if (!file.path.trim() || (file.move !== undefined && !file.move.trim())) throw new Error('Empty patch path');
    files.push(file);
  }
  if (!files.length) throw new Error('Patch contains no files');
  return files;
}

/** An empty line only counts as context when more hunk lines follow it. */
function isHunkLine(lines, i) {
  if (/^[ +\-]/.test(lines[i])) return true;
  if (lines[i] !== '') return false;
  let next = i + 1;
  while (next < lines.length && lines[next] === '') next++;
  return next < lines.length && /^[ +\-]/.test(lines[next]);
}

/**
 * Context comparisons, strictest first. A looser pass runs only when every
 * stricter one found nothing, and any pass must find exactly one match.
 */
const MATCHERS = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
];

/**
 * Context matching: exact, then whitespace-tolerant. An ambiguous hunk needs
 * more context, never a guess. Errors name the hunk that failed.
 * @param {string} text
 * @param {Array<{ anchor: string, before: string[], after: string[], eof: boolean }>} hunks
 * @param {string} [label] file path, for error messages
 */
export function patchText(text, hunks, label) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith('\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (trailing || text === '') lines.pop();
  let cursor = 0;
  hunks.forEach((hunk, index) => {
    const where = () => `${label ? `${label}, ` : ''}hunk ${index + 1} of ${hunks.length}`;
    if (hunk.anchor) {
      const at = findAnchor(lines, hunk.anchor, cursor);
      if (at < 0) throw new Error(`Patch anchor not found (${where()}): ${hunk.anchor}`);
      cursor = at + 1;
    }
    let matches = hunk.before.length ? [] : [lines.length];
    for (const same of hunk.before.length ? MATCHERS : []) {
      for (let at = cursor; at <= lines.length - hunk.before.length; at++) {
        if (hunk.eof && at + hunk.before.length !== lines.length) continue;
        if (hunk.before.every((line, n) => same(lines[at + n], line))) matches.push(at);
      }
      if (matches.length) break;
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous patch context; include more surrounding lines (${where()}, ${matches.length} matches)`);
    }
    if (!matches.length) throw new Error(contextNotFound(lines, hunk, cursor, where()));
    const at = matches[0];
    const replacement = replacementFor(hunk, lines.slice(at, at + hunk.before.length));
    lines.splice(at, hunk.before.length, ...replacement);
    cursor = at + replacement.length;
  });
  return lines.join(eol) + (lines.length && (trailing || text === '') ? eol : '');
}

/**
 * The hunk's new lines, with context lines taken from the file rather than
 * the patch: a whitespace-tolerant match must not rewrite the lines it only
 * used to find its place.
 */
function replacementFor(hunk, matched) {
  if (!Array.isArray(hunk.ops)) return hunk.after;
  const out = [];
  let b = 0, a = 0;
  for (const op of hunk.ops) {
    if (op === '+') out.push(hunk.after[a++]);
    else if (op === '-') b++;
    else { out.push(matched[b++]); a++; }
  }
  return out;
}

function findAnchor(lines, anchor, cursor) {
  for (const same of MATCHERS) {
    const at = lines.findIndex((line, n) => n >= cursor && same(line, anchor));
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * Say which context line diverged and what the file has there, so the next
 * attempt re-reads that region instead of guessing again.
 */
function contextNotFound(lines, hunk, cursor, where) {
  let best = { at: -1, matched: 0 };
  const loose = MATCHERS.at(-1);
  for (let at = cursor; at < lines.length; at++) {
    let matched = 0;
    while (matched < hunk.before.length && at + matched < lines.length && loose(lines[at + matched], hunk.before[matched])) matched++;
    if (matched > best.matched) best = { at, matched };
  }
  const first = hunk.before.find((line) => line.trim()) ?? hunk.before[0] ?? '';
  let detail = `first context line: ${JSON.stringify(first)}`;
  if (best.matched > 0 && best.matched < hunk.before.length) {
    const line = best.at + best.matched;
    detail = `context matches from line ${best.at + 1} but diverges at line ${line + 1}: expected ${JSON.stringify(hunk.before[best.matched])}, file has ${JSON.stringify(lines[line] ?? '<end of file>')}`;
  }
  return `Patch context not found (${where}; ${detail}). Re-read the file before retrying.`;
}
