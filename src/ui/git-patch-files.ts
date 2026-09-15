export interface GitPatchFileEntry {
  notice?: string;
  /** Path after the change (b/ side). */
  path: string;
  /** Previous path when the change is a rename. */
  oldPath?: string;
  /** Full `diff --git …` block for this file. */
  patch: string;
  /** True when git reports a binary change with no text patch. */
  binary: boolean;
}

/**
 * Split combined `git show` patch output into one entry per changed file.
 */
export function splitPatchIntoFiles(patch: string): GitPatchFileEntry[] {
  const raw = String(patch ?? '').trim();
  if (!raw) return [];

  const parts = raw.split(/^diff --git /m);
  const entries: GitPatchFileEntry[] = [];

  for (let i = 1; i < parts.length; i++) {
    const block = `diff --git ${parts[i]}`.trimEnd();
    if (!block) continue;

    const headerMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/);
    let path = headerMatch?.[2]?.trim() ?? `file-${i}`;
    let oldPath: string | undefined = headerMatch?.[1]?.trim();

    const renameFrom = block.match(/^rename from (.+?)(?:\r?\n|$)/m);
    const renameTo = block.match(/^rename to (.+?)(?:\r?\n|$)/m);
    if (renameFrom && renameTo) {
      oldPath = renameFrom[1].trim();
      path = renameTo[1].trim();
    }

    if (oldPath === path) oldPath = undefined;

    const binary =
      /^(GIT binary patch|Binary files)/m.test(block) ||
      /^deleted file mode /m.test(block) && !/^@@/m.test(block);

    entries.push({ path, oldPath, patch: block, binary });
  }

  return entries;
}

/** Count +/− lines in a single-file unified patch (hunk body only). */
export function countPatchLineStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const raw of String(patch ?? '').split('\n')) {
    if (raw.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) additions += 1;
    else if (raw.startsWith('-')) deletions += 1;
  }

  return { additions, deletions };
}
