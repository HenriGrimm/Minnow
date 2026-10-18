import { issueWorkOperation, type IssueWorkSnapshot } from '../state/git-api';
import { splitPatchIntoFiles, countPatchLineStats, type GitPatchFileEntry } from '../ui/git-patch-files';
import { button, el } from './dom';

export interface WorkChangesOptions {
  workspace: string;
  checkout: () => string;
  target: () => string | undefined;
  openCode: () => void;
  isMerged?: () => boolean;
  onSnapshot?: (snapshot: IssueWorkSnapshot | undefined) => void;
}

/** Read-only review of the entire branch plus its current working files. */
export function mountWorkChanges(host: HTMLElement, options: WorkChangesOptions): { refresh: (force?: boolean) => void; dispose: () => void } {
  let disposed = false, loading = false, lastFetch = 0, signature = '', selected = '';
  let files: GitPatchFileEntry[] = [];
  const heading = el('div', '', 'home-changes-heading');
  const summary = el('strong', 'Changes');
  const stats = el('span', '', 'home-diff-stats home-mono');
  const refresh = button('Refresh changes', () => load(true), false, 'refresh');
  heading.append(summary, stats, refresh);
  const context = el('p', 'Loading branch and working files…', 'home-muted'); context.setAttribute('role', 'status');
  const tabs = el('div', '', 'home-file-tabs'); tabs.setAttribute('aria-label', 'Changed files');
  const diff = el('div', '', 'home-file-diff');
  host.append(heading, context, tabs, diff);

  function renderFile(): void {
    const file = files.find(f => f.path === selected);
    diff.replaceChildren();
    for (const tab of tabs.querySelectorAll<HTMLButtonElement>('button')) tab.setAttribute('aria-pressed', String(tab.dataset.path === selected));
    if (!file) return;
    const head = el('div', '', 'home-diff-heading');
    head.append(el('strong', file.path, 'home-mono'), button('Open in Code', options.openCode, false, 'externalLink'));
    diff.append(head);
    if (file.binary || !file.patch.includes('@@')) {
      diff.append(el('p', file.binary ? 'Binary file changed. Open in Code to inspect it.' : 'File metadata changed; no text diff is available.', 'home-diff-notice home-muted'));
      return;
    }
    const code = el('div', '', 'home-unified-diff'); code.tabIndex = 0; code.setAttribute('role', 'region'); code.setAttribute('aria-label', `Diff for ${file.path}`);
    let before = 0, after = 0, hunk = false, count = 0;
    for (const raw of file.patch.split('\n')) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) { before = Number(match[1]); after = Number(match[2]); hunk = true; }
      if (!hunk || raw.startsWith('\\') || !raw) continue;
      if (++count > 3000) { code.append(el('p', 'Diff display limited to 3,000 lines. Open in Code to inspect the rest.', 'home-diff-notice')); break; }
      const kind = match ? 'hunk' : raw[0] === '+' ? 'add' : raw[0] === '-' ? 'remove' : 'context';
      const row = el('div', '', `home-diff-line home-diff-line--${kind}`);
      const oldNumber = el('span', match || kind === 'add' ? '' : String(before++), 'home-diff-number'); oldNumber.setAttribute('aria-hidden', 'true');
      const newNumber = el('span', match || kind === 'remove' ? '' : String(after++), 'home-diff-number'); newNumber.setAttribute('aria-hidden', 'true');
      row.append(oldNumber, newNumber, el('code', raw)); code.append(row);
    }
    diff.append(code);
  }

  async function load(force = false): Promise<void> {
    if (disposed || loading || !force && Date.now() - lastFetch < 10000) return;
    if (options.isMerged?.()) {
      summary.textContent = 'Work merged'; stats.textContent = ''; tabs.replaceChildren(); diff.replaceChildren();
      context.textContent = 'This worktree was merged. The conversation and recorded command output remain available.';
      return;
    }
    loading = true; lastFetch = Date.now(); refresh.disabled = true;
    let result: IssueWorkSnapshot;
    try { result = await issueWorkOperation('Inspect', { cwd: options.workspace, worktreePath: options.checkout(), comparisonBranch: options.target() }); }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    if (disposed) return;
    if (result.ok && result.isolated && options.target() && result.targetBranch !== options.target()) result = { ok: false, error: 'The running tool server did not compare against the merge target. Restart Minnow’s tool server and refresh changes.' };
    loading = false; refresh.disabled = false; options.onSnapshot?.(result.ok ? result : undefined);
    if (!result.ok) {
      context.textContent = result.error === 'server_off' ? 'Connect to the tool server to inspect changes.' : result.error || 'Could not load changes. Refresh to retry.';
      // Never retain a stale diff under a new or unavailable comparison.
      signature = ''; files = []; tabs.replaceChildren(); diff.replaceChildren(); summary.textContent = 'Changes unavailable'; stats.textContent = '';
      return;
    }
    const next = JSON.stringify([result.sourceHead, result.targetHead, result.fingerprint, result.patch]);
    if (signature === next) return;
    signature = next;
    files = splitPatchIntoFiles(result.patch || '');
    for (const path of result.files ?? []) if (!files.some(f => f.path === path)) files.push({ path, patch: '', binary: false });
    summary.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed`;
    const totals = countPatchLineStats(result.patch || ''); stats.textContent = `+${totals.additions} −${totals.deletions}`;
    context.textContent = `${result.isolated ? `Compared with ${result.targetBranch} · includes committed changes` : 'Changes in the current checkout'}${result.dirty ? ' · uncommitted changes included' : ''}${result.truncated ? ' · patch truncated by the server' : ''}`;
    tabs.replaceChildren();
    for (const file of files) {
      const totals = countPatchLineStats(file.patch);
      const tab = button(file.path, () => { selected = file.path; renderFile(); }); tab.dataset.path = file.path; tab.title = file.path;
      tab.append(el('span', `+${totals.additions} −${totals.deletions}`, 'home-diff-stats home-mono')); tabs.append(tab);
    }
    if (!files.some(f => f.path === selected)) selected = files[0]?.path || '';
    renderFile();
    if (!files.length) diff.append(el('p', 'No changes to review in this checkout.', 'home-diff-notice home-muted'));
  }
  return { refresh: force => { void load(force); }, dispose() { disposed = true; } };
}
