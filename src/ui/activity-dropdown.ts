import { escapeHtml } from '../lib/format-model-label';
import { formatRelativeTime } from '../notifications/preview';
import type { NotificationPrefs } from '../notifications/types';
import { activityNeedsAttention, getRunningAgentCount, type ActivityFeed, type ActivityItem } from '../state/activity-feed';
import { formatAgentActivityElapsed, formatAgentActivityStatusLine, formatAgentActivityToolRounds } from '../state/agent-activity-registry';
import { iconHtml, type IconName } from './icon';

export interface ActivityDropdownActions {
  open: (item: ActivityItem, childRunId?: string) => void;
  seen: (items: ActivityItem[]) => void;
  dismiss: (item: ActivityItem) => void;
  stop: (item?: ActivityItem) => void;
  mute: () => void;
  settings: () => void;
  retry: (item: ActivityItem) => Promise<void>;
}

function action(label: string, name: string, itemId = '', primary = false): string {
  return `<button type="button" class="activity-action${primary ? ' activity-action--primary' : ''}" data-action="${name}" data-item-id="${escapeHtml(itemId)}">${label}</button>`;
}

function statusIcon(item: ActivityItem): IconName {
  if (item.status === 'question') return 'help';
  if (item.status === 'failed' || item.status === 'blocked') return 'statusFail';
  if (item.status === 'completed') return 'check';
  if (item.status === 'stopped') return 'stop';
  return 'appAgentActivity';
}

function rowHtml(item: ActivityItem, open: boolean): string {
  const id = escapeHtml(item.id);
  const title = escapeHtml(item.title);
  const live = item.live;
  const time = live ? formatAgentActivityElapsed(live.elapsedMs) : item.status === 'running' ? formatAgentActivityElapsed(Date.now() - item.timestamp) : formatRelativeTime(item.timestamp);
  const timer = live ? live.elapsedFrozen ? '' : `data-started-at="${live.startedAtMs}"` : item.status === 'running' ? `data-started-at="${item.timestamp}"` : '';
  const unread = item.unread && !activityNeedsAttention(item) ? '<span class="activity-unread" aria-label="Unseen update"></span>' : '';
  const started = item.notifications.at(-1)?.kind.endsWith('_started');
  const label = item.status === 'question' ? item.requestKind === 'approval' || live?.status === 'pending_approval' ? 'Needs approval' : 'Waiting for your input' : item.status === 'failed' ? 'Failed' : item.status === 'blocked' ? 'Needs review' : item.status === 'stopped' ? 'Stopped' : item.status === 'completed' ? started ? 'Started' : 'Completed' : item.detail;
  const statusLine = item.detail && item.status !== 'running' && item.status !== 'question' ? `${label} · ${item.detail}` : label;
  const primary = item.status === 'question' ? action('Reply / review', 'open', item.id, true) : '';
  const meta = live ? `${escapeHtml(live.modelDisplay)}${live.contextPercent == null ? '' : ` · ${live.contextIsEstimate ? '~' : ''}${Math.round(live.contextPercent)}% context`}` : escapeHtml(item.source);
  const children = item.children.map((child) => `<li><button type="button" data-action="child" data-item-id="${id}" data-run-id="${escapeHtml(child.runId ?? '')}">${iconHtml('appAgentActivity', { size: 14 })}<span>${escapeHtml(child.label)}<small>${escapeHtml(formatAgentActivityStatusLine(child))}${child.toolTurns == null ? '' : ` · ${escapeHtml(formatAgentActivityToolRounds(child))}`}</small></span></button></li>`).join('');
  const nestedNotices = item.notifications.filter((record) => record.kind.startsWith('sub_agent_'));
  const settledChildren = nestedNotices.map((record) => `<li class="activity-child-outcome">${escapeHtml(record.preview)}</li>`).join('');
  const dismiss = activityNeedsAttention(item) && item.status !== 'question' ? action('Dismiss alert', 'dismiss', item.id) : '';
  const retry = item.status === 'failed' && item.notifications.some((record) => record.jobId) ? action('Retry run', 'retry', item.id) : '';
  return `<li class="activity-row activity-row--${item.status}" data-activity-id="${id}">
    <span class="activity-row__icon">${iconHtml(statusIcon(item), { size: 16 })}</span>
    <div class="activity-row__body">
      <div class="activity-row__head"><button type="button" class="activity-row__title" data-action="open" data-item-id="${id}">${title}${unread}</button><span class="activity-row__time" ${timer} ${live ? '' : `data-timestamp="${item.timestamp}"`}>${time}</span></div>
      <p class="activity-row__status">${escapeHtml(statusLine)}</p>
      ${primary || dismiss ? `<div class="activity-row__actions">${primary}${dismiss}</div>` : ''}
      <details class="activity-details" data-detail-id="${id}"${open ? ' open' : ''}>
        <summary>${item.children.length ? `${item.children.length} agent${item.children.length === 1 ? '' : 's'} · ` : ''}${activityNeedsAttention(item) && item.status !== 'question' ? 'Inspect' : 'Details'}</summary>
        ${item.detail && item.detail !== label ? `<p class="activity-details__preview">${escapeHtml(item.detail)}</p>` : ''}
        <p class="activity-details__meta">${meta}</p>
        ${children || settledChildren ? `<ul class="activity-children">${children}${settledChildren}</ul>` : ''}
        <div class="activity-row__actions">${action(item.chatId ? 'Open chat' : 'Open source', 'open', item.id)}${live && (live.kind !== 'agent_chat' || live.canStop) ? action(live.kind === 'agent_chat' ? 'Stop this reply' : 'Stop this work', 'stop', item.id) : ''}${retry}</div>
      </details>
    </div>
  </li>`;
}

/** DOM-only priority stack; runtime actions use the existing owning surfaces. */
export function createActivityDropdown(panel: HTMLElement, actions: ActivityDropdownActions) {
  let items = new Map<string, ActivityItem>();
  let lastFingerprint = '';
  let historyExpanded = false;
  let latest: { feed: ActivityFeed; prefs: NotificationPrefs; label: string; canStop: boolean } | null = null;
  const expanded = new Set<string>();
  const retrying = new Set<string>();
  panel.innerHTML = `<header class="activity-header"><div class="activity-header__line"><h2>Activity</h2><button type="button" class="activity-mute" data-action="mute"></button></div><p class="activity-summary" aria-live="polite"></p></header><div class="activity-error" role="alert" hidden></div><div class="activity-body"></div><footer class="activity-footer"><button type="button" data-action="history">Earlier activity</button><button type="button" data-action="settings">${iconHtml('settings', { size: 14 })} Alerts</button><button type="button" data-action="stop-all">Stop all…</button></footer>`;
  const body = panel.querySelector<HTMLElement>('.activity-body')!;
  const error = panel.querySelector<HTMLElement>('.activity-error')!;
  const mute = panel.querySelector<HTMLButtonElement>('.activity-mute')!;
  const summary = panel.querySelector<HTMLElement>('.activity-summary')!;

  function section(title: string, list: ActivityItem[], recent = false): string {
    const dismissible = list.some((item) => activityNeedsAttention(item) && item.status !== 'question');
    return `<section class="activity-section" aria-label="${title}"><div class="activity-section__heading"><h3>${title}</h3>${dismissible ? action('Dismiss all', 'dismiss-all') : ''}${recent && latest?.feed.recent.some((item) => item.unread) ? action('Mark seen', 'seen') : ''}</div><ul class="activity-list">${list.map((item) => rowHtml(item, expanded.has(item.id))).join('')}</ul></section>`;
  }

  function render(feed: ActivityFeed, prefs: NotificationPrefs, label: string, canStop: boolean): void {
    latest = { feed, prefs, label, canStop };
    items = new Map([...feed.attention, ...feed.running, ...feed.background, ...feed.recent].map((item) => [item.id, item]));
    const fingerprint = JSON.stringify(latest, (key, value) => key === 'elapsedMs' ? undefined : value) + historyExpanded;
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    const focus = panel.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusAction = focus?.dataset.action;
    const focusItem = focus?.dataset.itemId;
    const focusRunId = focus?.dataset.runId;
    const focusDetail = focus?.tagName === 'SUMMARY' ? focus.parentElement?.dataset.detailId : undefined;
    panel.querySelectorAll<HTMLDetailsElement>('details[data-detail-id]').forEach((detail) => {
      if (detail.open) expanded.add(detail.dataset.detailId!);
      else expanded.delete(detail.dataset.detailId!);
    });
    mute.innerHTML = `${iconHtml(prefs.muted ? 'bellOff' : 'bell', { size: 14 })}<span>${prefs.muted ? 'Alerts muted' : 'Mute alerts'}</span>`;
    mute.setAttribute('aria-pressed', String(prefs.muted));
    const summaryText = `${feed.attention.length ? `${feed.attention.length} need you · ` : ''}${getRunningAgentCount(feed)} agents working · ${label || 'This workspace'}`;
    if (summary.textContent !== summaryText) summary.textContent = summaryText;
    body.innerHTML = `${feed.attention.length ? section(`Needs you · ${feed.attention.length}`, feed.attention) : ''}${feed.running.length || feed.background.length ? `<section class="activity-section" aria-label="In progress"><div class="activity-section__heading"><h3>In progress · ${feed.runningCount}</h3></div><ul class="activity-list">${feed.running.map((item) => rowHtml(item, expanded.has(item.id))).join('')}</ul>${feed.background.length ? `<details class="activity-background" data-detail-id="background"${expanded.has('background') ? ' open' : ''}><summary>${feed.background.length} background task${feed.background.length === 1 ? '' : 's'}</summary><ul class="activity-list">${feed.background.map((item) => rowHtml(item, expanded.has(item.id))).join('')}</ul></details>` : ''}</section>` : ''}${!feed.attention.length && !feed.runningCount ? `<div class="activity-empty">${iconHtml('check', { size: 22 })}<p>All caught up</p><small>No work running. Nothing needs your attention.</small></div>` : ''}${feed.recent.length ? section('Recent', historyExpanded ? feed.recent : feed.recent.slice(0, 3), true) : ''}`;
    panel.querySelector<HTMLButtonElement>('[data-action="stop-all"]')!.disabled = !canStop;
    const history = panel.querySelector<HTMLButtonElement>('[data-action="history"]')!;
    history.hidden = feed.recent.length <= 3;
    history.textContent = historyExpanded ? 'Less history' : `Earlier activity (${feed.recent.length - 3})`;
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-action="retry"]')) button.disabled = retrying.has(button.dataset.itemId!);
    if (focusAction) ([...panel.querySelectorAll<HTMLElement>('[data-action]')].find((node) => node.dataset.action === focusAction && node.dataset.itemId === focusItem && node.dataset.runId === focusRunId) ?? mute).focus({ preventScroll: true });
    if (focusDetail) [...panel.querySelectorAll<HTMLDetailsElement>('details[data-detail-id]')].find((node) => node.dataset.detailId === focusDetail)?.querySelector('summary')?.focus({ preventScroll: true });
  }

  async function onClick(event: MouseEvent): Promise<void> {
    const target = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (!target || target.disabled) return;
    const item = items.get(target.dataset.itemId ?? '');
    const name = target.dataset.action;
    if (name === 'mute') actions.mute();
    if (name === 'settings') actions.settings();
    if (name === 'stop-all') actions.stop();
    if (name === 'seen' && latest) actions.seen(latest.feed.recent);
    if (name === 'dismiss-all' && latest) {
      for (const alert of [...latest.feed.attention]) if (alert.status !== 'question') actions.dismiss(alert);
    }
    if (name === 'history' && latest) {
      historyExpanded = !historyExpanded;
      render(latest.feed, latest.prefs, latest.label, latest.canStop);
    }
    if (!item) return;
    if (name === 'open' || name === 'child') actions.open(item, target.dataset.runId);
    if (name === 'dismiss') actions.dismiss(item);
    if (name === 'stop') actions.stop(item);
    if (name === 'retry') {
      retrying.add(item.id);
      target.disabled = true;
      error.hidden = true;
      try { await actions.retry(item); }
      catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false; }
      finally {
        retrying.delete(item.id);
        for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-action="retry"]')) if (button.dataset.itemId === item.id) button.disabled = false;
      }
    }
  }
  const click = (event: MouseEvent) => { void onClick(event); };
  panel.addEventListener('click', click);
  return {
    render,
    tick(now = Date.now()): void {
      for (const el of panel.querySelectorAll<HTMLElement>('[data-started-at]')) el.textContent = formatAgentActivityElapsed(now - Number(el.dataset.startedAt));
      for (const el of panel.querySelectorAll<HTMLElement>('[data-timestamp]')) el.textContent = formatRelativeTime(Number(el.dataset.timestamp), now);
    },
    destroy(): void { panel.removeEventListener('click', click); },
  };
}
