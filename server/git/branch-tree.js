/**
 * Infer which local branch each branch was forked from, so Source Control can
 * draw branches as a tree. Git records no parent link, so this is a heuristic
 * over one commit-graph walk plus the branch reflog:
 *
 * 1. A candidate parent must share history with the branch and must not be a
 *    strict descendant of it (a child never parents its own base).
 * 2. The candidate with the fewest commits unique to the branch wins — the
 *    closest fork point.
 * 3. Ties prefer the reflog's `Created from X`, then a strict ancestor, then
 *    the trunk, then the older branch.
 * 4. Diverged candidates created after the branch are skipped, which settles
 *    the symmetric case (B forked from P, then P moved on) that the graph
 *    alone cannot. Any cycle that still slips through is cut at the trunk.
 */

/** Commit walk cap: enough for any normal repo, bounded for monorepos. */
export const BRANCH_TREE_COMMIT_CAP = 40_000;

/**
 * `git rev-list --parents` output → sha index + parent index lists.
 * @param {string} text
 */
export function parseRevListParents(text) {
  const index = new Map();
  const parents = [];
  const lines = String(text ?? '').split('\n');
  for (const raw of lines) {
    const sha = raw.trim().split(' ')[0];
    if (sha && !index.has(sha)) {
      index.set(sha, parents.length);
      parents.push([]);
    }
  }
  for (const raw of lines) {
    const [sha, ...rest] = raw.trim().split(' ');
    if (!sha) continue;
    const own = parents[index.get(sha)];
    for (const parent of rest) {
      const at = index.get(parent);
      if (at !== undefined) own.push(at);
    }
  }
  return { index, parents };
}

/** Reflog first line → creation time (unix seconds) and `Created from X`. */
export function parseBranchReflogHead(text) {
  const first = String(text ?? '').split('\n', 1)[0] ?? '';
  const tab = first.indexOf('\t');
  const head = tab >= 0 ? first.slice(0, tab) : first;
  const message = tab >= 0 ? first.slice(tab + 1).trim() : '';
  const time = /\s(\d{9,})\s[+-]\d{4}$/.exec(head);
  const from = /^branch: Created from (.+)$/.exec(message);
  return {
    createdAt: time ? Number(time[1]) : undefined,
    createdFrom: from ? from[1].trim() : undefined,
  };
}

function ancestorBits(tip, parents, words) {
  const bits = new Uint32Array(words);
  if (tip === undefined) return bits;
  const stack = [tip];
  while (stack.length) {
    const at = stack.pop();
    const word = at >>> 5;
    const mask = 1 << (at & 31);
    if (bits[word] & mask) continue;
    bits[word] |= mask;
    for (const parent of parents[at]) stack.push(parent);
  }
  return bits;
}

function reaches(from, target, parents, seen) {
  seen.fill(0);
  const stack = [from];
  while (stack.length) {
    const at = stack.pop();
    if (at === target) return true;
    if (seen[at]) continue;
    seen[at] = 1;
    for (const parent of parents[at]) stack.push(parent);
  }
  return false;
}

/**
 * Ancestors of the newest trunk first-parent commit that does not yet contain
 * `tip`. Containment is monotonic along the first-parent chain, so this is a
 * binary search for the merge point.
 */
function trunkBeforeMerge(trunkTip, tip, parents, words) {
  const chain = [];
  for (let at = trunkTip; at !== undefined; at = parents[at][0]) chain.push(at);
  const seen = new Uint8Array(parents.length);
  let lo = 0;
  let hi = chain.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (reaches(chain[mid], tip, parents, seen)) lo = mid + 1;
    else hi = mid;
  }
  return ancestorBits(chain[lo], parents, words);
}

function popcount(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Commits in `a` that are not in `b` — `git rev-list --count b..a`. */
function countOnly(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += popcount(a[i] & ~b[i]);
  return total;
}

function intersects(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] & b[i]) return true;
  return false;
}

function hasBit(bits, at) {
  return at !== undefined && Boolean(bits[at >>> 5] & (1 << (at & 31)));
}

/** Map a reflog start point (`main`, `origin/main`, `refs/heads/x`) to a local branch. */
function resolveCreatedFrom(from, names) {
  if (!from) return undefined;
  const ref = from.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  if (names.has(ref)) return ref;
  const slash = ref.indexOf('/');
  if (slash > 0 && names.has(ref.slice(slash + 1))) return ref.slice(slash + 1);
  return undefined;
}

/**
 * @param {{
 *   branches: { name: string, sha: string, createdAt?: number, createdFrom?: string }[],
 *   revList: string,
 *   trunk?: string,
 * }} input
 * @returns {Map<string, { parent: string | null, ahead: number, behind: number, merged: boolean }>}
 */
export function inferBranchParents({ branches, revList, trunk }) {
  const { index, parents } = parseRevListParents(revList);
  const words = Math.max(1, Math.ceil(parents.length / 32));
  const names = new Set(branches.map((branch) => branch.name));
  const nodes = branches.map((branch) => {
    const tip = index.get(branch.sha);
    return { ...branch, tip, bits: ancestorBits(tip, parents, words) };
  });
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const trunkNode = trunk ? byName.get(trunk) : undefined;
  const result = new Map();

  for (const node of nodes) {
    const merged = Boolean(trunkNode && node.sha !== trunkNode.sha && hasBit(trunkNode.bits, node.tip));
    if (node === trunkNode || node.tip === undefined) {
      result.set(node.name, { parent: null, ahead: 0, behind: 0, merged });
      continue;
    }
    const hint = resolveCreatedFrom(node.createdFrom, names);
    // A merged branch is compared with the trunk as it stood before the merge,
    // otherwise the trunk contains it and could never be its parent.
    const trunkBits = merged ? trunkBeforeMerge(trunkNode.tip, node.tip, parents, words) : trunkNode?.bits;
    let best;
    for (const other of nodes) {
      if (other === node || other.tip === undefined) continue;
      const isTrunk = other === trunkNode;
      const bits = isTrunk ? trunkBits : other.bits;
      if (!intersects(node.bits, bits)) continue;
      const sameTip = other.sha === node.sha;
      const isDescendant = !sameTip && !(isTrunk && merged) && hasBit(bits, node.tip);
      if (isDescendant) continue;
      const isAncestor = !sameTip && hasBit(node.bits, other.tip);
      const youngerSibling = !isAncestor && !isTrunk
        && node.createdAt !== undefined && other.createdAt !== undefined
        && other.createdAt > node.createdAt;
      if (youngerSibling) continue;
      const candidate = {
        name: other.name,
        ahead: countOnly(node.bits, bits),
        behind: countOnly(bits, node.bits),
        rank: [
          other.name === hint ? 0 : 1,
          isAncestor ? 0 : 1,
          isTrunk ? 0 : 1,
        ],
        createdAt: other.createdAt ?? Number.POSITIVE_INFINITY,
      };
      if (!best || compareCandidates(candidate, best) < 0) best = candidate;
    }
    result.set(node.name, best
      ? { parent: best.name, ahead: best.ahead, behind: best.behind, merged }
      : { parent: null, ahead: 0, behind: 0, merged });
  }

  breakCycles(result, trunkNode, byName);
  for (const entry of result.values()) {
    if (entry.merged) {
      entry.ahead = 0;
      entry.behind = 0;
    }
  }
  return result;
}

function compareCandidates(a, b) {
  if (a.ahead !== b.ahead) return a.ahead - b.ahead;
  for (let i = 0; i < a.rank.length; i++) {
    if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.name.localeCompare(b.name);
}

function breakCycles(result, trunkNode, byName) {
  for (const start of result.keys()) {
    const seen = new Set();
    let at = start;
    while (at && !seen.has(at)) {
      seen.add(at);
      at = result.get(at)?.parent ?? null;
    }
    if (!at) continue;
    // `at` sits on a cycle: re-home it under the trunk (or make it a root).
    const entry = result.get(at);
    const node = byName.get(at);
    if (trunkNode && trunkNode.name !== at && node) {
      entry.parent = trunkNode.name;
      entry.ahead = countOnly(node.bits, trunkNode.bits);
      entry.behind = countOnly(trunkNode.bits, node.bits);
    } else {
      entry.parent = null;
      entry.ahead = 0;
      entry.behind = 0;
    }
  }
}

/** `%(upstream:track,nobracket)` → ahead/behind/gone. */
export function parseUpstreamTrack(text) {
  const value = String(text ?? '').trim();
  const ahead = /ahead (\d+)/.exec(value);
  const behind = /behind (\d+)/.exec(value);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: value === 'gone',
  };
}
