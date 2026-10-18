import type { Chat } from '../types';
import { startTerminalRun, streamTerminalRun, cancelTerminalRun } from '../api/terminal';
import { stripAnsi } from '../lib/strip-ansi';
import { el, button } from './dom';

interface ConsoleState { text: string; draft: string; runId: string; starting: boolean; listeners: Set<() => void> }
const sessions = new Map<string, ConsoleState>();

/** A running command outlives the mounted view; switching views never loses Stop. */
export function mountHomeTerminal(host: HTMLElement, workspace: string, chat?: Chat): () => void {
  const checkout = chat?.worktreeRoot || workspace;
  const key = JSON.stringify([checkout, chat?.id]);
  let state = sessions.get(key);
  if (!state) { state = { text: 'Run a command in this checkout.\n', draft: '', runId: '', starting: false, listeners: new Set() }; sessions.set(key, state); }
  const session = state;
  const consoleHost = el('div', '', 'home-terminal');
  const output = el('pre', session.text, 'home-terminal-output'); output.tabIndex = 0; output.setAttribute('aria-label', 'Terminal output');
  const form = el('form', '', 'home-terminal-form');
  const input = el('input'); input.value = session.draft; input.placeholder = 'Enter a command…'; input.setAttribute('aria-label', 'Terminal command'); input.oninput = () => { session.draft = input.value; };
  const send = button('Run', () => form.requestSubmit(), true);
  const notify = () => { for (const listener of session.listeners) listener(); };
  const stop = button('Stop', () => { if (session.runId) void cancelTerminalRun(session.runId).catch(error => { session.text += `\n${String(error)}\n`; notify(); }); });
  const update = () => {
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 64;
    output.textContent = session.text; send.disabled = session.starting || Boolean(session.runId); stop.disabled = !session.runId;
    if (follow) output.scrollTop = output.scrollHeight;
  };
  form.append(el('span', '›', 'home-mono'), input, send, stop);
  form.onsubmit = event => {
    event.preventDefault(); if (!input.value.trim() || session.runId || session.starting) return;
    const command = input.value.trim(); input.value = session.draft = ''; session.starting = true; session.text += `\n› ${command}\n`; notify();
    void (async () => {
      try {
        const run = await startTerminalRun({ command, shell: true, chatId: chat?.id || '', source: 'user', workspaceRoot: checkout });
        session.runId = run.runId; session.starting = false; notify();
        await streamTerminalRun(run.runId, event => {
          if (event.type === 'stdout' || event.type === 'stderr') session.text = (session.text + stripAnsi(event.text)).slice(-100000);
          else if (event.type === 'exit') session.text += `\nExited ${event.code ?? 'stopped'}${event.timedOut ? ' · timed out' : ''}\n`;
          else if (event.type === 'error') session.text += `\n${event.message}\n`;
          notify();
        });
      } catch (error) { session.text += `\n${error instanceof Error ? error.message : String(error)}\n`; }
      finally { session.runId = ''; session.starting = false; notify(); }
    })();
  };
  consoleHost.append(el('p', checkout, 'home-mono home-muted'), output, form); host.append(consoleHost);
  session.listeners.add(update); update();
  return () => { session.listeners.delete(update); };
}
