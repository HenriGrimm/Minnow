import { listActiveSubAgentRuns, cancelSubAgent } from '../agents/orchestrator';
import { getSubAgentTypeConfig } from '../agents/sub-agent-config';
import { subscribeSubAgentRuns } from '../agents/sub-agent-events';
import { getContextBudget } from '../chat/context-usage';
import { listMainTurnActivity, subscribeMainTurnActivity } from '../chat/main-turn-activity';
import { subscribeChatStreamEnd } from '../chat/streaming-state';
import { listTitleJobActivity, subscribeTitleJobActivity } from '../chat/titles/activity-events';
import { abortChatTitleGeneration } from '../chat/titles/inflight';
import { stopGeneration } from '../chat/stop-generation';
import { isAppAvailable } from '../os/app-preferences';
import { openNotificationTarget } from '../notifications/navigate';
import { loadNotificationPrefs, saveNotificationPref, subscribeNotificationPrefs } from '../notifications/prefs';
import { getNotifications, markNotificationRead, resolveActivityNotifications, subscribeNotifications } from '../notifications/store';
import { buildAgentActivitySnapshot, type AgentActivityContextFill } from '../state/agent-activity-registry';
import { buildActivityFeed, getRunningAgentCount, type ActivityFeed, type ActivityItem } from '../state/activity-feed';
import { sessionState } from '../state/sessions';
import { sendManagedChatAction } from '../chat/managed-chat-client';
import { subscribeManagedChatMetadata } from '../chat/managed-chat-view';
import { acknowledgeObservedManagedActivity } from '../notifications/acknowledge';
import { getWorkspaceLabel, getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { getViewWorkspacePath } from '../state/view-workspace';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { appConfirm } from './app-dialog';
import { createActivityDropdown } from './activity-dropdown';
import { getChatItemDotContext, resolveChatItemDotState, subscribeChatInputPending } from './chat-item-dot';
import { resolveEffectiveChatModelBinding } from './default-model';
import { iconHtml } from './icon';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import { bindShellOverlayTrigger, openShellOverlay, shellOverlayClosed } from './shell-overlay-state';

let anchor: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;
let view: ReturnType<typeof createActivityDropdown> | null = null;
let open = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let feed: ActivityFeed | null = null;
let lifetime = 0;
let disposeMountedPanel: (() => void) | undefined;
const labels = new Map<string, string>();
const context = new Map<string, AgentActivityContextFill>();

function workspace(): string {
  return getViewWorkspacePath() || getWorkspacePath();
}

function snapshot(): ActivityFeed {
  const chats = sessionState?.chats ?? [];
  const dot = getChatItemDotContext(null);
  const pending = new Set(dot.inputPendingChatIds);
  if (dot.inputPendingChatId) pending.add(dot.inputPendingChatId);
  for (const chat of chats) {
    if (resolveChatItemDotState(chat, dot) === 'needs-input') pending.add(chat.id);
  }
  const live = buildAgentActivitySnapshot({
    nowMs: Date.now(), chats, mainTurns: listMainTurnActivity(), subAgents: listActiveSubAgentRuns(),
    titleJobs: listTitleJobActivity(), questionPendingChatIds: pending, contextByChatId: context,
    resolveSubAgentLabel: (type) => labels.get(type) ?? type,
  });
  return buildActivityFeed({
    chats, live, notifications: getNotifications().filter((record) => isAppAvailable(record.appId)),
    pendingChatIds: pending, workspacePath: workspace(),
  });
}

function canStop(item: ActivityItem): boolean {
  if (item.live?.kind === 'agent_chat') return item.live.canStop === true && Boolean(item.live.executionId);
  return Boolean(item.live || item.status === 'question');
}

function refresh(): void {
  feed = snapshot();
  if (!anchor) return;
  const count = feed.attention.length;
  const agents = getRunningAgentCount(feed);
  if (anchor.dataset.agentCount !== String(agents)) {
    anchor.dataset.agentCount = String(agents);
    anchor.classList.toggle('is-running', agents > 0);
    anchor.innerHTML = agents
      ? `<span class="activity-trigger__wheel" aria-hidden="true"><span class="activity-trigger__ring"></span><span class="activity-trigger__count">${agents > 99 ? '99+' : agents}</span></span>`
      : iconHtml('appAgentActivity', { size: 16 });
  }
  anchor.classList.toggle('has-attention', count > 0);
  anchor.setAttribute('aria-label', `Activity, ${agents} agents running, ${count} need your attention, ${feed.unreadCount} unseen outcomes`);
  anchor.title = 'Activity';
  if (open) view?.render(feed, loadNotificationPrefs(), getWorkspaceLabel() || 'This workspace', [...feed.running, ...feed.background, ...feed.attention].some(canStop));
}

function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 100);
}

function position(): void {
  if (!anchor || !panel || !open) return;
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.maxHeight = `${Math.max(100, window.innerHeight - rect.bottom - 14)}px`;
}

function refreshScheduled(): void {
  if (document.hidden) return;
  void import('../scheduler/notifications-poll').then((module) => module.pollSchedulerNotifications());
}

async function loadDetails(): Promise<void> {
  const version = lifetime;
  const chats = (sessionState?.chats ?? []).filter((chat) => workspacePathsEqual(chat.workspacePath ?? '', workspace()));
  const liveChatIds = new Set(listMainTurnActivity().map((turn) => turn.chatId));
  await Promise.allSettled([
    ...chats.filter((chat) => liveChatIds.has(chat.id)).map(async (chat) => {
      const binding = resolveEffectiveChatModelBinding(chat);
      const budget = await getContextBudget({ chat, modelId: binding.selectValue || chat.modelId || '' });
      if (version === lifetime) context.set(chat.id, { percent: budget.percent, isEstimate: budget.isEstimate });
    }),
    ...[...new Set(listActiveSubAgentRuns().map((run) => run.type))].map(async (type) => {
      const config = await getSubAgentTypeConfig(type);
      if (version === lifetime) labels.set(type, config?.label?.trim() || type);
    }),
  ]);
  if (version === lifetime && open) refresh();
}

export function isAgentActivityPanelOpen(): boolean { return open; }
export function closeAgentActivityPanel(): void { setAgentActivityPanelOpen(false); }
export function toggleAgentActivityPanel(): void { setAgentActivityPanelOpen(!open); }

export function setAgentActivityPanelOpen(next: boolean): void {
  if (!anchor || !panel || open === next) return;
  if (next) openShellOverlay('activity', closeAgentActivityPanel);
  else shellOverlayClosed('activity');
  open = next;
  panel.hidden = !next;
  anchor.setAttribute('aria-expanded', String(next));
  if (next) {
    markPreviewOccluder(panel, 'panel');
    refresh();
    position();
    void loadDetails();
    tickTimer = setInterval(() => { if (!document.hidden) view?.tick(); }, 1000);
    refreshScheduled();
    schedulerTimer = setInterval(refreshScheduled, 5000);
    panel.querySelector<HTMLButtonElement>('button')?.focus();
    void import('../notifications/sound').then((module) => module.unlockNotificationAudio());
  } else {
    unmarkPreviewOccluder(panel);
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function activate(item: ActivityItem, childRunId?: string): Promise<void> {
  closeAgentActivityPanel();
  if (item.chatId) {
    const { launchCodeWithChat } = await import('../os/chat-launch');
    await launchCodeWithChat(item.chatId);
    if (item.requestId) {
      const { focusManagedChatRequest } = await import('./managed-chat-requests');
      await focusManagedChatRequest(item.chatId, item.requestId);
    } else if (item.live?.kind !== 'agent_chat' && (childRunId || item.live?.runId)) {
      const { openSubAgentDrawer } = await import('./sub-agent-drawer');
      openSubAgentDrawer(childRunId || item.live!.runId!, item.chatId);
    }
    return;
  }
  const record = item.notifications.at(-1);
  if (record) await openNotificationTarget(record);
}

export async function stopAgentActivityItem(item: ActivityItem): Promise<void> {
  if (item.live?.kind === 'agent_chat') {
    if (canStop(item)) await sendManagedChatAction(item.chatId!, 'stop', { scope: 'turn', executionId: item.live.executionId });
    return;
  }
  if (item.background && item.chatId) abortChatTitleGeneration(item.chatId);
  else if (item.chatId) stopGeneration(item.chatId, 'user');
  for (const child of item.children) if (child.runId) cancelSubAgent(child.runId, 'user_cancel');
  if (item.live?.runId) cancelSubAgent(item.live.runId, 'user_cancel');
}

async function stop(item?: ActivityItem): Promise<void> {
  if (item) { await stopAgentActivityItem(item); refresh(); return; }
  const accepted = await appConfirm('Stop active turns in this workspace? Each displayed conversation’s current turn and background title jobs will stop. Saved queued messages keep their place.');
  if (!accepted) return;
  const current = snapshot();
  const seen = new Set<string>();
  for (const target of [...current.running, ...current.background, ...current.attention].filter(canStop)) {
    const key = target.live?.executionId ?? target.id;
    if (seen.has(key)) continue;
    seen.add(key); await stopAgentActivityItem(target);
  }
  refresh();
}

export async function acknowledgeAgentActivityItems(items: ActivityItem[]): Promise<void> {
  for (const item of items) {
    if (item.chatId && item.activityCursor) {
      await acknowledgeObservedManagedActivity(item.chatId, item.activityCursor);
    }
    for (const record of item.notifications) markNotificationRead(record.id);
  }
  refresh();
}

/** One workspace-scoped Activity control for live work, actionable alerts, and history. */
export function initAgentActivityMenubar(button: HTMLButtonElement): () => void {
  disposeMountedPanel?.();
  anchor = button;
  button.id = 'btnActivity';
  button.classList.add('activity-trigger');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'activityDropdown');
  const unbind = bindShellOverlayTrigger(button, 'activity');
  panel = document.createElement('section');
  panel.id = 'activityDropdown';
  panel.className = 'activity-dropdown';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Activity');
  panel.hidden = true;
  document.body.append(panel);
  view = createActivityDropdown(panel, {
    open: (item, runId) => { void activate(item, runId).catch(reportError); },
    seen: (items) => { void acknowledgeAgentActivityItems(items).catch(reportError); },
    dismiss: (item) => { void acknowledgeAgentActivityItems([item]).then(() => resolveActivityNotifications(item.notifications.map((record) => record.id))).catch(reportError); },
    stop: (item) => { void stop(item).catch(reportError); },
    mute: () => saveNotificationPref('muted', !loadNotificationPrefs().muted),
    settings: () => {
      closeAgentActivityPanel();
      void import('./settings-page').then((module) => module.openSettings('notifications'));
    },
    retry: async (item) => {
      const record = [...item.notifications].reverse().find((notice) => notice.jobId);
      if (!record?.jobId) return;
      const { runSchedulerJobNow } = await import('../scheduler/client');
      const result = await runSchedulerJobNow(record.jobId);
      if (result && typeof result === 'object' && 'started' in result && result.started === false) throw new Error('The scheduler could not start this job. Open Scheduler to inspect it.');
      resolveActivityNotifications(item.notifications.map((notice) => notice.id));
      refreshScheduled();
    },
  });
  const click = () => toggleAgentActivityPanel();
  const outside = (event: PointerEvent) => {
    if (open && !panel?.contains(event.target as Node) && !button.contains(event.target as Node)) closeAgentActivityPanel();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !open) return;
    event.preventDefault(); closeAgentActivityPanel(); button.focus();
  };
  const visible = () => { if (!document.hidden) refresh(); };
  const subscriptions = [
    subscribeMainTurnActivity(scheduleRefresh), subscribeSubAgentRuns(scheduleRefresh),
    subscribeTitleJobActivity(scheduleRefresh), subscribeChatStreamEnd(scheduleRefresh),
    subscribeChatInputPending(scheduleRefresh), subscribeNotifications(scheduleRefresh),
    subscribeManagedChatMetadata(scheduleRefresh),
    subscribeNotificationPrefs(refresh), subscribeWorkspace(() => { context.clear(); scheduleRefresh(); }),
  ];
  button.addEventListener('click', click);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('resize', position);
  refresh();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime++;
    closeAgentActivityPanel();
    subscriptions.forEach((unsubscribe) => unsubscribe());
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    button.removeEventListener('click', click);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('resize', position);
    view?.destroy(); panel?.remove();
    panel = null; anchor = null; view = null; feed = null;
    context.clear(); labels.clear(); unbind();
    if (disposeMountedPanel === dispose) disposeMountedPanel = undefined;
  };
  disposeMountedPanel = dispose;
  return dispose;
}

function reportError(error: unknown): void {
  void import('./toast').then((module) => module.showToast(error instanceof Error ? error.message : String(error), 'error'));
}

/** Boot refresh after sessions hydrate; subscriptions belong to the menubar lifecycle. */
export function initAgentActivityPanel(): void { scheduleRefresh(); }
export async function refreshAgentActivityPanel(): Promise<void> { refresh(); }
