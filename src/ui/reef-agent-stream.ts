import type { ReefRun, ReefAgentRound, ReefAgentSession } from '../reef/types';
import { setAssistantBubbleContent, cancelAssistantBubbleRenderDebounce } from '../markdown/renderer';
import { renderThoughtsToggle, updateThoughtsToggleSegments } from './thought-bubbles';
import { renderToolCall, renderToolResult } from './tool-messages';
import { createTranscriptStreamStatus } from './transcript-view';

function node(tag: string, className: string, text = '') {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}

/** Keyed rows keep open disclosures, focus, and scroll position across token updates. */
export function mountReefAgentStream(host: HTMLElement) {
  const sessions = new Map<string, {
    root: HTMLElement; title: HTMLElement; rounds: HTMLElement; status: HTMLElement;
    rows: Map<string, ReturnType<typeof createRound>>;
  }>();
  let runId = '', legacy = '';
  function createRound() {
    const root = node('div', 'reef-agent-round');
    const thought = node('div', 'reef-agent-thought');
    const bubble = node('div', 'msg-bubble');
    const tools = node('div', 'reef-agent-tools');
    const notice = node('p', 'reef-agent-notice');
    root.append(notice, thought, bubble, tools);
    return { root, thought, bubble, tools, notice, text: '', reasoning: '', streaming: false,
      calls: new Map<string, { root: HTMLElement; result?: string }>() };
  }
  function paintRound(view: ReturnType<typeof createRound>, round: ReefAgentRound, session: ReefAgentSession, last: boolean, busy: boolean) {
    const live = busy && last && session.state === 'running';
    const streaming = live && !round.complete && session.activity === 'generating';
    view.notice.hidden = !round.notice; view.notice.textContent = round.notice ?? '';
    view.bubble.hidden = !round.text;
    if (view.text !== round.text || view.streaming !== streaming) {
      setAssistantBubbleContent(view.bubble, round.text, { streaming });
      view.text = round.text; view.streaming = streaming;
    }
    view.thought.hidden = !round.reasoning;
    if (round.reasoning && view.reasoning !== round.reasoning) {
      if (!view.thought.firstChild) renderThoughtsToggle(view.thought, [round.reasoning]);
      else updateThoughtsToggleSegments(view.thought, [round.reasoning]);
      view.reasoning = round.reasoning;
    }
    const thinking = live && session.activity === 'thinking';
    const panel = view.thought.querySelector<HTMLElement>('.thoughts-panel-wrap');
    panel?.classList.toggle('thoughts-panel-wrap--live', thinking);
    const label = panel?.querySelector('.thoughts-toggle__label'); if (label) label.textContent = thinking ? 'Thinking…' : 'Thoughts';
    const caret = panel?.querySelector('.thoughts-caret'); caret?.classList.toggle('thoughts-caret--pulse', thinking);
    const ids = new Set(round.tools.map(tool => tool.id));
    for (const [id, call] of view.calls) if (!ids.has(id)) { call.root.remove(); view.calls.delete(id); }
    for (const tool of round.tools) {
      let call = view.calls.get(tool.id);
      if (!call) {
        const root = renderToolCall(tool.name, tool.args, { standalone: true });
        root.dataset.reefToolId = tool.id;
        // Reef's build worktree is independent of Code's selected workspace.
        // File cards show the path; Open in Code is the explicit workspace handoff.
        root.addEventListener('click', event => {
          if ((event.target as Element).closest('.tool-call-target--file-link')) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        view.tools.append(root); call = { root }; view.calls.set(tool.id, call);
      }
      const result = tool.result !== undefined ? tool.isError && !tool.result.trimStart().startsWith('Error:') ? `Error: ${tool.result}` : tool.result
        : !busy || session.state !== 'running' ? 'Error: Agent ended before a tool result was recorded.' : undefined;
      if (result !== undefined && call.result !== result) { renderToolResult(call.root, result, undefined, tool.args); call.result = result; }
      const pathButton = call.root.querySelector<HTMLButtonElement>('button.tool-call-target');
      if (pathButton) { pathButton.disabled = true; pathButton.setAttribute('aria-label', String(tool.args.path ?? tool.name)); }
    }
  }
  function clear() {
    for (const session of sessions.values()) for (const round of session.rows.values()) cancelAssistantBubbleRenderDebounce(round.bubble);
    sessions.clear(); host.replaceChildren(); legacy = '';
  }
  return {
    update(run: ReefRun | undefined, busy: boolean) {
      const following = host.scrollHeight - host.scrollTop - host.clientHeight < 64;
      if (runId !== run?.id) { clear(); runId = run?.id ?? ''; }
      if (!run?.agentSessions?.length) {
        const text = run?.agentLog?.trimStart() || 'Waiting for the model’s first output…';
        if (legacy !== text) { host.replaceChildren(node('div', 'reef-agent-legacy', text)); legacy = text; }
        if (following) host.scrollTop = host.scrollHeight;
        return;
      }
      if (legacy) { host.replaceChildren(); legacy = ''; }
      const ids = new Set(run.agentSessions.map(session => session.chatId));
      for (const [id, session] of sessions) if (!ids.has(id)) {
        for (const round of session.rows.values()) cancelAssistantBubbleRenderDebounce(round.bubble);
        session.root.remove(); sessions.delete(id);
      }
      let builder = 0;
      for (const session of run.agentSessions) {
        if (session.phase === 'build') builder++;
        let view = sessions.get(session.chatId);
        if (!view) {
          const root = node('section', 'reef-agent-session'); root.dataset.chatId = session.chatId;
          const title = node('h4', 'reef-agent-title'), rounds = node('div', 'reef-agent-rounds'), status = node('div', 'reef-agent-status');
          status.setAttribute('role', 'status'); root.append(title, rounds, status); host.append(root);
          view = { root, title, rounds, status, rows: new Map() }; sessions.set(session.chatId, view);
        }
        const name = session.phase === 'plan' ? 'Planner' : `Builder${builder > 1 ? ` · context ${builder}` : ''}`;
        view.title.textContent = `${name} · ${session.state === 'running' && !busy ? 'Stopped' : session.state === 'running' ? 'Working' : session.state === 'failed' ? 'Stopped' : 'Complete'}`;
        const roundIds = new Set(session.rounds.map(round => round.id));
        for (const [id, row] of view.rows) if (!roundIds.has(id)) { cancelAssistantBubbleRenderDebounce(row.bubble); row.root.remove(); view.rows.delete(id); }
        session.rounds.forEach((round, index) => {
          let row = view!.rows.get(round.id);
          if (!row) { row = createRound(); view!.rows.set(round.id, row); view!.rounds.append(row.root); }
          paintRound(row, round, session, index === session.rounds.length - 1, busy);
        });
        const status = session.error || (session.truncated ? 'Earlier activity is available in the saved chat.' : '');
        if (session.state !== 'running' || !busy) {
          if (view.status.textContent !== status || view.status.dataset.live) { view.status.replaceChildren(); view.status.textContent = status; delete view.status.dataset.live; }
        } else {
          const phase = session.activity ?? 'generating';
          if (view.status.dataset.live !== phase || view.status.dataset.tool !== (session.currentTool ?? '')) {
            view.status.replaceChildren(createTranscriptStreamStatus(phase === 'thinking' ? 'thinking' : 'generating'));
            const label = view.status.querySelector('.stream-status__label');
            if (label && phase === 'tools') label.textContent = session.currentTool ? `Running ${session.currentTool}…` : 'Running tools…';
            if (label && phase === 'loading') label.textContent = 'Loading model…';
            view.status.dataset.live = phase; view.status.dataset.tool = session.currentTool ?? '';
          }
        }
      }
      if (following) host.scrollTop = host.scrollHeight;
    },
    dispose: clear,
  };
}
