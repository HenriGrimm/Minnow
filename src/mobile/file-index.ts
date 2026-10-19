/** Pure helpers over the workspace file index: folder listings and go-to-file ranking. */

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/** Direct children of `dir` derived from the file index. */
export function listFromIndex(files: readonly string[], dir: string): { dirs: string[]; files: string[] } {
  const prefix = dir === '.' ? '' : `${dir}/`;
  const dirs = new Set<string>();
  const names: string[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) names.push(rest);
    else dirs.add(rest.slice(0, slash));
  }
  return {
    dirs: [...dirs].sort((a, b) => a.localeCompare(b)),
    files: names.sort((a, b) => a.localeCompare(b)),
  };
}

/** Subsequence match with a bonus for basename and contiguous hits. */
export function fuzzyScore(path: string, query: string): number {
  const hay = path.toLowerCase();
  const base = baseName(hay);
  if (base.startsWith(query)) return 1000 - path.length;
  if (base.includes(query)) return 800 - path.length;
  if (hay.includes(query)) return 600 - path.length;
  let index = 0;
  let score = 0;
  for (const char of query) {
    const found = hay.indexOf(char, index);
    if (found < 0) return -1;
    score += found === index ? 3 : 1;
    index = found + 1;
  }
  return score * 10 - path.length;
}
