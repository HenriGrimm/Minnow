const MAX_PATCH_ROWS = 800;

export function paintGraphiteFileDiff(host: HTMLElement, patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;
  let visibleRows = 0;
  let inHunk = false;
  const fragment = document.createDocumentFragment();
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    let number: number | null = null;
    let tone = 'context';
    let marker = '';
    let content = line;
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      tone = 'hunk';
    } else if (!inHunk || !line) {
      continue;
    } else if (line[0] === '+') {
      additions += 1;
      number = newLine++;
      tone = 'addition';
      marker = '+';
      content = line.slice(1);
    } else if (line[0] === '-') {
      deletions += 1;
      number = oldLine++;
      tone = 'deletion';
      marker = '−';
      content = line.slice(1);
    } else if (line[0] === ' ') {
      oldLine += 1;
      number = newLine++;
      content = line.slice(1);
    } else if (line[0] !== '\\') {
      continue;
    }
    if (visibleRows++ >= MAX_PATCH_ROWS) continue;
    const row = document.createElement('div');
    row.className = `graphite-git-patch__row graphite-git-patch__row--${tone}`;
    const index = document.createElement('span');
    index.className = 'graphite-git-patch__line';
    index.textContent = number === null ? '' : String(number);
    index.setAttribute('aria-hidden', 'true');
    const sign = document.createElement('span');
    sign.className = 'graphite-git-patch__sign';
    sign.textContent = marker;
    const text = document.createElement('span');
    text.className = 'graphite-git-patch__text';
    text.textContent = content;
    row.append(index, sign, text);
    fragment.append(row);
  }
  if (visibleRows === 0 || visibleRows > MAX_PATCH_ROWS) {
    const notice = document.createElement('p');
    notice.className = 'graphite-git-patch__notice';
    notice.textContent = visibleRows === 0
      ? 'No text diff is available for this file.'
      : `Showing the first ${MAX_PATCH_ROWS} lines. Open the file diff for more.`;
    fragment.append(notice);
  }
  host.replaceChildren(fragment);
  return { additions, deletions };
}
