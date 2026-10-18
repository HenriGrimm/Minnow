import type { Chat, TerminalRunRecord } from '../types';
import { fetchTerminalLog, loadTerminalHistory } from '../api/terminal';
import { stripAnsi } from '../lib/strip-ansi';
import { button, el, age } from './dom';
import { createIcon } from '../ui/icon';

/** Completed commands are evidence of execution, never an invented test verdict. */
export function mountRunEvidence(host: HTMLElement, chat: Chat | undefined, onChange: (runs: TerminalRunRecord[]) => void): { update: () => void; refresh: () => void; dispose: () => void } {
  let disposed = false, signature = '', loading = false;
  const opened = new Set<string>();
  const output = new Map<string, string>();
  const heading = el('div', '', 'home-changes-heading');
  heading.append(el('strong', 'Commands & results'), button('Refresh runs', () => { void refresh(); }, false, 'refresh'));
  const description = el('p', 'Recorded command results. They do not confirm that the requested behavior works.', 'home-muted');
  const list = el('div', '', 'home-run-list');
  host.append(heading, description, list);

  function update(): void {
    if (disposed) return;
    const runs = chat?.terminalHistory ?? [];
    const next = JSON.stringify(runs);
    if (next === signature) return;
    signature = next; onChange(runs); list.replaceChildren();
    if (!runs.length) { list.append(el('p', 'No command results recorded for this chat yet.', 'home-diff-notice home-muted')); return; }
    for (const run of [...runs].reverse()) {
      const details = el('details', '', 'home-run'); details.open = opened.has(run.id);
      const summary = el('summary');
      summary.append(createIcon(run.exitCode === 0 && !run.timedOut ? 'statusPass' : 'statusFail'), el('span', run.command, 'home-mono'), el('span', run.timedOut ? 'Timed out' : run.exitCode === null ? 'Stopped' : `Exit ${run.exitCode}`, 'home-run-result'));
      const meta = el('p', `${run.source === 'agent' ? 'Agent' : 'You'} · ${new Date(run.startedAt).toLocaleString()} · ${age(run.startedAt)} · ${run.cwd}`, 'home-muted home-run-meta');
      const pre = el('pre', output.get(run.id) || 'Open to load output.', 'home-run-output'); pre.tabIndex = 0; pre.setAttribute('aria-label', `Output for ${run.command}`);
      let fetching = false;
      const load = async () => {
        if (fetching || output.has(run.id)) return;
        fetching = true; pre.textContent = 'Loading output…';
        try {
          const result = await fetchTerminalLog(run.id);
          if (!disposed) { const text = result === null ? 'Output is no longer available.' : stripAnsi(result) || 'Command produced no output.'; output.set(run.id, text); pre.textContent = text; }
        } catch { if (!disposed) pre.textContent = 'Could not load output. Close and reopen to retry.'; }
        finally { fetching = false; }
      };
      details.ontoggle = () => { if (details.open) { opened.add(run.id); void load(); } else opened.delete(run.id); };
      details.append(summary, meta, pre); list.append(details);
      if (details.open) void load();
    }
  }
  async function refresh(): Promise<void> {
    if (!chat || loading || disposed) return;
    loading = true;
    try {
      const runs = await loadTerminalHistory(chat.id);
      if (!disposed) {
        // The server history may lag freshly completed client records.
        chat.terminalHistory = [...new Map([...(chat.terminalHistory ?? []), ...runs].map(run => [run.id, run])).values()].sort((a, b) => a.startedAt - b.startedAt);
        update();
      }
    } catch { if (!disposed && !chat.terminalHistory?.length) list.replaceChildren(el('p', 'Could not load command history. Refresh to retry.', 'home-muted')); }
    finally { loading = false; }
  }
  update();
  return { update, refresh: () => { void refresh(); }, dispose() { disposed = true; } };
}
