/**
 * The Activity tab: the story of a run. Each stage step is a section holding
 * the agent's transcript (reasoning, tool calls, prose), and the user's
 * decisions sit between them in time order. The step that is running streams
 * a live tail from the run's SSE channel.
 */

import { fetchSuperPlanTranscript } from '../../chat/super-plan/api';
import type {
  SuperPlanLiveFrame,
  SuperPlanRunView,
  SuperPlanTimelineRow,
  SuperPlanTranscriptRef,
} from '../../chat/super-plan/types';
import { appendTranscriptLiveTail, renderTranscriptView } from '../transcript-view';
import type { SubAgentTranscriptLive } from '../sub-agent-live-status';
import { setAssistantBubbleContent } from '../../markdown/renderer';
import { el, formatClock, formatTimeOfDay } from './dom';

/** Timeline kinds that read as the user's decisions and the run's milestones. */
const NOTE_KINDS = new Set(['question', 'answer', 'checkpoint', 'skip', 'halted']);

interface LiveState {
  phase: 'thinking' | 'generating' | 'tools' | 'loading_model' | 'waiting' | null;
  text: string;
  reasoning: string;
  tool: string;
}

interface SectionState {
  ref: SuperPlanTranscriptRef;
  root: HTMLDetailsElement;
  meta: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  messages: Record<string, unknown>[] | null;
  loadedFor: string;
  loading: boolean;
}

export class ActivityFeed {
  private readonly list = el('div', 'sp-feed');
  private readonly sections = new Map<string, SectionState>();
  /** Sections the user opened or closed by hand; their choice survives rebuilds. */
  private readonly userOpen = new Map<string, boolean>();
  private structure = '';
  private view: SuperPlanRunView | null = null;
  private live: LiveState = { phase: null, text: '', reasoning: '', tool: '' };
  private liveKey = '';
  private research: HTMLElement | null = null;
  private researchLine = '';
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private paintTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    private readonly runId: string,
  ) {
    host.replaceChildren(this.list);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    if (this.paintTimer) clearTimeout(this.paintTimer);
  }

  update(view: SuperPlanRunView): void {
    this.view = view;
    const liveRef = view.transcripts.find((t) => t.live);
    const nextLiveKey = liveRef?.key ?? '';
    if (nextLiveKey !== this.liveKey) {
      this.liveKey = nextLiveKey;
      this.live = { phase: null, text: '', reasoning: '', tool: '' };
    }
    const structure = structureKey(view);
    if (structure !== this.structure) {
      this.structure = structure;
      this.rebuild(view);
    } else {
      for (const section of this.sections.values()) {
        const ref = view.transcripts.find((t) => t.key === section.ref.key);
        if (ref) this.refreshSection(section, ref);
      }
    }
  }

  /** A live frame from the run's stream. */
  onLive(frame: SuperPlanLiveFrame): void {
    const event = frame.event;
    if (frame.stage === 'research') {
      if (event.type === 'research.progress') this.paintResearchProgress(event);
      return;
    }
    const type = event.type;
    if (type === 'delta') {
      this.live.text = String(event.text ?? '');
      this.live.phase = 'generating';
    } else if (type === 'thinking') {
      this.live.reasoning = String(event.text ?? '');
      this.live.phase = 'thinking';
    } else if (type === 'phase') {
      const phase = String(event.phase ?? '');
      this.live.phase = phase === 'thinking' || phase === 'tools' || phase === 'waiting' ? phase : 'generating';
    } else if (type === 'loading_model') {
      this.live.phase = 'loading_model';
    } else if (type === 'tool_call' || type === 'tool_streaming') {
      this.live.phase = 'tools';
      this.live.tool = String(event.name ?? '');
    } else if (type === 'round_start' || type === 'response_restart') {
      this.live.text = '';
      this.live.reasoning = '';
    } else if (type === 'round_end' || type === 'tool_result') {
      if (type === 'round_end') {
        this.live.text = '';
        this.live.reasoning = '';
      }
      this.scheduleRefetch();
    }
    this.schedulePaint();
  }

  // ── Structure ──────────────────────────────────────────────────────────────

  private rebuild(view: SuperPlanRunView): void {
    const items: Array<{ at: number; order: number; node: HTMLElement }> = [];
    let order = 0;
    if (view.prompt) items.push({ at: view.createdAt ?? 0, order: order++, node: requestNode(view) });

    const keep = new Map<string, SectionState>();
    for (const ref of view.transcripts) {
      const section = this.sections.get(ref.key) ?? this.createSection(ref);
      keep.set(ref.key, section);
      this.refreshSection(section, ref);
      items.push({ at: ref.startedAt ?? 0, order: order++, node: section.root });
    }
    this.sections.clear();
    for (const [key, section] of keep) this.sections.set(key, section);

    const research = view.steps.find((s) => s.id === 'research');
    if (research && research.state !== 'off' && research.state !== 'pending' && research.startedAt) {
      items.push({ at: research.startedAt, order: order++, node: this.researchNode(view) });
    } else {
      this.research = null;
    }

    for (const row of view.timeline) {
      if (!NOTE_KINDS.has(row.kind)) continue;
      items.push({ at: row.at, order: order++, node: noteNode(row) });
    }

    items.sort((a, b) => a.at - b.at || a.order - b.order);
    if (!view.transcripts.length && !items.some((item) => item.node.classList.contains('sp-feed__research'))) {
      items.push({ at: Number.MAX_SAFE_INTEGER, order: order++, node: el('p', 'sp-empty', startingCopy(view)) });
    }
    this.list.replaceChildren(...items.map((item) => item.node));
  }

  private createSection(ref: SuperPlanTranscriptRef): SectionState {
    const root = el('details', 'sp-feed__stage');
    root.dataset.key = ref.key;
    const summary = el('summary', 'sp-feed__summary');
    const status = el('span', 'sp-feed__mark');
    const label = el('span', 'sp-feed__label', ref.label);
    const meta = el('span', 'sp-feed__meta');
    summary.append(status, label, meta);
    const body = el('div', 'sp-transcript transcript-view__body chat-thread');
    root.append(summary, body);
    const section: SectionState = { ref, root, meta, body, status, messages: null, loadedFor: '', loading: false };
    root.addEventListener('toggle', () => {
      if (root.dataset.programmatic === '1') return;
      this.userOpen.set(ref.key, root.open);
      if (root.open) void this.load(section);
    });
    return section;
  }

  private refreshSection(section: SectionState, ref: SuperPlanTranscriptRef): void {
    section.ref = ref;
    const label = section.root.querySelector('.sp-feed__label');
    if (label && label.textContent !== ref.label) label.textContent = ref.label;
    section.root.classList.toggle('is-live', ref.live);
    section.root.classList.toggle('is-problem', !ref.live && Boolean(ref.outcome && ref.outcome !== 'ok' && ref.outcome !== 'superseded'));
    section.status.dataset.state = ref.live ? 'live' : ref.outcome === 'ok' ? 'done' : ref.outcome ? 'ended' : 'pending';
    section.meta.textContent = sectionMeta(ref);
    const wantOpen = this.userOpen.get(ref.key) ?? ref.live;
    if (section.root.open !== wantOpen) {
      section.root.dataset.programmatic = '1';
      section.root.open = wantOpen;
      queueMicrotask(() => {
        delete section.root.dataset.programmatic;
      });
    }
    if (section.root.open) void this.load(section);
  }

  // ── Transcripts ────────────────────────────────────────────────────────────

  private async load(section: SectionState, force = false): Promise<void> {
    const version = `${section.ref.attempts}:${section.ref.outcome ?? ''}:${section.ref.live ? 1 : 0}`;
    if (!force && section.loadedFor === version && section.messages) {
      this.paintSection(section);
      return;
    }
    if (section.loading) return;
    section.loading = true;
    try {
      const messages = await fetchSuperPlanTranscript(this.runId, section.ref.key);
      if (this.destroyed) return;
      section.messages = messages;
      section.loadedFor = version;
    } catch {
      section.messages ??= [];
    } finally {
      section.loading = false;
    }
    this.paintSection(section);
  }

  private paintSection(section: SectionState): void {
    const messages = visibleMessages(section.messages ?? []);
    const live = section.ref.live ? this.liveTail() : undefined;
    renderTranscriptView(section.body, messages, live);
    for (const prose of section.body.querySelectorAll<HTMLElement>('.transcript-view__assistant')) {
      setAssistantBubbleContent(prose, prose.textContent ?? '');
    }
    this.paintLoadingLine(section);
    if (!messages.length && !live) section.body.append(el('p', 'sp-empty', section.ref.live ? 'Starting…' : 'Nothing was recorded for this step.'));
  }

  private liveTail(): SubAgentTranscriptLive | undefined {
    const phase = this.live.phase;
    if (phase === 'loading_model' || phase === 'waiting') return { isLive: true, phase: null };
    return {
      isLive: true,
      phase: phase ?? 'generating',
      currentToolName: this.live.tool || null,
      ...(this.live.text ? { partialText: this.live.text } : {}),
      ...(this.live.reasoning ? { partialReasoning: this.live.reasoning } : {}),
    };
  }

  private paintLoadingLine(section: SectionState): void {
    section.body.querySelector('.sp-feed__waiting')?.remove();
    if (!section.ref.live) return;
    const phase = this.live.phase;
    if (phase !== 'loading_model' && phase !== 'waiting') return;
    const line = el('p', 'sp-feed__waiting', phase === 'loading_model' ? 'Loading the model…' : 'Waiting for your answers…');
    line.setAttribute('role', 'status');
    section.body.append(line);
  }

  private schedulePaint(): void {
    if (this.paintTimer || this.destroyed) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      const section = this.liveKey ? this.sections.get(this.liveKey) : undefined;
      if (!section || !section.root.open) return;
      if (!section.messages) {
        void this.load(section);
        return;
      }
      appendTranscriptLiveTail(section.body, this.liveTail(), visibleMessages(section.messages));
      this.paintLoadingLine(section);
    }, 60);
  }

  private scheduleRefetch(): void {
    if (this.refetchTimer || this.destroyed) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      const section = this.liveKey ? this.sections.get(this.liveKey) : undefined;
      if (section?.root.open) void this.load(section, true);
    }, 250);
  }

  // ── Research ───────────────────────────────────────────────────────────────

  private researchNode(view: SuperPlanRunView): HTMLElement {
    const node = el('div', 'sp-feed__research');
    const step = view.steps.find((s) => s.id === 'research');
    const head = el('div', 'sp-feed__summary sp-feed__summary--static');
    const mark = el('span', 'sp-feed__mark');
    const running = step?.state === 'active';
    mark.dataset.state = running ? 'live' : step?.state === 'done' || step?.state === 'earlier' ? 'done' : 'ended';
    head.append(mark, el('span', 'sp-feed__label', 'Research'), el('span', 'sp-feed__meta', researchMeta(view)));
    const line = el('p', 'sp-feed__researchline');
    line.setAttribute('role', 'status');
    line.textContent = running ? this.researchLine || 'Planning searches…' : researchDone(view);
    node.append(head, line);
    this.research = line;
    return node;
  }

  private paintResearchProgress(event: Record<string, unknown>): void {
    const parts: string[] = [];
    const phase = typeof event.phase === 'string' ? event.phase : '';
    if (phase) parts.push(phase.replace(/_/g, ' '));
    if (typeof event.round === 'number') parts.push(`round ${event.round}`);
    if (typeof event.totalSources === 'number') parts.push(`${event.totalSources} source${event.totalSources === 1 ? '' : 's'}`);
    if (typeof event.message === 'string' && event.message.trim()) parts.push(event.message.trim());
    this.researchLine = parts.join(' · ');
    if (this.research && this.view?.steps.find((s) => s.id === 'research')?.state === 'active') {
      this.research.textContent = this.researchLine || 'Researching…';
    }
  }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function structureKey(view: SuperPlanRunView): string {
  const transcripts = view.transcripts.map((t) => `${t.key}:${t.attempts}:${t.live ? 1 : 0}:${t.outcome ?? ''}:${t.label}`).join('|');
  const notes = view.timeline.filter((row) => NOTE_KINDS.has(row.kind)).length;
  const research = view.steps.find((s) => s.id === 'research');
  return `${transcripts}#${notes}#${research?.state ?? ''}:${research?.detail ?? ''}`;
}

/** The stage brief and "continue" nudges are internal; the answers show as tool results. */
function visibleMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.filter((message) => message.role !== 'user' && message.role !== 'system');
}

function sectionMeta(ref: SuperPlanTranscriptRef): string {
  const bits: string[] = [];
  if (ref.startedAt) bits.push(formatTimeOfDay(ref.startedAt));
  if (ref.live) bits.push('running');
  else if (ref.startedAt && ref.endedAt) bits.push(formatClock(ref.endedAt - ref.startedAt));
  if (ref.attempts > 1) bits.push(`${ref.attempts} attempts`);
  if (!ref.live && ref.outcome && ref.outcome !== 'ok') {
    bits.push({ rejected: 'did not pass checks', crashed: 'failed', timeout: 'timed out', interrupted: 'interrupted', paused: 'paused', cancelled: 'cancelled', superseded: 'replaced' }[ref.outcome] ?? ref.outcome);
  }
  return bits.join(' · ');
}

function requestNode(view: SuperPlanRunView): HTMLElement {
  const node = el('div', 'sp-feed__request');
  const head = el('div', 'sp-feed__notehead');
  if (view.createdAt) head.append(el('span', 'sp-feed__at', formatTimeOfDay(view.createdAt)));
  head.append(el('span', 'sp-feed__notelabel', 'Your request'));
  const text = el('p', 'sp-feed__requesttext', view.prompt);
  node.append(head, text);
  return node;
}

function noteNode(row: SuperPlanTimelineRow): HTMLElement {
  const node = el('div', `sp-feed__note sp-feed__note--${row.kind}${row.tone ? ` is-${row.tone}` : ''}`);
  const head = el('div', 'sp-feed__notehead');
  head.append(el('span', 'sp-feed__at', formatTimeOfDay(row.at)), el('span', 'sp-feed__notelabel', row.label));
  node.append(head);
  if (row.detail) node.append(el(row.kind === 'checkpoint' ? 'blockquote' : 'p', 'sp-feed__notedetail', row.detail));
  return node;
}

function researchMeta(view: SuperPlanRunView): string {
  const step = view.steps.find((s) => s.id === 'research');
  const bits: string[] = [];
  if (step?.startedAt) bits.push(formatTimeOfDay(step.startedAt));
  if (step?.state === 'active') bits.push('running');
  else if (step?.startedAt && step.endedAt) bits.push(formatClock(step.endedAt - step.startedAt));
  return bits.join(' · ');
}

function researchDone(view: SuperPlanRunView): string {
  const artifact = view.artifacts.research;
  if (artifact?.empty) return 'Nothing useful was found; the plan drafts from the spec alone.';
  if (artifact) return 'Report saved. Read it in the Research tab.';
  const step = view.steps.find((s) => s.id === 'research');
  if (step?.state === 'skipped') return step.detail === 'skipped' ? 'Skipped.' : 'Skipped after repeated errors.';
  if (step?.state === 'paused') return 'Paused.';
  return '';
}

function startingCopy(view: SuperPlanRunView): string {
  if (view.status === 'paused') return 'Paused before the first stage started.';
  if (view.startFailure) return 'The first stage could not start yet.';
  return 'Starting the first stage…';
}
