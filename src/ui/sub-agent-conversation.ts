import { apiMessageContentToText } from '../api/message-content';
import type { ApiMessageContent } from '../types';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { createIcon } from './icon';
import { renderTranscriptView, type TranscriptDisclosureState } from './transcript-view';
import type { SubAgentTranscriptLive } from './sub-agent-live-status';

/** Only prose after the last tool call can be the agent's final response. */
export function subAgentFinalResponse(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i] as Record<string, unknown> | null;
    if (!row || row.role !== 'assistant') continue;
    if (Array.isArray(row.tool_calls) && row.tool_calls.length) return '';
    const text = apiMessageContentToText(row.content as ApiMessageContent).trim();
    if (text) return text;
  }
  return '';
}

export interface SubAgentConversationDisclosures extends TranscriptDisclosureState {
  groups: Map<string, boolean>;
}

/** Use shared Thoughts and tool components, with prose taking the reading flow. */
export function renderSubAgentConversation(
  body: HTMLElement,
  messages: unknown[],
  live: SubAgentTranscriptLive | undefined,
  status: string,
  disclosures: SubAgentConversationDisclosures,
): void {
  renderTranscriptView(body, messages, live, disclosures);
  body.querySelectorAll('.transcript-view__system').forEach((row) => row.remove());
  const proseTurns = [...body.querySelectorAll<HTMLElement>('.transcript-view__assistant-turn')]
    .filter((turn) => turn.querySelector('.transcript-view__assistant'));
  for (const turn of proseTurns) {
    const heading = document.createElement('div');
    heading.className = 'sub-agent-conversation__speaker';
    const final = status === 'completed' && turn === proseTurns.at(-1) && Boolean(subAgentFinalResponse(messages));
    heading.append(createIcon(final ? 'check' : 'appChat', { size: 14 }), document.createTextNode(final ? 'Final response' : 'Update'));
    const prose = turn.querySelector<HTMLElement>('.transcript-view__assistant')!;
    turn.insertBefore(heading, prose);
    if (final) turn.classList.add('sub-agent-conversation__final');
  }

  let group: HTMLDetailsElement | null = null;
  let container: HTMLElement | null = null;
  let count = 0;
  const finish = () => {
    if (!group) return;
    const summary = group.querySelector('summary')!;
    summary.append(createIcon('tools', { size: 14 }), document.createTextNode(`${count} tool ${count === 1 ? 'call' : 'calls'}`));
  };
  for (const row of [...body.children]) {
    if (!row.classList.contains('tool-call-msg')) {
      finish(); group = null; container = null;
      continue;
    }
    if (!group) {
      group = document.createElement('details');
      group.className = 'sub-agent-conversation__tools';
      const key = (row as HTMLElement).dataset.transcriptToolCallId ?? '';
      group.open = disclosures.groups.get(key) ?? false;
      group.addEventListener('toggle', () => disclosures.groups.set(key, groupForKey.open));
      const groupForKey = group;
      group.appendChild(document.createElement('summary'));
      container = document.createElement('div');
      container.className = 'sub-agent-conversation__tool-body';
      group.appendChild(container);
      body.insertBefore(group, row);
      count = 0;
    }
    container!.appendChild(row);
    count += 1;
  }
  finish();
  formatSubAgentProse(body);
}

/** Format only changed live prose; streaming never replaces the whole inspector. */
export function formatSubAgentProse(body: HTMLElement, partialText?: string): void {
  for (const row of body.querySelectorAll<HTMLElement>('.transcript-view__assistant')) {
    const partial = row.classList.contains('transcript-view__assistant--partial');
    const text = partial && partialText !== undefined ? partialText : row.dataset.markdown ?? row.textContent ?? '';
    if (row.dataset.markdown === text && !partial) continue;
    setAssistantBubbleContent(row, text);
    row.dataset.markdown = text;
  }
}
