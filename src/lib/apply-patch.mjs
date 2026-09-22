/** Parse the line-oriented apply_patch format without accessing the filesystem. */
export function parsePatch(patch) {
  if (typeof patch !== 'string') throw new Error('patch must be a string');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new Error('Expected *** Begin Patch and *** End Patch');
  }
  const files = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
    if (!header) throw new Error('Expected Add, Update, or Delete File header');
    const file = { kind: header[1], path: header[2], move: undefined, hunks: [], content: '' };
    if (file.kind === 'Add') {
      const added = [];
      while (i < lines.length && lines[i].startsWith('+')) added.push(lines[i++].slice(1));
      file.content = added.length ? added.join('\n') + '\n' : '';
    } else if (file.kind === 'Update') {
      if (lines[i]?.startsWith('*** Move to: ')) file.move = lines[i++].slice(13);
      while (i < lines.length && (lines[i] === '@@' || lines[i].startsWith('@@ '))) {
        const anchor = lines[i++].slice(3);
        const before = [], after = [];
        while (i < lines.length && /^[ +\-]/.test(lines[i])) {
          const line = lines[i++];
          if (line[0] !== '+') before.push(line.slice(1));
          if (line[0] !== '-') after.push(line.slice(1));
        }
        const eof = lines[i] === '*** End of File';
        if (eof) i++;
        if (!before.length && !after.length) throw new Error('Empty patch hunk');
        file.hunks.push({ anchor, before, after, eof });
      }
      if (!file.hunks.length) throw new Error('Update requires at least one @@ hunk');
    }
    if (!file.path.trim() || (file.move !== undefined && !file.move.trim())) throw new Error('Empty patch path');
    files.push(file);
  }
  if (!files.length) throw new Error('Patch contains no files');
  return files;
}

/** Exact context matching; ambiguous hunks require more context, never a guess. */
export function patchText(text, hunks) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith('\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (trailing || text === '') lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.anchor) {
      const at = lines.indexOf(hunk.anchor, cursor);
      if (at < 0) throw new Error(`Patch anchor not found: ${hunk.anchor}`);
      cursor = at + 1;
    }
    const matches = hunk.before.length ? [] : [lines.length];
    for (let at = cursor; hunk.before.length && at <= lines.length - hunk.before.length; at++) {
      if (hunk.eof && at + hunk.before.length !== lines.length) continue;
      if (hunk.before.every((line, n) => lines[at + n] === line)) matches.push(at);
    }
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous patch context; include more surrounding lines' : 'Patch context not found');
    const at = matches[0];
    lines.splice(at, hunk.before.length, ...hunk.after);
    cursor = at + hunk.after.length;
  }
  return lines.join(eol) + (lines.length && (trailing || text === '') ? eol : '');
}
