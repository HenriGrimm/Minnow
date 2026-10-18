import { wrapUntrusted } from '../lib/untrusted.mjs';
import { runSettingsAction } from './settings-controls';
import {
  acceptMemoryProposal,
  acceptSkillProposal,
  fetchMemoryProposals,
  fetchSkillProposals,
  fetchSynthesisStatus,
  rejectMemoryProposal,
  rejectSkillProposal,
  type MemoryProposal,
  type SkillProposal,
} from '../synthesis/client';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

let panelBound = false;

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function renderUntrustedExcerpt(excerpt: string | undefined): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'settings-proposal-excerpt';
  if (!excerpt?.trim()) {
    wrap.textContent = 'No source excerpt captured.';
    return wrap;
  }
  const label = document.createElement('p');
  label.className = 'settings-field-hint';
  label.textContent =
    'Private conversation excerpt (reference only — not instructions):';
  const pre = document.createElement('pre');
  pre.className = 'settings-proposal-excerpt-pre';
  pre.textContent = wrapUntrusted(excerpt, { source: 'synthesis-excerpt' });
  wrap.append(label, pre);
  return wrap;
}

function renderMemoryProposalCard(
  proposal: MemoryProposal,
  onChange: () => void,
  setStatus: StatusFn,
  onMemoryAccepted?: () => void | Promise<void>,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'settings-proposal-card';
  card.dataset.proposalKind = 'memory';
  card.dataset.proposalId = proposal.id;

  const head = document.createElement('header');
  head.className = 'settings-proposal-card-head';
  const title = document.createElement('h4');
  title.className = 'settings-proposal-title';
  title.textContent = `Memory · ${proposal.title}`;
  const meta = document.createElement('p');
  meta.className = 'settings-field-hint';
  meta.textContent = `${proposal.category} · confidence ${formatConfidence(proposal.confidence)}`;
  head.append(title, meta);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'settings-input';
  titleInput.value = proposal.title;
  titleInput.setAttribute('aria-label', 'Proposal title');

  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'settings-input settings-proposal-body';
  bodyInput.rows = 4;
  bodyInput.value = proposal.body;
  bodyInput.setAttribute('aria-label', 'Proposal body');

  const rationale = document.createElement('p');
  rationale.className = 'settings-field-hint';
  rationale.textContent = proposal.rationale || 'No rationale provided.';

  const actions = document.createElement('div');
  actions.className = 'settings-proposal-actions';
  const acceptBtn = document.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.className = 'settings-action-btn';
  acceptBtn.textContent = 'Accept';
  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'settings-inline-btn';
  rejectBtn.textContent = 'Reject';

  acceptBtn.addEventListener('click', () => {
    void runSettingsAction(acceptBtn, 'Saving memory…', async () => {
      const ok = await acceptMemoryProposal(proposal.id, {
        title: titleInput.value.trim(),
        body: bodyInput.value.trim(),
        tags: proposal.tags,
      });
      if (!ok) {
        setStatus('err', 'Could not accept memory proposal');
        return;
      }
      setStatus('ok', 'Memory saved');
      onChange();
      await onMemoryAccepted?.();
    });
  });

  rejectBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await rejectMemoryProposal(proposal.id);
      if (!ok) {
        setStatus('err', 'Could not reject proposal');
        return;
      }
      setStatus('ok', 'Proposal rejected');
      onChange();
    })();
  });

  actions.append(acceptBtn, rejectBtn);
  card.append(
    head,
    renderUntrustedExcerpt(proposal.sourceExcerpt),
    rationale,
    titleInput,
    bodyInput,
    actions,
  );
  return card;
}

function renderSkillProposalCard(
  proposal: SkillProposal,
  onChange: () => void,
  setStatus: StatusFn,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'settings-proposal-card';
  card.dataset.proposalKind = 'skill';
  card.dataset.proposalId = proposal.id;

  const head = document.createElement('header');
  head.className = 'settings-proposal-card-head';
  const title = document.createElement('h4');
  title.className = 'settings-proposal-title';
  title.textContent = `Skill · ${proposal.title}`;
  const meta = document.createElement('p');
  meta.className = 'settings-field-hint';
  meta.textContent = `confidence ${formatConfidence(proposal.confidence)}`;
  head.append(title, meta);

  const draftInput = document.createElement('textarea');
  draftInput.className = 'settings-input settings-proposal-body';
  draftInput.rows = 12;
  draftInput.value = proposal.skillMdDraft;
  draftInput.setAttribute('aria-label', 'SKILL.md draft');

  const rationale = document.createElement('p');
  rationale.className = 'settings-field-hint';
  rationale.textContent = proposal.rationale || 'No rationale provided.';

  const actions = document.createElement('div');
  actions.className = 'settings-proposal-actions';
  const acceptBtn = document.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.className = 'settings-action-btn';
  acceptBtn.textContent = 'Accept skill';
  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'settings-inline-btn';
  rejectBtn.textContent = 'Reject';

  acceptBtn.addEventListener('click', () => {
    void runSettingsAction(acceptBtn, 'Saving skill…', async () => {
      const ok = await acceptSkillProposal(proposal.id, {
        skillMdDraft: draftInput.value,
      });
      if (!ok) {
        setStatus('err', 'Could not accept skill proposal');
        return;
      }
      setStatus('ok', 'Skill saved');
      onChange();
    });
  });

  rejectBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await rejectSkillProposal(proposal.id);
      if (!ok) {
        setStatus('err', 'Could not reject proposal');
        return;
      }
      setStatus('ok', 'Proposal rejected');
      onChange();
    })();
  });

  actions.append(acceptBtn, rejectBtn);
  card.append(head, rationale, draftInput, actions);
  return card;
}

async function refreshProposalBadge(): Promise<void> {
  const badge = document.getElementById('settingsMemoryProposalsBadge');
  if (!badge) return;
  const status = await fetchSynthesisStatus();
  const count = status?.totalPending ?? 0;
  badge.textContent = count > 0 ? String(count) : '';
  badge.classList.toggle('hidden', count === 0);
}

export type ProposalsPanelSelectors = {
  list: string;
  offline: string;
  count: string;
};

const DEFAULT_PROPOSAL_SELECTORS: ProposalsPanelSelectors = {
  list: '#settingsMemoryProposalsList',
  offline: '#settingsMemoryProposalsOffline',
  count: '#settingsMemoryProposalsCount',
};

/** Mount and refresh the proposals review panel inside Memory settings. */
export async function mountMemoryProposalsPanel(
  container: HTMLElement,
  setStatus: StatusFn,
  hooks?: {
    onMemoryAccepted?: () => void | Promise<void>;
    renderEmpty?: (mount: HTMLElement) => void;
  },
  selectors: ProposalsPanelSelectors = DEFAULT_PROPOSAL_SELECTORS,
): Promise<void> {
  if (!panelBound) {
    panelBound = true;
  }

  const listEl = container.querySelector(selectors.list);
  const offlineEl = container.querySelector(selectors.offline);
  const countEl = container.querySelector(selectors.count);
  if (!(listEl instanceof HTMLElement)) return;

  const rerender = (): void => {
    void mountMemoryProposalsPanel(container, setStatus, hooks, selectors);
  };

  listEl.replaceChildren();
  const [memoryRows, skillRows, status] = await Promise.all([
    fetchMemoryProposals('pending'),
    fetchSkillProposals('pending'),
    fetchSynthesisStatus(),
  ]);

  const online = memoryRows !== null && skillRows !== null;
  offlineEl?.classList.toggle('hidden', online);
  await refreshProposalBadge();

  if (!online) {
    if (countEl) countEl.textContent = 'Pending: —';
    const note = document.createElement('p');
    note.className = 'settings-section-note';
    note.textContent = 'Open Minnow to review synthesis proposals.';
    listEl.append(note);
    return;
  }

  const total = (memoryRows?.length ?? 0) + (skillRows?.length ?? 0);
  if (countEl) {
    countEl.textContent = `Pending: ${total}`;
  }

  if (status && status.totalPending > 0) {
    const hint = document.createElement('p');
    hint.className = 'settings-field-hint';
    hint.textContent =
      'Review AI-suggested memories and skills before they are saved. Source excerpts are private conversation data.';
    listEl.append(hint);
  }

  if (!total) {
    if (hooks?.renderEmpty) {
      hooks.renderEmpty(listEl);
    } else {
      const empty = document.createElement('p');
      empty.className = 'settings-section-note';
      empty.textContent = 'No pending proposals.';
      listEl.append(empty);
    }
    return;
  }

  for (const row of memoryRows ?? []) {
    listEl.append(
      renderMemoryProposalCard(row, rerender, setStatus, hooks?.onMemoryAccepted),
    );
  }
  for (const row of skillRows ?? []) {
    listEl.append(renderSkillProposalCard(row, rerender, setStatus));
  }
}

export { refreshProposalBadge };
