import '../styles/settings-general.css';
import '../styles/settings-usage.css';

import { isServerStorageMode } from '../config/storage-mode';
import { detectLocalServer } from '../tools/client';
import { getActiveChat, getChatsForWorkspace, getChatsSortedByUpdatedDesc, scheduleSaveSessions } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import {
  resetTokenLedger,
  mergeTotals,
  EMPTY_LEDGER_TOTALS,
  formatSourceLabel,
  formatUsd,
  mergeSessionBySource,
  sumSessionLedgerTotals,
} from '../usage/token-ledger';
import type { TokenLedgerBySource, TokenLedgerEntry, TokenLedgerTotals } from '../usage/types';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { appConfirm } from './app-dialog';
import { appendSettingsOfflineHint } from './settings-controls';
import { createUsageTimeline } from './usage-timeline';

// ── Format ───────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(at);
  }
}

/** Short workspace label for the session rollup heading. */
function formatWorkspaceLabel(workspace: string): string {
  if (!workspace) return 'No workspace selected';
  const parts = workspace.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}

/** Human-readable label for a rollup key (e.g. main:build → Main (build)). */
function formatSourceKey(key: string): string {
  if (key.startsWith('main:')) {
    const rest = key.slice(5);
    const colon = rest.indexOf(':');
    if (colon === -1) return `Main (${rest})`;
    return `Main (${rest.slice(0, colon)}) · ${rest.slice(colon + 1)}`;
  }
  if (key.startsWith('sub-agent:')) return `Sub-agent (${key.slice(10)})`;
  if (key.startsWith('work-agent:')) return `Work agent (${key.slice(11)})`;
  if (key === 'title') return 'Chat title';
  if (key === 'reef-widget') return 'Legacy widget (Reef)';
  if (key === 'orchestrate-board') return 'Orchestrate board';
  return key;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Flat instrument row for ledger totals (stats-strip vocabulary, no nested cards). */
function appendUsageMetrics(mount: HTMLElement, totals: TokenLedgerTotals): void {
  const panel = el('div', 'usage-instrument');
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Usage totals');

  const metrics: { label: string; value: string; tone?: 'muted' | 'cost' }[] = [
    { label: 'Completions', value: String(totals.completionCount) },
    { label: 'Total tokens', value: formatTokens(totals.totalTokens) },
    {
      label: 'Estimated cost',
      value: formatUsd(totals.costUsd),
      tone: totals.costUsd > 0 ? 'cost' : 'muted',
    },
  ];

  for (const metric of metrics) {
    const cell = el('div', 'usage-instrument__cell');
    cell.append(
      el('span', 'usage-instrument__label', metric.label),
      el(
        'span',
        `usage-instrument__value${metric.tone ? ` usage-instrument__value--${metric.tone}` : ''}`,
        metric.value,
      ),
    );
    panel.appendChild(cell);
  }

  mount.appendChild(panel);
}

/** Prompt vs completion token split bar (stats-strip colors). */
function appendTokenSplit(mount: HTMLElement, totals: TokenLedgerTotals): void {
  const prompt = totals.promptTokens;
  const completion = totals.completionTokens;
  const sum = prompt + completion;
  if (sum <= 0) return;

  const wrap = el('div', 'usage-token-split');
  const track = el('div', 'usage-token-split__track');
  track.setAttribute('role', 'img');
  track.setAttribute(
    'aria-label',
    `Token split: ${formatTokens(prompt)} prompt, ${formatTokens(completion)} completion`,
  );

  const promptFill = el('div', 'usage-token-split__fill usage-token-split__fill--prompt');
  promptFill.style.flex = String(prompt);
  const completionFill = el('div', 'usage-token-split__fill usage-token-split__fill--completion');
  completionFill.style.flex = String(completion);
  track.append(promptFill, completionFill);

  const legend = el('p', 'usage-token-split__legend');
  const promptStrong = el('strong', undefined, formatTokens(prompt));
  const completionStrong = el('strong', undefined, formatTokens(completion));
  legend.append(promptStrong, ' prompt · ', completionStrong, ' completion');
  wrap.append(track, legend);
  mount.appendChild(wrap);
}

/** Roll up totals, split bar, and optional breakdown sections. */
function appendUsageRollup(
  mount: HTMLElement,
  totals: TokenLedgerTotals,
  bySource: TokenLedgerBySource,
  entries: TokenLedgerEntry[],
): void {
  appendUsageMetrics(mount, totals);
  appendTokenSplit(mount, totals);
  mount.appendChild(createUsageTimeline(entries));

  const subsection = el('div', 'usage-subsection');
  const controls = el('div', 'usage-toolbar');
  const label = el('label', 'usage-scope-label', 'Break down by');
  const breakdown = el('select', 'usage-scope');
  breakdown.id = 'usageBreakdown';
  label.htmlFor = breakdown.id;
  for (const [value, title] of [['source', 'Source'], ['model', 'Model']]) {
    const option = el('option', undefined, title);
    option.value = value!;
    breakdown.appendChild(option);
  }
  controls.append(label, breakdown);
  const detail = el('div', 'usage-breakdown');
  subsection.append(controls, detail);
  mount.appendChild(subsection);

  const renderBreakdown = () => {
    detail.replaceChildren();
    const modelView = breakdown.value === 'model';
    const rows = new Map<string, { label: string; totals: TokenLedgerTotals }>();
    if (modelView) {
      for (const entry of entries) {
        const key = JSON.stringify([entry.providerId, entry.modelId]);
        const previous = rows.get(key);
        rows.set(key, {
          label: `${entry.modelId || 'Unknown model'} (${entry.providerId || 'Unknown provider'})`,
          totals: mergeTotals(previous?.totals ?? EMPTY_LEDGER_TOTALS, entry.usage, entry.costUsd),
        });
      }
    } else {
      for (const [key, totals] of Object.entries(bySource)) rows.set(key, { label: formatSourceKey(key), totals });
    }
    const sorted = [...rows.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label));
    if (modelView) {
      detail.appendChild(el('p', 'usage-note',
        `Based on ${entries.length.toLocaleString()} retained completions (up to 200 per chat). Older completions remain in overall totals but are not included here. Models are grouped by provider.`));
    }
    if (!sorted.length) {
      appendUsageEmpty(detail, 'No recorded breakdown available.');
      return;
    }
    const ledger = el('div', 'usage-ledger');
    ledger.setAttribute('role', 'table');
    ledger.setAttribute('aria-label', `Usage by ${modelView ? 'model' : 'source'}`);
    const head = el('div', 'usage-ledger__row usage-ledger__row--head');
    head.setAttribute('role', 'row');
    for (const heading of [modelView ? 'Model / provider' : 'Source', 'Completions', 'Tokens', 'Cost']) {
      const cell = el('span', 'usage-ledger__cell usage-ledger__cell--head', heading);
      cell.setAttribute('role', 'columnheader');
      head.appendChild(cell);
    }
    ledger.appendChild(head);
    for (const { label, totals: row } of sorted) {
      const item = el('div', 'usage-ledger__row');
      item.setAttribute('role', 'row');
      item.append(
        el('span', 'usage-ledger__cell usage-ledger__cell--source', label),
        el('span', 'usage-ledger__cell', `${row.completionCount}`),
        el('span', 'usage-ledger__cell usage-ledger__cell--mono', formatTokens(row.totalTokens)),
        el('span', 'usage-ledger__cell usage-ledger__cell--mono usage-ledger__cell--end', formatUsd(row.costUsd)),
      );
      for (const cell of Array.from(item.children)) cell.setAttribute('role', 'cell');
      ledger.appendChild(item);
    }
    detail.appendChild(ledger);
  };
  breakdown.addEventListener('change', renderBreakdown);
  renderBreakdown();

  if (entries.length > 0) {
    const recent = [...entries].sort((a, b) => b.at - a.at).slice(0, 12);
    const subsection = el('div', 'usage-subsection');
    subsection.appendChild(el('h4', 'usage-subsection__title', `Recent completions (${recent.length})`));

    const scroll = el('div', 'usage-recent-wrap');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Recent completions, scroll for more');
    const table = el('table', 'usage-recent');
    table.setAttribute('aria-label', 'Recent completions');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const heading of ['Time', 'Source', 'Model', 'Tokens', 'Cost']) {
      headRow.appendChild(el('th', undefined, heading));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const entry of recent) {
      const total =
        entry.usage.total_tokens ??
        (entry.usage.prompt_tokens ?? 0) + (entry.usage.completion_tokens ?? 0);
      const tr = document.createElement('tr');
      tr.append(
        el('td', 'usage-recent__time', formatTime(entry.at)),
        el('td', undefined, formatSourceLabel(entry.source)),
        el('td', 'usage-recent__model', entry.modelId || '—'),
        el('td', 'usage-recent__mono', formatTokens(total)),
        el('td', 'usage-recent__mono', entry.costUsd == null ? 'Not priced' : formatUsd(entry.costUsd)),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    subsection.appendChild(scroll);
    subsection.appendChild(el('p', 'usage-note', 'Latest recorded completions. Totals include older entries no longer shown here.'));
    mount.appendChild(subsection);
  }
}

function appendUsageEmpty(mount: HTMLElement, message: string): void {
  mount.appendChild(el('p', 'usage-empty', message));
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Render Usage panel into #settingsUsageBody. */
export async function renderUsageSettingsSection(): Promise<void> {
  const mount = document.getElementById('settingsUsageBody');
  if (!mount) return;
  mount.replaceChildren();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  shell.classList.add('settings-usage');
  shell.appendChild(el('p', 'settings-section-lead',
    'Token usage recorded from your chats and agents. A completion is one model response, including each step in a tool loop.'));

  const content = el('div', 'settings-general__content settings-usage__content');
  shell.appendChild(content);
  const toolbar = el('div', 'usage-toolbar');
  const label = el('label', 'usage-scope-label', 'Show usage for');
  label.htmlFor = 'usageScope';
  const scope = el('select', 'usage-scope');
  scope.id = 'usageScope';
  for (const [value, title] of [['total', 'Total'], ['workspace', 'Workspace'], ['chat', 'Current chat']]) {
    const option = el('option', undefined, title);
    option.value = value!;
    scope.appendChild(option);
  }
  const reset = el('button', 'usage-reset', 'Reset usage');
  reset.type = 'button';
  toolbar.append(label, scope, reset);
  content.appendChild(toolbar);
  const report = el('div', 'usage-report');
  content.appendChild(report);

  const renderReport = () => {
    report.replaceChildren();
    const workspace = getWorkspacePath();
    const activeChat = getActiveChat();
    const totalScope = scope.value === 'total';
    const workspaceScope = scope.value === 'workspace';
    const chats = totalScope ? getChatsSortedByUpdatedDesc()
      : workspaceScope ? getChatsForWorkspace(workspace) : [activeChat];
    const totals = sumSessionLedgerTotals(chats);
    reset.hidden = !totalScope && !workspaceScope;
    reset.disabled = totals.completionCount === 0;
    reset.textContent = totalScope ? 'Reset total usage' : 'Reset workspace usage';
    const entries = chats.flatMap((chat) => chat.tokenLedger?.entries ?? []);
    const group = appendSettingsGroup(
      report,
      totalScope ? 'Total usage' : workspaceScope ? 'Workspace usage' : 'Current chat usage',
      totalScope ? `All workspaces (${chats.length} chats)` : workspaceScope
        ? `${formatWorkspaceLabel(workspace)} · ${chats.length} chats`
        : activeChat.name?.trim() || 'The chat open in this window.',
      totalScope ? 'models.usage.total' : workspaceScope ? 'models.usage.session' : 'models.usage.active',
    );
    group.appendChild(el('p', 'usage-note', totalScope
      ? 'All recorded usage across every workspace, including chats without a workspace.'
      : workspaceScope
      ? 'All recorded usage in these workspace chats, including the active chat when it belongs to this workspace.'
      : 'All recorded usage in this chat, including agent and title responses.'));
    if (totals.completionCount === 0) {
      appendUsageEmpty(group, workspaceScope && !workspace
        ? 'Choose a workspace to see usage across its chats.'
        : 'No usage recorded yet. Send a message with a provider that returns token usage to see it here.');
      return;
    }
    appendUsageRollup(group, totals, mergeSessionBySource(chats), entries);
  };
  reset.addEventListener('click', async () => {
    const totalScope = scope.value === 'total';
    if (!totalScope && scope.value !== 'workspace') return;
    const workspace = getWorkspacePath();
    const chats = totalScope ? getChatsSortedByUpdatedDesc() : getChatsForWorkspace(workspace);
    const target = totalScope ? 'all workspaces and unassigned chats' : `workspace ${formatWorkspaceLabel(workspace)}`;
    reset.disabled = true;
    scope.disabled = true;
    try {
      const confirmed = await appConfirm(
        `Clear recorded token usage, cost estimates, and recent completions for ${target}? This also resets usage in the affected chats. Chat messages are kept. New completions will start accumulating again. This cannot be undone.`,
        { title: totalScope ? 'Reset total usage?' : 'Reset workspace usage?', confirmLabel: 'Reset usage', danger: true },
      );
      if (!confirmed || mount.firstElementChild !== shell) return;
      for (const chat of chats) {
        resetTokenLedger(chat);
        scheduleSaveSessions({ chatId: chat.id });
      }
    } finally {
      scope.disabled = false;
      if (mount.firstElementChild === shell) renderReport();
    }
  });
  scope.addEventListener('change', renderReport);
  renderReport();

  const pricingNote = el('div', 'usage-pricing-note');
  pricingNote.dataset.settingsSearchKey = 'models.usage.pricing';
  const pricingBody = el('p', 'usage-pricing-note__body');
  pricingBody.append(
    'Estimates sum recorded costs in USD, not provider bills. Unpriced completions are excluded; $0 does not guarantee free usage. Set rates per million input and output tokens in ',
    linkToSettingsSection('Providers', 'providers'),
    ' → Model pricing. Totals are not limited to a billing period.',
  );
  pricingNote.append(el('p', 'usage-pricing-note__title', 'How costs are calculated'), pricingBody);
  content.appendChild(pricingNote);

  // Local ledger data must not wait on server discovery. Ignore stale renders.
  const serverUp = await detectLocalServer().catch(() => false);
  if (mount.firstElementChild !== shell) return;
  if (!isServerStorageMode() || !serverUp) {
    appendSettingsOfflineHint(
      content,
      'Recorded usage is available offline. Connect to the Minnow server to edit provider pricing.',
      { id: 'settingsUsageOffline', searchKey: 'models.usage' },
    );
  }
}
