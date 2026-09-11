import type { Chat } from '../types';
import { findChatById } from '../state/sessions';
import { isHiddenTranscriptUserMessage } from '../chat/hidden-transcript-user-messages';
import { getMainTurnActivity, subscribeMainTurnActivity } from '../chat/main-turn-activity';
import { subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { subscribeSuperPlanEvents } from '../chat/super-plan/events';
import { clearSuperPlanLiveTranscript, getSuperPlanLiveTranscript, observeSuperPlanTranscript, subscribeSuperPlanTranscript } from '../chat/super-plan/live-transcript';
import { renderTranscriptView } from './transcript-view';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { renderThoughtsToggle, updateThoughtsToggleSegments } from './thought-bubbles';
import { attachStreamStatus, type StreamingStatusHandle, type StreamPhase } from './stream-status';
import { humanizeToolName } from './tool-messages';
import { CHAT_VIEW_CHANGED, getChatView } from '../appearance/chat-view';

/** The same prose, thoughts, tools and runtime instrumentation as chat. */
export class SuperPlanTranscript {
  private readonly history = document.createElement('div');
  private readonly live = document.createElement('div');
  private readonly thoughts = document.createElement('div');
  private readonly prose = document.createElement('div');
  private readonly tool = document.createElement('div');
  private readonly status: StreamingStatusHandle;
  private readonly unsubscribes: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private signature = '';
  private lastProse = '';
  private lastReasoning = '';
  private destroyed = false;
  private fetchVersion = 0;
  private remote: Array<{ stage: string; messages: unknown[] }> = [];
  private readonly runId: string | undefined;

  constructor(private readonly host: HTMLElement, private readonly chatId: string) {
    this.runId = findChatById(chatId)?.superPlanRunId;
    host.className = 'sp-transcript transcript-view__body chat-thread';
    this.live.className = 'sp-transcript__live';
    this.prose.className = 'transcript-view__assistant';
    this.tool.className = 'tool-start-indicator';
    this.tool.setAttribute('role', 'status');
    this.status = attachStreamStatus(this.live);
    this.live.append(this.tool, this.thoughts, this.prose);
    host.replaceChildren(this.history, this.live);
    this.unsubscribes.push(
      subscribeMainTurnActivity(() => this.schedule()),
      subscribeChatStreamActivity((id) => { if (id === chatId) this.schedule(); }),
      subscribeChatStreamEnd((id) => { if (id === chatId) this.schedule(); }),
      subscribeSuperPlanTranscript((key) => { if (key === chatId || key === this.runId) this.schedule(); }),
    );
    const viewChanged = (): void => { this.signature = ''; this.schedule(); };
    window.addEventListener(CHAT_VIEW_CHANGED, viewChanged);
    this.unsubscribes.push(() => window.removeEventListener(CHAT_VIEW_CHANGED, viewChanged));
    if (this.runId && typeof EventSource !== 'undefined') {
      this.unsubscribes.push(subscribeSuperPlanEvents(this.runId, (type, data) => {
        if (type === 'live' && ['review', 'polish'].includes(data.stage) && data.event) {
          observeSuperPlanTranscript(this.runId!, data.event);
          if (data.event.type === 'round_end') void this.loadRemote();
        }
        if (type === 'snapshot' || (type === 'event' && data.type === 'stage.ended')) void this.loadRemote();
        if (type === 'event' && ['stage.started', 'stage.ended', 'run.stopped', 'run.finished', 'run.cancelled'].includes(data.type)) clearSuperPlanLiveTranscript(this.runId!);
        this.schedule();
      }));
      void this.loadRemote();
    }
    this.paint();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.status.dispose();
  }

  schedule(): void {
    if (this.destroyed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.paint(); }, 80);
  }

  private async loadRemote(): Promise<void> {
    const version = ++this.fetchVersion;
    try {
      const response = await fetch(`/api/super-plan/${encodeURIComponent(this.runId!)}/transcripts`);
      if (!response.ok) return;
      const body = await response.json();
      if (this.destroyed || version !== this.fetchVersion) return;
      this.remote = Array.isArray(body.transcripts) ? body.transcripts : [];
      this.schedule();
    } catch { /* Live chat and previously loaded checkpoints remain readable. */ }
  }

  private paint(): void {
    const chat = findChatById(this.chatId);
    if (!chat || this.destroyed) return;
    const scroller = this.host.closest('.sp-runbody');
    const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const messages = chat.history.filter((message) => !(message.role === 'user' && isHiddenTranscriptUserMessage(message)));
    const signature = JSON.stringify([messages, this.remote]);
    if (signature !== this.signature) {
      this.signature = signature;
      const disclosures = new Map([...this.history.querySelectorAll<HTMLDetailsElement>('details[data-section]')].map((node) => [node.dataset.section, node.open]));
      this.history.replaceChildren();
      const prompt = document.createElement('div');
      prompt.className = 'transcript-view__user';
      prompt.textContent = chat.superPlanView?.prompt ?? '';
      if (!messages.some((message) => message.role === 'user')) this.history.append(prompt);
      const working = document.createElement('details');
      working.className = 'sp-transcript__working';
      working.dataset.section = 'work';
      working.open = getChatView() === 'full' || (disclosures.get('work') ?? false);
      const summary = document.createElement('summary');
      summary.textContent = chat.superPlanView?.finished ? 'Worked' : 'Working';
      const body = document.createElement('div');
      renderTranscriptView(body, messages);
      this.paintMarkdown(body);
      const final = body.lastElementChild?.matches('.transcript-view__assistant-turn') ? body.lastElementChild : null;
      working.append(summary, body);
      this.history.append(working);
      if (final) this.history.append(final);
      working.hidden = !body.childElementCount;
      for (const transcript of this.remote) {
        const section = document.createElement('details');
        section.className = 'sp-transcript__working';
        section.dataset.section = transcript.stage;
        section.open = getChatView() === 'full' || (disclosures.get(transcript.stage) ?? false);
        const title = document.createElement('summary');
        title.textContent = transcript.stage === 'review' ? 'Review' : 'Polish';
        const content = document.createElement('div');
        renderTranscriptView(content, transcript.messages);
        this.paintMarkdown(content);
        section.append(title, content);
        this.history.append(section);
      }
    }
    const summary = this.history.querySelector('summary');
    if (summary) summary.textContent = chat.superPlanView?.finished ? 'Worked' : 'Working';
    this.paintLive(chat);
    if (atBottom && scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  private paintMarkdown(body: HTMLElement): void {
    for (const prose of body.querySelectorAll<HTMLElement>('.transcript-view__assistant')) {
      setAssistantBubbleContent(prose, prose.textContent ?? '');
    }
  }

  private paintLive(chat: Chat): void {
    const view = chat.superPlanView;
    const activity = getMainTurnActivity(chat.id);
    const delegated = view?.activeStage === 'grill' || view?.activeStage === 'draft1' || view?.activeStage === 'draft2';
    const live = getSuperPlanLiveTranscript(delegated ? chat.id : this.runId ?? '');
    this.live.hidden = Boolean(view?.finished || view?.paused || view?.cancelled || view?.gate || view?.stages[view.activeStage]?.status === 'error');
    const phase = (delegated ? activity?.phase : undefined) ?? live?.phase ?? 'generating';
    const streamPhase: StreamPhase = live?.phase === 'prompt_processing' ? 'prompt_processing' : phase === 'loading_model' || phase === 'thinking' ? phase : 'generating';
    this.status.setPhase(this.live.hidden || phase === 'tools' ? 'done' : streamPhase);
    this.status.setRuntimeDetail(this.live.hidden ? null : live?.detail ?? null);
    this.tool.hidden = phase !== 'tools' || this.live.hidden;
    this.tool.textContent = `Calling ${humanizeToolName(activity?.currentTool || live?.tool || 'tool')}…${live?.detail ? ` ${live.detail}` : ''}`;
    const text = live?.text ?? '';
    if (text !== this.lastProse) {
      this.lastProse = text;
      setAssistantBubbleContent(this.prose, text, { streaming: true });
    }
    const reasoning = live?.reasoning ?? '';
    if (reasoning !== this.lastReasoning) {
      this.lastReasoning = reasoning;
      if (!reasoning) this.thoughts.replaceChildren();
      else if (this.thoughts.childElementCount) updateThoughtsToggleSegments(this.thoughts, [reasoning]);
      else renderThoughtsToggle(this.thoughts, [reasoning], { pulse: true });
    }
  }
}
