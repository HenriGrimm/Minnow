import { appConfirm } from './app-dialog';
import {
  forgeRefresh,
  prCheckout,
  prClose,
  prCreate,
  prList,
  prReady,
  prView,
  type ForgeStatus,
  type PullRequestDetail,
  type PullRequestSummary,
} from '../state/forge-api';
import { gitBranches } from '../state/git-api';
import { resolveTrunkBranchName } from '../lib/git-trunk-branch';
import { getPrReview, subscribePrReviews } from '../state/pr-review-store';
import { matchPrForBranch, prReviewKey } from '../chat/review/pr-review-target';
import { startPrReview } from '../chat/review/run-pr-review';
import { confirmAndMergePr, mergeReviewedPr, sendPrReviewToBuilder } from '../chat/review/review-actions';
import { renderPrReviewPanel, unmountPrReviewPanel } from './pr-review-panel';
import { gitUiCtx, runGitUiOp, showGitUiFailure } from './git-ui-op';
import { showToast } from './toast';
import { switchChat } from './sidebar';
import { createIcon } from './icon';
import { buildPrDetail, PR_REVIEW_LABEL, prCheckLabel, prStateLabel, type PrDetailTab } from './scc-pr-detail';
import {
  button,
  chip,
  diffStat,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  relativeTime,
  skeletonRows,
  stateDot,
  unavailableState,
  type SccContext,
  type SccView,
} from './scc-shared';

// ── Selection ────────────────────────────────────────────────────────────────

/** Palette / command-palette can ask the next refresh to select this PR. */
let pendingSelectNumber: number | null = null;

/** Select this PR number the next time the pulls list loads. */
export function requestPullsSelection(number: number): void {
  pendingSelectNumber = number;
}

// ── Pulls view ───────────────────────────────────────────────────────────────

type PrFilter = 'open' | 'merged' | 'closed' | 'all';

export function createPullsView(
  ctx: SccContext,
  options: { getForgeStatus: () => ForgeStatus | null },
): SccView {
  const root = el('div', 'scc-split scc-pulls');

  const listCol = el('div', 'scc-split__list');
  const toolbar = el('div', 'scc-pulls__toolbar');
  const listBody = el('div', 'scc-split__list-body');
  listCol.append(toolbar, listBody);

  const detailCol = el('div', 'scc-split__detail');
  root.append(listCol, detailCol);

  let destroyed = false;
  let filter: PrFilter = 'open';
  let selectedNumber: number | null = null;
  let cache: PullRequestSummary[] = [];
  let reviewHost: HTMLElement | null = null;
  let detailData: PullRequestDetail | null = null;
  let activeTab: PrDetailTab = 'overview';
  let creating = false;
  let listRequest = 0;
  let detailRequest = 0;

  const unsubReviews = subscribePrReviews(() => {
    if (destroyed || !selectedNumber) return;
    const wrap = detailCol.querySelector('.scc-prdetail');
    if (!wrap || !reviewHost) return;
    paintReview(selectedNumber, detailData?.commits[0]?.sha, detailData?.state === 'open' && !detailData?.draft);
    updateReviewButton();
  });

  const createBtn = button({
    label: 'New PR',
    title: 'New pull request',
    icon: 'plus',
    variant: 'primary',
    onClick: () => void openCreateForm(),
  });

  const listHeading = el('div', 'scc-pulls__heading');
  const listCount = el('span', 'scc-pulls__count');
  listHeading.append(el('h2', 'scc-pulls__title', 'Pull requests'), listCount, createBtn);
  const searchWrap = el('div', 'scc-pulls__search');
  const search = el('input', 'scc-input');
  search.type = 'search';
  search.placeholder = 'Search pull requests…';
  search.setAttribute('aria-label', 'Search pull requests');
  search.addEventListener('input', () => renderList());
  searchWrap.append(createIcon('search', { size: 15 }), search);
  const filters = el('div', 'scc-pulls__filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Pull request state');
  for (const state of ['open', 'merged', 'closed', 'all'] as const) {
    const filterBtn = button({
      label: state.charAt(0).toUpperCase() + state.slice(1),
      variant: 'ghost',
      onClick: () => {
        if (filter === state) return;
        filter = state;
        for (const item of filters.children) item.setAttribute('aria-pressed', String((item as HTMLElement).dataset.state === state));
        listBody.replaceChildren(skeletonRows(5));
        void refresh();
      },
    });
    filterBtn.dataset.state = state;
    filterBtn.setAttribute('aria-pressed', String(state === filter));
    filters.appendChild(filterBtn);
  }
  toolbar.append(listHeading, searchWrap, filters);

  function clearDetail(): void {
    ++detailRequest;
    if (reviewHost) unmountPrReviewPanel(reviewHost);
    reviewHost = null;
    detailData = null;
    detailCol.removeAttribute('aria-busy');
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    const request = ++listRequest;
    const cwd = ctx.getCwd();

    const status = options.getForgeStatus();
    if (status && !status.supported) {
      renderUnavailable(status);
      ctx.setBadge('pulls', null);
      return;
    }

    toolbar.hidden = false;
    detailCol.hidden = false;
    root.classList.remove('scc-split--single');

    if (listBody.childElementCount === 0) listBody.appendChild(skeletonRows(6));

    const result = await prList({ cwd, state: filter });
    if (destroyed || request !== listRequest || cwd !== ctx.getCwd()) return;

    if (!result.ok) {
      listBody.replaceChildren(
        errorStrip(result.error ?? 'Could not list pull requests', () => void refresh()),
      );
      ctx.setBadge('pulls', null);
      return;
    }

    cache = result.prs ?? [];
    const openCount = cache.filter((pr) => pr.state === 'open').length;
    if (filter === 'open' || filter === 'all') {
      ctx.setBadge('pulls', openCount > 0 ? { kind: 'count', value: openCount } : null);
    }

    if (!creating) {
      const previous = selectedNumber;
      if (pendingSelectNumber && cache.some((pr) => pr.number === pendingSelectNumber)) {
        selectedNumber = pendingSelectNumber;
        pendingSelectNumber = null;
      } else if (!cache.some((pr) => pr.number === selectedNumber)) {
        selectedNumber = matchPrForBranch(cache, ctx.getBranch())?.number ?? cache[0]?.number ?? null;
      }
      if (previous !== selectedNumber) {
        clearDetail();
        activeTab = 'overview';
      }
    }

    renderList();

    if (creating) return;
    if (selectedNumber && cache.some((pr) => pr.number === selectedNumber)) {
      await renderDetail(selectedNumber);
    } else if (!selectedNumber) {
      renderDetailPlaceholder();
    }
  }

  function renderUnavailable(status: ForgeStatus): void {
    clearDetail();
    creating = false;
    toolbar.hidden = true;
    detailCol.hidden = true;
    root.classList.add('scc-split--single');

    const hint = !status.cliInstalled
      ? 'winget install GitHub.cli'
      : !status.authenticated
        ? 'gh auth login'
        : undefined;

    listBody.replaceChildren(
      unavailableState({
        title: status.cliInstalled ? 'Pull requests unavailable' : 'GitHub CLI not found',
        body: status.reason,
        hint,
        action: hint
          ? button({
              label: 'Check again',
              variant: 'primary',
              onClick: () => void recheck(),
            })
          : undefined,
      }),
    );
  }

  async function recheck(): Promise<void> {
    await forgeRefresh(ctx.getCwd());
    toolbar.hidden = false;
    detailCol.hidden = false;
    root.classList.remove('scc-split--single');
    await ctx.refreshAll();
  }

  function renderList(): void {
    const query = search.value.trim().toLowerCase();
    const visible = cache.filter((pr) => !query || [pr.title, `#${pr.number}`, pr.author, pr.headRef, pr.baseRef, ...pr.labels.map((label) => label.name)].some((value) => value.toLowerCase().includes(query)));
    listCount.textContent = query ? `${visible.length} / ${cache.length}` : String(cache.length);
    if (query && !visible.length) {
      listBody.replaceChildren(emptyState({ title: 'No matching pull requests', body: 'Try a title, number, branch, author, or label.', action: button({ label: 'Clear search', variant: 'ghost', onClick: () => { search.value = ''; renderList(); search.focus(); } }) }));
      return;
    }
    if (cache.length === 0) {
      listBody.replaceChildren(
        emptyState({
          icon: 'gitMerge',
          title: filter === 'open' ? 'No open pull requests' : 'No pull requests',
          body: 'Push a branch and open one to get review and CI on it.',
          action: button({
            label: 'New pull request',
            variant: 'primary',
            onClick: () => void openCreateForm(),
          }),
        }),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.number : undefined;
    for (const pr of visible) frag.appendChild(buildRow(pr));
    listBody.replaceChildren(frag);
    if (focused) listBody.querySelector<HTMLElement>(`[data-number="${focused}"]`)?.focus({ preventScroll: true });
  }

  function buildRow(pr: PullRequestSummary): HTMLElement {
    const row = el('button', 'scc-prrow');
    row.type = 'button';
    row.dataset.number = String(pr.number);
    row.setAttribute('aria-pressed', String(pr.number === selectedNumber));
    if (pr.number === selectedNumber) row.classList.add('is-selected');

    const top = el('div', 'scc-prrow__top');
    top.append(
      el('span', 'scc-prrow__number', `#${pr.number}`),
      chip(prStateLabel(pr), pr.state === 'open' && pr.draft ? 'draft' : pr.state),
    );
    if (pr.headRef === ctx.getBranch()) top.appendChild(el('span', 'scc-prrow__current', 'Current branch'));
    const age = relativeTime(pr.updatedAt);
    if (age) top.appendChild(el('span', 'scc-prrow__age', age === 'now' ? 'just now' : `${age} ago`));

    const meta = el('div', 'scc-prrow__meta');
    meta.append(
      el('span', undefined, pr.author),
      el('span', 'scc-prrow__branch', pr.headRef),
    );
    const signals = el('div', 'scc-prrow__signals');
    const checks = el('span', 'scc-prrow__checks');
    const dot = stateDot(pr.checks);
    dot.setAttribute('aria-hidden', 'true');
    checks.append(dot, el('span', undefined, prCheckLabel(pr)));
    signals.append(checks, diffStat(pr.additions, pr.deletions));
    if (PR_REVIEW_LABEL[pr.reviewDecision]) signals.appendChild(el('span', 'scc-prrow__review', PR_REVIEW_LABEL[pr.reviewDecision]));
    row.append(top, el('span', 'scc-prrow__title', pr.title), meta, signals);
    row.title = pr.title;
    row.addEventListener('click', () => void select(pr.number));
    return row;
  }

  async function select(number: number): Promise<void> {
    creating = false;
    if (selectedNumber !== number || !detailCol.querySelector('.scc-prdetail')) {
      clearDetail();
      activeTab = 'overview';
      detailCol.scrollTop = 0;
      detailCol.replaceChildren(skeletonRows(8));
    }
    selectedNumber = number;
    for (const row of listBody.querySelectorAll('.scc-prrow')) {
      row.classList.toggle('is-selected', (row as HTMLElement).dataset.number === String(number));
      row.setAttribute('aria-pressed', String((row as HTMLElement).dataset.number === String(number)));
    }
    await renderDetail(number);
  }

  function renderDetailPlaceholder(): void {
    clearDetail();
    creating = false;
    detailCol.replaceChildren(
      emptyState({
        icon: 'gitMerge',
        title: 'Select a pull request',
        body: 'Its description, checks, commits, and files show here.',
      }),
    );
  }

  async function renderDetail(number: number): Promise<void> {
    const request = ++detailRequest;
    const cwd = ctx.getCwd();
    if (!detailCol.querySelector('.scc-prdetail')) detailCol.replaceChildren(skeletonRows(8));
    detailCol.setAttribute('aria-busy', 'true');

    const result = await prView({ cwd, number });
    if (destroyed || creating || selectedNumber !== number || request !== detailRequest || cwd !== ctx.getCwd()) return;
    detailCol.removeAttribute('aria-busy');

    if (!result.ok || !result.pr) {
      if (reviewHost) unmountPrReviewPanel(reviewHost);
      reviewHost = null;
      detailData = null;
      detailCol.replaceChildren(
        errorStrip(result.error ?? 'Could not load the pull request', () => void renderDetail(number)),
      );
      return;
    }

    if (detailData && JSON.stringify(detailData) === JSON.stringify(result.pr)) return;
    const scroll = detailCol.scrollTop;
    const focusedId = detailCol.contains(document.activeElement) ? document.activeElement?.id : undefined;
    if (reviewHost) unmountPrReviewPanel(reviewHost);
    detailData = result.pr;
    reviewHost = el('div', 'scc-prdetail__review');
    detailCol.replaceChildren(buildPrDetail(result.pr, {
      actions: buildActions(result.pr),
      mergeActions: buildMergeActions(result.pr),
      reviewHost,
      activeTab,
      onTab: (tab) => { activeTab = tab; },
    }));
    paintReview(number, result.pr.commits[0]?.sha, result.pr.state === 'open' && !result.pr.draft);
    detailCol.scrollTop = scroll;
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }

  function buildMergeActions(pr: PullRequestDetail): HTMLElement {
    const bar = el('div', 'scc-prdetail__merge');
    if (pr.state !== 'open') {
      bar.append(createIcon('gitMerge', { size: 16 }), el('span', undefined, pr.state === 'merged' ? `Merged into ${pr.baseRef}` : 'Closed without merging'));
      return bar;
    }
    const note = el('span', 'scc-prdetail__merge-note', pr.draft ? 'Mark ready for review to enable merging.' : `Merge into ${pr.baseRef}`);
    bar.appendChild(note);
    if (pr.draft) return bar;
    const method = el('select', 'scc-input scc-prdetail__merge-method');
    method.setAttribute('aria-label', 'Merge method');
    for (const [value, label] of [['squash', 'Squash and merge'], ['merge', 'Merge commit'], ['rebase', 'Rebase and merge']]) {
      const option = el('option', undefined, label);
      option.value = value!;
      method.appendChild(option);
    }
    const mergeBtn = button({ label: 'Merge', icon: 'gitMerge', onClick: () => void merge(pr, method.value as 'squash' | 'merge' | 'rebase') });
    if (pr.checks === 'failure') mergeBtn.classList.add('scc-btn--caution');
    if (pr.mergeable === 'conflicting') {
      mergeBtn.disabled = true;
      mergeBtn.title = 'Resolve merge conflicts before merging';
    }
    bar.append(method, mergeBtn);
    return bar;
  }

  function updateReviewButton(): void {
    const reviewBtn = detailCol.querySelector<HTMLButtonElement>('.scc-prdetail__review-btn');
    if (!reviewBtn || !selectedNumber) return;
    const repo = options.getForgeStatus()?.repo ?? '';
    const review = repo ? getPrReview(prReviewKey(repo, selectedNumber)) : undefined;
    reviewBtn.disabled = review?.status === 'running';
    reviewBtn.querySelector('.scc-btn__label')!.textContent = review?.status === 'running' ? 'Reviewing…' : review ? 'Re-review' : 'Review PR';
  }

  function buildActions(pr: PullRequestDetail): HTMLElement {
    const bar = el('div', 'scc-prdetail__actions');

    const repo = options.getForgeStatus()?.repo ?? '';
    const review = repo ? getPrReview(prReviewKey(repo, pr.number)) : undefined;
    const reviewLabel =
      review?.status === 'running' ? 'Reviewing…' : review ? 'Re-review' : 'Review PR';
    const reviewBtn = button({
      label: reviewLabel,
      className: 'scc-prdetail__review-btn',
      onClick: () => void runReview(pr),
    });
    if (review?.status === 'running') reviewBtn.disabled = true;
    bar.appendChild(reviewBtn);

    bar.appendChild(
      button({
        label: 'Check out',
        icon: 'gitBranch',
        onClick: () => void checkout(pr.number),
      }),
    );

    if (pr.state === 'open' && pr.draft) {
      bar.appendChild(
        button({
          label: 'Ready for review',
          variant: 'ghost',
          onClick: async () => {
            const result = await runGitUiOp(
              () => prReady({ cwd: ctx.getCwd(), number: pr.number }),
              {
                label: 'Updating pull request…',
                successMessage: `#${pr.number} is ready for review`,
                chatKind: 'pr',
                ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
              },
            );
            if (!result.ok) return;
            await refresh();
          },
        }),
      );
    }

    if (pr.url) {
      const link = el('a', 'scc-btn scc-btn--ghost', 'GitHub');
      link.appendChild(createIcon('externalLink', { size: 13 }));
      link.href = pr.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      bar.appendChild(link);
    }

    if (pr.state === 'open') {
      const more = el('details', 'scc-prdetail__more');
      const toggle = el('summary', 'scc-btn scc-btn--ghost', 'More');
      toggle.appendChild(createIcon('chevronDown', { size: 14 }));
      more.appendChild(toggle);
      more.appendChild(
        button({
          label: 'Close pull request',
          variant: 'ghost',
          className: 'scc-btn--danger-hover',
          onClick: () => void close(pr),
        }),
      );
      bar.appendChild(more);
    }

    return bar;
  }

  function paintReview(number: number, currentHeadSha?: string, canMerge?: boolean): void {
    if (!reviewHost) return;
    const repo = options.getForgeStatus()?.repo ?? '';
    if (!repo) {
      unmountPrReviewPanel(reviewHost);
      return;
    }
    const record = getPrReview(prReviewKey(repo, number));
    if (!record) {
      unmountPrReviewPanel(reviewHost);
      return;
    }
    const issueLinked = Boolean(record.issueId);
    const mergeOk = canMerge ?? cache.find((p) => p.number === number)?.state === 'open';
    renderPrReviewPanel(reviewHost, record, {
      currentHeadSha,
      showUpdateIssue: issueLinked,
      onMerge: mergeOk ? () => void mergeFromReview(record.key, number) : undefined,
      onFix: () => void sendPrReviewToBuilder(record),
      onUpdateIssue: issueLinked
        ? () => {
            void import('../chat/review/review-actions').then((m) => {
              if (record.issueId && m.applyPrReviewToIssue(record, record.issueId)) {
                showToast('Issue updated with the review', 'success');
              }
            });
          }
        : undefined,
      onOpenChat: () => {
        if (record.chatId) void switchChat(record.chatId);
      },
      onRetry: () => {
        const summary = cache.find((p) => p.number === number);
        if (summary) void runReview(summary);
      },
    });
  }

  async function runReview(pr: Pick<PullRequestSummary, 'number'>): Promise<void> {
    const repo = options.getForgeStatus()?.repo ?? '';
    if (!repo) {
      showToast('Repository is unknown', 'error');
      return;
    }
    const result = await runGitUiOp(
      () =>
        startPrReview({
          cwd: ctx.getCwd(),
          repo,
          number: pr.number,
        }),
      {
        label: 'Starting review…',
        successMessage: `Reviewing #${pr.number}`,
        chatKind: 'pr',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
      },
    );
    if (!result.ok) return;
    if (selectedNumber === pr.number) await renderDetail(pr.number);
  }

  async function mergeFromReview(key: string, number: number): Promise<void> {
    const record = getPrReview(key);
    if (!record) return;
    const outcome = await mergeReviewedPr(record, ctx.getCwd());
    if (outcome.cancelled) return;
    if (!outcome.ok) {
      showGitUiFailure(outcome.error ?? 'Could not merge the pull request', {
        chatKind: 'pr',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
      });
      return;
    }
    showToast(`Merged #${number}`, 'success');
    selectedNumber = null;
    await ctx.refreshAll();
  }

  async function merge(
    pr: PullRequestDetail,
    method: 'merge' | 'squash' | 'rebase',
  ): Promise<void> {
    const { result, error } = await confirmAndMergePr({
      cwd: ctx.getCwd(),
      number: pr.number,
      method,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      checks: pr.checks,
    });
    if (result === 'cancelled') return;
    if (result === 'failed') {
      showGitUiFailure(error ?? 'Could not merge the pull request', {
        chatKind: 'pr',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
      });
      return;
    }
    showToast(`Merged #${pr.number}`, 'success');
    selectedNumber = null;
    await ctx.refreshAll();
  }

  async function checkout(number: number): Promise<void> {
    const result = await runGitUiOp(() => prCheckout({ cwd: ctx.getCwd(), number }), {
      label: 'Checking out pull request…',
      successMessage: `Checked out #${number}`,
      chatKind: 'pr',
      ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
    });
    if (!result.ok) return;
    await ctx.refreshAll();
  }

  async function close(pr: PullRequestDetail): Promise<void> {
    const confirmed = await appConfirm(`Close #${pr.number} without merging?`, {
      title: 'Close pull request',
      confirmLabel: 'Close',
      danger: true,
    });
    if (!confirmed) return;

    const result = await runGitUiOp(() => prClose({ cwd: ctx.getCwd(), number: pr.number }), {
      label: 'Closing pull request…',
      successMessage: `Closed #${pr.number}`,
      chatKind: 'pr',
      ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
    });
    if (!result.ok) return;
    selectedNumber = null;
    await refresh();
  }

  async function openCreateForm(): Promise<void> {
    const status = options.getForgeStatus();
    if (status && !status.supported) {
      showGitUiFailure(status.reason, {
        chatKind: 'github',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
      });
      return;
    }

    creating = true;
    clearDetail();
    const request = detailRequest;
    detailCol.replaceChildren(skeletonRows(5));

    const branchResult = await gitBranches(ctx.getCwd());
    if (destroyed || !creating || request !== detailRequest) return;
    const trunk = branchResult.ok
      ? resolveTrunkBranchName(
          branchResult.local ?? [],
          branchResult.remote ?? [],
          branchResult.lockedLocal ?? [],
        )
      : 'main';
    const head = ctx.getBranch();

    selectedNumber = null;
    for (const row of listBody.querySelectorAll('.scc-prrow')) {
      row.classList.remove('is-selected');
      row.setAttribute('aria-pressed', 'false');
    }

    const form = el('form', 'scc-prform');

    const heading = el('div', 'scc-prform__head');
    heading.append(
      el('h2', 'scc-prform__title', 'New pull request'),
      el('p', 'scc-prform__branches', `${head || 'current branch'} → ${trunk}`),
    );

    const titleField = el('input', 'scc-input');
    titleField.type = 'text';
    titleField.placeholder = 'Title';
    titleField.required = true;
    titleField.setAttribute('aria-label', 'Pull request title');

    const bodyField = el('textarea', 'scc-textarea');
    bodyField.rows = 8;
    bodyField.placeholder = 'What changed, and why';
    bodyField.setAttribute('aria-label', 'Pull request description');

    const baseField = el('input', 'scc-input scc-input--compact');
    baseField.type = 'text';
    baseField.value = trunk;
    baseField.setAttribute('aria-label', 'Base branch');

    const draftLabel = el('label', 'scc-checkbox');
    const draftInput = el('input');
    draftInput.type = 'checkbox';
    draftLabel.append(draftInput, el('span', undefined, 'Open as draft'));

    const actions = el('div', 'scc-prform__actions');
    const submit = button({ label: 'Create pull request', variant: 'primary' });
    submit.type = 'submit';
    actions.append(
      button({ label: 'Cancel', variant: 'ghost', onClick: () => renderDetailPlaceholder() }),
      submit,
    );

    const baseRow = el('div', 'scc-prform__row');
    baseRow.append(el('span', 'scc-prform__label', 'Base'), baseField, draftLabel);

    form.append(heading, titleField, baseRow, bodyField, actions);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const title = titleField.value.trim();
      if (!title) {
        titleField.focus();
        return;
      }

      submit.disabled = true;
      submit.querySelector('.scc-btn__label')!.textContent = 'Creating…';

      const result = await runGitUiOp(
        () =>
          prCreate({
            cwd: ctx.getCwd(),
            title,
            body: bodyField.value,
            base: baseField.value.trim() || undefined,
            draft: draftInput.checked,
          }),
        {
          label: 'Creating pull request…',
          successMessage: 'Pull request opened',
          chatKind: 'pr',
          ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
        },
      );

      submit.disabled = false;
      submit.querySelector('.scc-btn__label')!.textContent = 'Create pull request';

      if (!result.ok) return;
      creating = false;
      filter = 'open';
      search.value = '';
      for (const item of filters.children) item.setAttribute('aria-pressed', String((item as HTMLElement).dataset.state === 'open'));
      const number = Number(result.url?.match(/\/pull\/(\d+)/)?.[1]);
      if (number) pendingSelectNumber = number;
      await refresh();
    });

    detailCol.replaceChildren(form);
    titleField.focus();
  }

  const navigate = listNavigator({
    getRows: () => [...listBody.querySelectorAll<HTMLElement>('.scc-prrow')],
  });

  void refresh();

  return {
    root,
    refresh,
    onKey: (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && detailCol.contains(target))) return false;
      return navigate(event);
    },
    destroy: () => {
      destroyed = true;
      ++listRequest;
      ++detailRequest;
      unsubReviews();
      if (reviewHost) unmountPrReviewPanel(reviewHost);
      root.remove();
    },
  };
}
