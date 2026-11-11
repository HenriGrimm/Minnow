import '../../styles/graphite-context-surfaces.css';
import { cancelSubAgentAndWait, hydrateSubAgentRunsForParentChat, hydrateSubAgentTranscript, listSubAgentRunsForParentChat } from '../../agents/orchestrator';
import { subscribeSubAgentRuns } from '../../agents/sub-agent-events';
import type { SubAgentRun } from '../../agents/types';
import { isPairedDevice } from '../../api/session-token';
import { openExternalUrl } from '../../api/remote-admin';
import { formatWorkDuration } from '../../chat/transcript-turns';
import { setEmbeddedManagedChatView, subscribeManagedChatMetadata } from '../../chat/managed-chat-view';
import { isChatStreaming, subscribeChatStreamActivity } from '../../chat/streaming-state';
import { parseMarkdownBlocks, parseTaskItems } from '../../issues/markdown-blocks';
import { findStatus } from '../../issues/taxonomy';
import { resolveChatWorktreeRoot } from '../../state/chat-worktree';
import { prMerge, prView, type PullRequestDetail } from '../../state/forge-api';
import { findIssueById } from '../../state/issues-store';
import { getIssuesTaxonomySync } from '../../state/issues-taxonomy-store';
import { ensureChatHistoryLoaded, findChatById, sessionState } from '../../state/sessions';
import { getWorkspacePath } from '../../state/workspace';
import type { Chat, IssueCard, PersistedSubAgentRun } from '../../types';
import { setAssistantBubbleContent } from '../../markdown/renderer';
import { appConfirm } from '../app-dialog';
import { createIcon, type IconName } from '../icon';
import { chatGitState, subscribeSidebarGitState } from '../sidebar-git-state';
import { createEmbeddedChatTranscript, readEmbeddedChatLive } from '../embedded-chat-transcript';
import { createLegacySubAgentTranscript } from '../sub-agent-conversation';
import { subAgentTranscriptLiveFromRun } from '../sub-agent-live-status';
import { findThreadIssue } from '../thread-card';
import { showToast } from '../toast';
import { createGraphiteSideChat } from './graphite-side-chat';
import type { SurfaceAvailability, SurfaceContext } from './surface-registry';
import type { SurfaceId } from './surface-state';
import { isCurrentSurfaceChat, refreshSurfacePanels, registerSurface } from './surfaces-column';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function action(label: string, run: () => void, icon?: IconName): HTMLButtonElement {
  const node = el('button', 'graphite-surface-action');
  node.type = 'button';
  if (icon) node.append(createIcon(icon, { size: 14 }));
  node.append(label);
  node.addEventListener('click', run);
  return node;
}

function status(text: string): HTMLElement {
  const node = el('p', 'graphite-surface-status', text);
  node.setAttribute('role', 'status');
  return node;
}

function isCurrent(chat: Chat): boolean {
  return isCurrentSurfaceChat(chat.id);
}

function openIssue(issue: IssueCard): void {
  void import('../issues-page').then(({ openIssues }) => openIssues({ issueId: issue.id }));
}

function issueFor({ chat, target }: SurfaceContext): IssueCard | undefined {
  const issue = typeof target === 'string' ? findIssueById(target) : undefined;
  if (issue && (issue.chatIds?.includes(chat.id) || issue.boardChatId === chat.id || issue.agent?.chatId === chat.id)) return issue;
  return findThreadIssue(chat);
}

function issueSurface(context: SurfaceContext): HTMLElement {
  const root = el('div', 'graphite-context-surface');
  const issue = issueFor(context);
  if (!issue) {
    root.append(status('No linked issue'));
    return root;
  }
  const meta = el('div', 'graphite-context-surface__meta');
  meta.append(el('code', '', issue.id), '·', findStatus(getIssuesTaxonomySync(), issue.status)?.label ?? issue.status,
    action('Open in Issues', () => openIssue(issue), 'externalLink'));
  const prose = el('div', 'graphite-context-surface__prose');
  const blocks = parseMarkdownBlocks(issue.description);
  const heading = blocks.findIndex(block => block.kind === 'heading' &&
    /^#{1,6}\s+(done when|acceptance criteria)\s*#*\s*$/i.test(block.source));
  const last = heading < 0 ? -1 : blocks.findIndex((block, index) => index > heading &&
    block.kind === 'heading' && (block.level ?? 6) <= (blocks[heading].level ?? 6));
  const criteria = heading < 0 ? [] : blocks.slice(heading + 1, last < 0 ? undefined : last).flatMap(parseTaskItems);
  const hasChecklistOnly = criteria.length > 0 &&
    blocks.slice(heading + 1, last < 0 ? undefined : last).every(block => block.kind === 'task-list' || block.kind === 'blank');
  const description = hasChecklistOnly
    ? [issue.description.slice(0, blocks[heading].start), last < 0 ? '' : issue.description.slice(blocks[last].start)].join('\n\n').trim()
    : issue.description;
  setAssistantBubbleContent(prose, description || (hasChecklistOnly ? '' : 'No description'));
  root.append(meta, el('h2', '', issue.title));
  if (description || !hasChecklistOnly) root.append(prose);
  if (hasChecklistOnly) {
    const checklist = el('ul', 'graphite-context-surface__list');
    for (const item of criteria) {
      const row = el('li', 'graphite-context-surface__checklist-row');
      const icon = createIcon(item.checked ? 'statusPass' : 'statusPending', { size: 14 });
      row.dataset.state = item.checked ? 'success' : 'pending';
      row.append(icon, el('span', 'visually-hidden', item.checked ? 'Complete: ' : 'Incomplete: '), item.text);
      checklist.append(row);
    }
    root.append(el('h3', '', 'Done when'), checklist);
  }
  return root;
}

function prNumber({ chat, target }: SurfaceContext): number | undefined {
  if (typeof target === 'number' && Number.isSafeInteger(target) && target > 0) return target;
  return chatGitState(chat, chat.workspacePath || getWorkspacePath()).prNumber;
}

function durationLabel(start: string | null | undefined, end: string | null | undefined, style: 'work' | 'clock'): string {
  if (!start) return '';
  const elapsed = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(elapsed) || elapsed < 0) return '';
  if (style === 'work') return formatWorkDuration(elapsed);
  const seconds = Math.floor(elapsed / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const PENDING_CHECK = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'REQUESTED', 'WAITING', 'EXPECTED']);
const CHECK_DISPLAY = {
  success: ['statusPass', 'Passed'], skipped: ['statusSkip', 'Skipped'],
  failure: ['statusFail', 'Failed'], running: ['statusRunning', 'Running'],
} satisfies Record<string, [IconName, string]>;

function prCheckState(check: PullRequestDetail['statusChecks'][number]): keyof typeof CHECK_DISPLAY {
  const conclusion = check.conclusion.toUpperCase();
  const phase = check.status.toUpperCase();
  if (conclusion === 'SUCCESS') return 'success';
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'skipped';
  if (PENDING_CHECK.has(conclusion) || PENDING_CHECK.has(phase)) return 'running';
  return conclusion || phase === 'COMPLETED' ? 'failure' : 'running';
}

function mergeBlock(pr: PullRequestDetail): string {
  if (isPairedDevice()) return 'Merge from the host computer';
  if (pr.draft) return 'Draft pull request';
  if (pr.state.toUpperCase() !== 'OPEN') return pr.state.toUpperCase() === 'MERGED' ? 'Merged' : 'Pull request is closed';
  if (pr.checks === 'pending') {
    const count = pr.statusChecks.filter(check => prCheckState(check) === 'running').length;
    return count > 0 ? `${count} check${count === 1 ? '' : 's'} still running` : 'Waiting for checks';
  }
  if (pr.checks === 'failure') return 'Checks failed';
  if (pr.mergeable.toUpperCase() === 'CONFLICTING') return 'Resolve merge conflicts';
  if (pr.reviewDecision?.toUpperCase() === 'CHANGES_REQUESTED') return 'Changes requested';
  if (pr.reviewDecision?.toUpperCase() === 'REVIEW_REQUIRED') return 'Review required';
  if (pr.mergeStateStatus?.toUpperCase() === 'BEHIND') return 'Update the branch before merging';
  if (['BLOCKED', 'DIRTY', 'DRAFT', 'UNKNOWN'].includes(pr.mergeStateStatus?.toUpperCase())) return 'Merge requirements are not met';
  if (pr.mergeable.toUpperCase() !== 'MERGEABLE') return 'Checking merge eligibility';
  if (!pr.headRefOid || !/^[a-f\d]{40}$/i.test(pr.headRefOid)) return 'Cannot verify pull request head';
  return '';
}

function prSurface(context: SurfaceContext): HTMLElement | ContextSurfaceView {
  const root = el('div', 'graphite-context-surface graphite-context-surface--pr');
  const number = prNumber(context);
  if (!number) {
    root.append(status('No pull request yet'));
    return root;
  }
  const cwd = resolveChatWorktreeRoot(context.chat) ?? context.chat.workspacePath;
  const pending = status('Loading pull request…');
  root.append(pending);
  let visible = false;
  let loading = false;
  let merging = false;
  let signature = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  const openSourceControl = () => {
    void import('../source-control-center').then(({ openSourceControlCenter }) => {
      if (isCurrent(context.chat)) return openSourceControlCenter({ section: 'pulls', cwd });
    });
  };
  function render(pr: PullRequestDetail): void {
    const explanation = mergeBlock(pr);
    const nextSignature = JSON.stringify([pr.title, pr.url, pr.state, pr.draft, pr.headRef, pr.baseRef,
      pr.headRefOid, explanation, pr.statusChecks]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const meta = el('div', 'graphite-context-surface__meta');
    meta.append(el('code', '', `#${pr.number}`), '·', pr.draft ? 'Draft' : pr.state.charAt(0) + pr.state.slice(1).toLowerCase());
    try {
      const url = new URL(pr.url);
      if (url.protocol === 'https:') {
        const external = action('GitHub', () => openExternalUrl(url.href));
        external.append(createIcon('externalLink', { size: 14 }));
        meta.append(external);
      }
    } catch {
      // The local PR remains accessible through Source Control.
    }
    const passed = pr.statusChecks.filter(check => prCheckState(check) === 'success').length;
    const checks = el('ul', 'graphite-context-surface__list');
    for (const check of pr.statusChecks) {
      const state = prCheckState(check);
      const [tone, details] = CHECK_DISPLAY[state];
      const row = el('li', 'graphite-context-surface__row');
      row.dataset.state = state;
      row.title = details;
      const elapsed = durationLabel(check.startedAt, check.completedAt, 'work');
      row.append(createIcon(tone, { size: 14 }), el('span', 'visually-hidden', `${details}: `), el('span', 'graphite-context-surface__check-name', check.name));
      if (elapsed) row.append(el('code', '', elapsed));
      checks.append(row);
    }
    const feedback = status('');
    const merge = action('Squash and merge', () => {
      if (!visible || !isCurrent(context.chat) || merging || !pr.headRefOid) return;
      merging = true;
      merge.disabled = true;
      void (async () => {
        try {
          const ok = await appConfirm(`Squash and merge #${pr.number} into ${pr.baseRef}?`, {
            title: 'Squash and merge', confirmLabel: 'Squash and merge',
          });
          if (!ok || !visible || !isCurrent(context.chat)) return;
          const fresh = await prView({ cwd, number: pr.number });
          if (!visible || !isCurrent(context.chat)) return;
          if (!fresh.ok || !fresh.pr) throw new Error(fresh.error || 'Could not recheck pull request');
          if (fresh.pr.url !== pr.url || fresh.pr.headRef !== pr.headRef || fresh.pr.baseRef !== pr.baseRef ||
            fresh.pr.headRefOid !== pr.headRefOid) {
            throw new Error('The pull request changed. Reopen it to review the new state.');
          }
          const block = mergeBlock(fresh.pr);
          if (block) { render(fresh.pr); return; }
          const result = await prMerge({ cwd, number: pr.number, method: 'squash', expectedHeadOid: pr.headRefOid });
          if (!result.ok) throw new Error(result.error || 'Could not merge the pull request');
          if (isCurrent(context.chat)) await load();
        } catch (error) {
          if (isCurrent(context.chat)) feedback.textContent = error instanceof Error ? error.message : 'Could not merge the pull request';
        } finally {
          merging = false;
          merge.disabled = Boolean(explanation);
        }
      })();
    }, 'gitMerge');
    merge.classList.add('graphite-surface-action--primary');
    merge.disabled = Boolean(explanation);
    merge.title = explanation || 'Squash and merge after confirmation';
    const footer = el('div', 'graphite-context-surface__footer');
    footer.append(merge);
    if (explanation) footer.append(explanation);
    const summary = pr.statusChecks.length ? `${passed} of ${pr.statusChecks.length} passed` : 'None configured';
    root.replaceChildren(meta, el('h2', '', pr.title), el('code', 'graphite-context-surface__refs', `${pr.headRef} → ${pr.baseRef}`),
      el('h3', '', `Checks · ${summary}`), checks, footer, feedback);
  }
  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const result = await prView({ cwd, number: number! });
      if (!visible || !isCurrent(context.chat)) return;
      if (result.ok && result.pr) render(result.pr);
      else if (!signature) root.replaceChildren(status(result.error || 'Could not load pull request'), action('Retry', () => void load()), action('Open Source Control', openSourceControl));
    } finally {
      loading = false;
    }
  }
  function setVisible(next: boolean): void {
    if (visible === next) return;
    visible = next;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (visible) {
      void load();
      timer = setInterval(() => { if (!merging && !document.hidden) void load(); }, 20_000);
    }
  }
  return { root, setVisible, dispose: () => setVisible(false) };
}

function getAgentRuns(chat: Chat) {
  const runs = new Map<string, SubAgentRun | PersistedSubAgentRun>((chat.subAgentRuns ?? []).map(run => [run.runId, run]));
  for (const run of listSubAgentRunsForParentChat(chat.id)) runs.set(run.runId, run);
  return [...runs.values()];
}

function agentsSurface({ chat, target }: SurfaceContext): ContextSurfaceView {
  const root = el('div', 'graphite-context-surface graphite-context-surface--agents');
  const list = el('div', 'graphite-context-surface__agent-list');
  const detail = el('div', 'graphite-context-surface__agent-detail');
  const footer = el('div', 'graphite-context-surface__agent-footer');
  const header = el('div', 'graphite-context-surface__agent-heading');
  const content = el('div', 'graphite-chat-panel__scroll');
  const notice = status('');
  const body = el('div', 'chat-thread graphite-chat-panel__transcript');
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', 'Agent transcript');
  content.append(body, notice);
  detail.append(header, content);
  const transcript = createEmbeddedChatTranscript(body, content);
  const renderLegacy = createLegacySubAgentTranscript(transcript, chat.workspacePath ?? '');
  root.append(list, detail, footer);
  let selected = typeof target === 'string' ? target : '';
  let mountedRun = '';
  let visible = false;
  let disposed = false;
  let frame: number | null = null;
  let listKey = '';
  let detailKey = '';
  let childChatId = '';
  let selectedRunStatus: SubAgentRun['status'] | undefined;
  const pendingStops = new Set<string>();

  function draw(): void {
    if (disposed) return;
    const runs = getAgentRuns(chat);
    const current = runs.find(run => run.runId === selected) ?? runs[0];
    if (!current) {
      notice.textContent = 'No subagents yet';
      return;
    }
    selected = current.runId;
    selectedRunStatus = current.status;
    const nextListKey = JSON.stringify(runs.map(run => [run.runId, run.title, run.task, run.status, run.startedAt, run.endedAt]));
    if (listKey !== nextListKey && !list.contains(document.activeElement)) {
      listKey = nextListKey;
      list.replaceChildren();
      for (const run of runs) {
        const row = action('', () => {
          selected = run.runId;
          draw();
          if (!run.childChatId) void hydrateSubAgentTranscript(run.runId).then(draw);
        });
        row.dataset.runId = run.runId;
        row.dataset.state = run.status;
        const statusIcon: IconName = run.status === 'completed' ? 'statusPass' : run.status === 'failed' ? 'statusFail'
          : run.status === 'cancelled' ? 'stopCircle' : run.status === 'running' ? 'statusRunning' : 'statusPending';
        const elapsed = durationLabel(run.startedAt, run.endedAt, 'clock');
        row.append(createIcon(statusIcon, { size: 14 }), el('code', 'graphite-context-surface__role', run.type),
          el('span', 'graphite-context-surface__agent-title', run.title || run.task || run.type));
        if (elapsed) row.append(el('code', 'graphite-context-surface__agent-time', elapsed));
        row.setAttribute('aria-label', `${run.title || run.task || run.type}, ${run.status}`);
        list.append(row);
      }
    }
    for (const row of list.querySelectorAll('button')) {
      const pressed = String(row.dataset.runId === selected);
      if (row.getAttribute('aria-pressed') !== pressed) row.setAttribute('aria-pressed', pressed);
    }
    const model = current.resolvedModel?.id || current.modelId;
    const key = JSON.stringify([selected, current.type, current.title, current.status, model, current.childChatId, pendingStops.has(selected)]);
    if (key !== detailKey) {
      detailKey = key;
      drawDetails(current, model);
    }
    if (mountedRun !== selected) {
      mountedRun = selected;
      transcript.reset();
    }
    const nextChild = current.childChatId ?? '';
    if (nextChild !== childChatId) {
      childChatId = nextChild;
      if (visible) setEmbeddedManagedChatView(childChatId);
      if (childChatId && findChatById(childChatId)?.historyLoaded === false) {
        void ensureChatHistoryLoaded(childChatId).then(draw, draw);
      }
    }
    const child = childChatId ? findChatById(childChatId) : undefined;
    if (childChatId) {
      notice.textContent = current.error || (!child || child.historyLoaded === false ? 'Loading conversation…' : '');
      if (!child || child.historyLoaded === false) return;
      paintChildTranscript(child);
      return;
    }
    const liveRun = listSubAgentRunsForParentChat(chat.id).find(run => run.runId === selected);
    const live = liveRun && subAgentTranscriptLiveFromRun(liveRun, true);
    renderLegacy(current, live);
    notice.textContent = current.error || (current.status === 'cancelled' ? 'Stopped. Finished steps are kept.' : '');
  }

  function paintChildTranscript(child: Chat): void {
    const live = isChatStreaming(child.id);
    const execution = child.agentExecution?.status ?? selectedRunStatus;
    transcript.sync(child, live ? readEmbeddedChatLive(child.id) : undefined,
      execution === 'recovery_required' ? 'paused'
        : !live && (execution === 'stopped' || execution === 'cancelled' || execution === 'failed') ? 'stopped' : undefined);
  }

  function drawDetails(current: SubAgentRun | PersistedSubAgentRun, model?: string): void {
    const statusName = current.status === 'cancelled' ? 'Stopped'
      : current.status.charAt(0).toUpperCase() + current.status.slice(1);
    header.replaceChildren(el('code', 'graphite-context-surface__role', current.type),
      el('h2', '', current.title || current.type), el('span', 'graphite-context-surface__agent-state', statusName));
    header.dataset.state = current.status;
    footer.replaceChildren(el('code', 'graphite-context-surface__agent-model', model || ''));
    if (!isPairedDevice() && (current.status === 'queued' || current.status === 'running')) {
      const runId = current.runId;
      const stop = action(pendingStops.has(runId) ? 'Stopping…' : 'Stop agent', () => {
        if (!isCurrent(chat) || pendingStops.has(runId)) return;
        pendingStops.add(runId);
        draw();
        void cancelSubAgentAndWait(runId, chat.id).catch(error => {
          showToast(error instanceof Error ? error.message : 'Could not stop this agent', 'error');
        }).finally(() => {
          pendingStops.delete(runId);
          draw();
        });
      });
      stop.disabled = pendingStops.has(runId);
      footer.append(stop);
    }
    if (current.childChatId) {
      const child = current.childChatId;
      footer.append(action('Open as thread', () => {
        void import('../../os/chat-launch').then(({ launchCodeWithChat }) => launchCodeWithChat(child));
      }));
    }
  }
  function scheduleDraw(): void {
    if (!visible || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (visible) draw();
    });
  }
  const unsubscribe = subscribeSubAgentRuns(run => {
    if (run.parentChatId === chat.id) scheduleDraw();
  });
  const unsubscribeMetadata = subscribeManagedChatMetadata(id => { if (id === childChatId) scheduleDraw(); });
  const unsubscribeStream = subscribeChatStreamActivity(id => {
    if (!visible || id !== childChatId) return;
    const child = findChatById(id);
    if (child && child.historyLoaded !== false) paintChildTranscript(child);
  });
  list.addEventListener('focusout', scheduleDraw);
  draw();
  void hydrateSubAgentRunsForParentChat(chat.id).then(async () => {
    if (disposed) return;
    draw();
    if (selected && !childChatId) await hydrateSubAgentTranscript(selected);
    draw();
  });
  return {
    root,
    setVisible(next) {
      visible = next;
      setEmbeddedManagedChatView(visible ? childChatId : '');
      if (visible) draw();
    },
    dispose: () => {
      if (visible) setEmbeddedManagedChatView('');
      disposed = true;
      unsubscribe();
      unsubscribeMetadata();
      unsubscribeStream();
      transcript.dispose();
      if (frame !== null) cancelAnimationFrame(frame);
    },
  };
}

interface ContextSurfaceView {
  root: HTMLElement;
  dispose: () => void;
  setVisible?: (visible: boolean) => void;
}

function registerContext(
  id: SurfaceId,
  build: (context: SurfaceContext) => HTMLElement | ContextSurfaceView,
  availability?: (context: SurfaceContext) => SurfaceAvailability,
): void {
  let entry: { chat: Chat; target: unknown; root: HTMLElement } & Partial<ContextSurfaceView> | undefined;
  registerSurface(id, {
    availability,
    render(context) {
      if (entry?.chat === context.chat && entry.target === context.target) return entry.root;
      entry?.dispose?.();
      const view = build(context);
      entry = { chat: context.chat, target: context.target, ...(view instanceof HTMLElement ? { root: view } : view) };
      return entry.root;
    },
    setVisible(visible, context) {
      if (entry?.chat === context.chat && entry.target === context.target) entry.setVisible?.(visible);
    },
  });
}

export function mountGraphiteContextSurfaces(): void {
  registerContext('issue', issueSurface, context => {
    const issue = issueFor(context);
    return issue ? { available: true, hint: issue.id } : { available: false, reason: 'No linked issue' };
  });
  registerContext('pr', prSurface, context => {
    const number = prNumber(context);
    return number ? { available: true, hint: `#${number}` } : { available: false, reason: 'No pull request yet' };
  });
  registerContext('side', ({ chat }) => createGraphiteSideChat(chat), () => isPairedDevice()
    ? { available: false, reason: 'Side chat runs on the host computer' } : { available: true });
  registerContext('agents', agentsSurface, ({ chat }) => {
    const count = getAgentRuns(chat).length;
    return count ? { available: true, hint: String(count) } : { available: false, reason: 'No subagents yet' };
  });
  subscribeSidebarGitState(refreshSurfacePanels);
  subscribeSubAgentRuns(run => {
    if (run.parentChatId === sessionState?.activeId) refreshSurfacePanels();
  });
}
