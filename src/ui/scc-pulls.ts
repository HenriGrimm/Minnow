import { appConfirm } from './app-dialog';
import {
  forgeRefresh,
  prClose,
  prCreate,
  prList,
  prReady,
  prView,
  type ForgeStatus,
  type PullRequestDetail,
  type PullRequestSummary,
} from '../state/forge-api';
import { gitBranches, gitCheckoutPlan, type GitCheckoutSwitchInput } from '../state/git-api';
import { listWorktrees } from '../state/worktree-service';
import { parseWorktreeListPorcelain, worktreePathsEqual, type ParsedWorktree } from '../lib/worktree-list-parse';
import { checkoutRecoveryActions, runCheckoutFlow } from './git-checkout-confirm';
import { getWorkspacePath } from '../state/workspace';
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
import { openGitRecoveryPopover, closeGitRecoveryPopover } from './git-recovery';
import { buildPrDetail, PR_REVIEW_LABEL, prCheckLabel, prStateLabel, type PrDetailTab } from './scc-pr-detail';
import {
  button,
  diffStat,
  drillIn,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  pageBar,
  relativeTime,
  searchBox,
  segmented,
  skeletonRows,
  stateDot,
  type PillTone,
  forgeUnavailableCopy,
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
  const root = el('div', 'scc-page scc-pulls');
  const bar = pageBar('Pull requests');
  const toolbar = bar.controls;
  const split = el('div', 'scc-split');
  const drill = drillIn(split);

  const listCol = el('div', 'scc-split__list');
  const listBody = el('div', 'scc-split__list-body');
  listCol.append(listBody);

  const detailCol = el('div', 'scc-split__detail');
  split.append(listCol, detailCol);
  root.append(bar.root, split);

  let destroyed = false;
  let filter: PrFilter = 'open';
  let selectedNumber: number | null = null;
  let cache: PullRequestSummary[] = [];
  /** Linked worktrees at the last list load, to say where each PR lives. */
  let worktrees: ParsedWorktree[] = [];

  /**
   * Same-repo PRs check out under their head name. A fork's head name says
   * nothing about local branches, so fork rows are only tagged Fork here; the
   * detail button asks the server (tracking ref / head commit).
   */
  function prLocation(pr: PullRequestSummary): { kind: 'here' } | { kind: 'worktree'; path: string; name: string } | { kind: 'none' } {
    if (pr.crossRepository) return { kind: 'none' };
    if (pr.headRef && pr.headRef === ctx.getBranch()) return { kind: 'here' };
    if (pr.state !== 'open') return { kind: 'none' };
    const here = ctx.getCwd() ?? getWorkspacePath();
    const held = worktrees.find((wt) => wt.branch === pr.headRef && !worktreePathsEqual(wt.path, here));
    if (!held) return { kind: 'none' };
    const name = worktreePathsEqual(held.path, getWorkspacePath())
      ? 'workspace'
      : held.path.split(/[\\/]/).filter(Boolean).pop() ?? held.path;
    return { kind: 'worktree', path: held.path, name };
  }
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
    label: 'New pull request',
    title: 'New pull request',
    icon: 'plus',
    variant: 'primary',
    onClick: () => void openCreateForm(),
  });

  const listCount = bar.count;
  const searchField = searchBox('Search pull requests');
  const search = searchField.input;
  search.addEventListener('input', () => renderList());
  const filters = segmented<PrFilter>({
    label: 'Pull request state',
    items: [
      { value: 'open', label: 'Open' },
      { value: 'merged', label: 'Merged' },
      { value: 'closed', label: 'Closed' },
      { value: 'all', label: 'All' },
    ],
    value: filter,
    onChange: (state) => {
      filter = state;
      listBody.replaceChildren(skeletonRows(5));
      void refresh();
    },
  });
  toolbar.append(filters.root, searchField.root);
  bar.actions.append(createBtn);

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
    bar.actions.hidden = false;
    detailCol.hidden = false;
    split.classList.remove('scc-split--single');

    if (listBody.childElementCount === 0) listBody.appendChild(skeletonRows(6));

    const [result, listed] = await Promise.all([
      prList({ cwd, state: filter }),
      // One local read places every row: no per-PR gh call.
      listWorktrees(cwd ?? getWorkspacePath()).catch(() => null),
    ]);
    if (destroyed || request !== listRequest || cwd !== ctx.getCwd()) return;
    worktrees = listed?.ok ? listed.worktrees ?? parseWorktreeListPorcelain(listed.output ?? '') : [];

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
    bar.actions.hidden = true;
    listCount.textContent = '';
    detailCol.hidden = true;
    split.classList.add('scc-split--single');

    const copy = forgeUnavailableCopy(status, 'Pull requests');

    listBody.replaceChildren(
      unavailableState({
        ...copy,
        action: copy.hint
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
    bar.actions.hidden = false;
    detailCol.hidden = false;
    split.classList.remove('scc-split--single');
    await ctx.refreshAll();
  }

  function renderList(): void {
    const query = search.value.trim().toLowerCase();
    const visible = cache.filter((pr) => !query || [pr.title, `#${pr.number}`, pr.author, pr.headRef, pr.baseRef, ...pr.labels.map((label) => label.name)].some((value) => value.toLowerCase().includes(query)));
    listCount.textContent = query ? `${visible.length} of ${cache.length}` : String(cache.length);
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
    const row = el('button', 'scc-row scc-row--wrap scc-prrow');
    row.type = 'button';
    row.dataset.number = String(pr.number);
    row.setAttribute('aria-pressed', String(pr.number === selectedNumber));
    if (pr.number === selectedNumber) row.classList.add('is-selected');

    const lead = el('span', 'scc-row__lead');
    lead.dataset.tone = prTone(pr);
    const glyph = createIcon(pr.state === 'merged' ? 'gitMerge' : 'gitPullRequest', { size: 15 });
    glyph.setAttribute('role', 'img');
    glyph.setAttribute('aria-label', prStateLabel(pr));
    lead.appendChild(glyph);

    const age = relativeTime(pr.updatedAt);
    const aside = el('span', 'scc-row__aside', age);
    aside.title = new Date(pr.updatedAt).toLocaleString();

    const meta = el('span', 'scc-row__meta');
    meta.append(el('span', 'scc-fact scc-mono', `#${pr.number}`), el('span', 'scc-fact scc-prrow__branch', pr.headRef));
    if (pr.state === 'open' && pr.draft) meta.appendChild(el('span', 'scc-tag', 'Draft'));
    const where = prLocation(pr);
    if (where.kind === 'here') meta.appendChild(el('span', 'scc-tag scc-tag--accent scc-prrow__current', 'Checked out here'));
    else if (where.kind === 'worktree') {
      const tag = el('span', 'scc-tag scc-prrow__current', `In ${where.name}`);
      tag.title = `Checked out at ${where.path}`;
      meta.appendChild(tag);
    }
    if (pr.crossRepository) meta.appendChild(el('span', 'scc-tag', 'Fork'));

    const end = el('span', 'scc-row__end');
    if (PR_REVIEW_LABEL[pr.reviewDecision]) end.appendChild(el('span', 'scc-prrow__review', PR_REVIEW_LABEL[pr.reviewDecision]));
    if (pr.checks !== 'none') {
      const dot = stateDot(pr.checks, prCheckLabel(pr));
      dot.classList.add('scc-prrow__checks');
      end.appendChild(dot);
    }
    end.appendChild(diffStat(pr.additions, pr.deletions));
    meta.appendChild(end);

    row.append(lead, el('span', 'scc-row__title scc-prrow__title', pr.title), aside, meta);
    row.title = `#${pr.number} ${pr.title}\n${pr.author} · ${pr.headRef} → ${pr.baseRef}`;
    row.addEventListener('click', () => {
      drill.open();
      void select(pr.number);
    });
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
      closeGitRecoveryPopover();
      if (reviewHost) unmountPrReviewPanel(reviewHost);
      reviewHost = null;
      detailData = null;
      detailCol.replaceChildren(
        errorStrip(result.error ?? 'Could not load the pull request', () => void renderDetail(number)),
      );
      return;
    }

    if (detailData && JSON.stringify(detailData) === JSON.stringify(result.pr)) return;
    closeGitRecoveryPopover();
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
      onBack: () => drill.close(),
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
    if (pr.mergeable === 'conflicting') {
      note.textContent = 'This pull request has merge conflicts.';
      const resolve = button({ label: 'Resolve conflicts', icon: 'gitMerge', onClick: () => {
        openGitRecoveryPopover({
          anchor: resolve, kind: 'pr', error: `Pull request #${pr.number} has merge conflicts. GitHub reports mergeable: CONFLICTING.`,
          ctx: { ...gitUiCtx(ctx.getCwd() ?? getWorkspacePath(), ctx.getBranch()), workspacePath: getWorkspacePath(), sourceBranch: pr.headRef, targetBranch: pr.baseRef, prNumber: pr.number },
        });
      } });
      bar.append(resolve);
      return bar;
    }
    const method = el('select', 'scc-select scc-prdetail__merge-method');
    method.setAttribute('aria-label', 'Merge method');
    for (const [value, label] of [['squash', 'Squash and merge'], ['merge', 'Merge commit'], ['rebase', 'Rebase and merge']]) {
      const option = el('option', undefined, label);
      option.value = value!;
      method.appendChild(option);
    }
    const mergeBtn = button({ label: 'Merge', icon: 'gitMerge', onClick: () => void merge(pr, method.value as 'squash' | 'merge' | 'rebase') });
    if (pr.checks === 'failure') mergeBtn.classList.add('scc-btn--caution');
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

    const checkoutBtn = button({
      label: 'Check out',
      icon: 'gitBranch',
      className: 'scc-prdetail__checkout-btn',
      onClick: () => void checkout(pr),
    });
    bar.appendChild(checkoutBtn);
    void paintCheckoutLocation(pr, checkoutBtn);

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

  function checkoutInput(pr: PullRequestSummary): GitCheckoutSwitchInput {
    return {
      cwd: ctx.getCwd() ?? getWorkspacePath(),
      branch: pr.headRef,
      expectedBranch: ctx.getBranch() || undefined,
      pullRequest: {
        number: pr.number, url: pr.url, headRef: pr.headRef,
        ...(pr.headRefOid ? { headRefOid: pr.headRefOid } : {}),
        ...(pr.crossRepository !== undefined ? { crossRepository: pr.crossRepository } : {}),
      },
    };
  }

  /** Say where the PR already lives so the button routes instead of failing. */
  async function paintCheckoutLocation(pr: PullRequestSummary, btn: HTMLButtonElement): Promise<void> {
    const input = checkoutInput(pr);
    const plan = await gitCheckoutPlan({ cwd: input.cwd, branch: input.branch, pullRequest: input.pullRequest });
    if (destroyed || !btn.isConnected || !plan.ok) return;
    const label = btn.querySelector('.scc-btn__label');
    if (plan.location === 'current') {
      if (label) label.textContent = 'Update checkout';
      btn.title = `#${pr.number} is checked out here. Pull its latest commits.`;
    } else if (plan.location === 'worktree' && plan.worktreePath && ctx.openWorktree) {
      const path = plan.worktreePath;
      btn.replaceWith(button({
        label: 'Open worktree', icon: 'gitWorktree', className: 'scc-prdetail__checkout-btn',
        title: `#${pr.number} is checked out at ${path}`,
        onClick: () => void ctx.openWorktree!(path).then(() => ctx.refreshAll()),
      }));
    }
  }

  async function checkout(pr: PullRequestSummary): Promise<void> {
    const input = checkoutInput(pr);
    const result = await runGitUiOp(() => runCheckoutFlow(input, {
      isCurrent: () => !destroyed,
      openWorktree: ctx.openWorktree,
    }), {
      label: 'Checking out pull request…',
      successMessage: `Checked out #${pr.number}`,
      chatKind: 'pr',
      ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
      recoveryActions: (failed) => checkoutRecoveryActions(failed, { cwd: input.cwd, openWorktree: ctx.openWorktree }),
    });
    if (!result.ok) {
      // gh can move the branch before its update fails; reflect the new checkout.
      if (result.code === 'partial') await ctx.refreshAll();
      return;
    }
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

    drill.open();
    const form = el('form', 'scc-prform');

    const heading = el('div', 'scc-prform__head');
    heading.append(
      button({ label: 'Pull requests', icon: 'chevronLeft', variant: 'ghost', className: 'scc-dhead__back', onClick: () => { renderDetailPlaceholder(); drill.close(); } }),
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
      button({ label: 'Cancel', variant: 'ghost', onClick: () => { renderDetailPlaceholder(); drill.close(); } }),
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
      filters.setValue('open');
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
      closeGitRecoveryPopover();
      destroyed = true;
      ++listRequest;
      ++detailRequest;
      unsubReviews();
      if (reviewHost) unmountPrReviewPanel(reviewHost);
      root.remove();
    },
  };
}

function prTone(pr: Pick<PullRequestSummary, 'state' | 'draft'>): PillTone {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'draft' : 'open';
}
