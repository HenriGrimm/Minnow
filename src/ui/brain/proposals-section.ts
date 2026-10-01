import { appAlert, appConfirm, appPrompt } from '../app-dialog';
/**
 * Brain app — Proposals section: reuse memory/skill synthesis review panel.
 */

import { mountMemoryProposalsPanel } from '../memory-proposals-panel';
import { renderBrainEmptyState } from './empty-state';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

const setProposalsStatus: StatusFn = (kind, message) => {
  const el = document.getElementById('brainProposalsStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
};

let clearPendingBound = false;

/** Mount the proposals review list inside the Brain app. */
export async function renderProposalsSection(): Promise<void> {
  const root = document.getElementById('brainSection-proposals');
  if (!root) return;

  if (!clearPendingBound) {
    clearPendingBound = true;
    document.getElementById('brainProposalsClearPending')?.addEventListener('click', () => {
      void (async () => {
        const ok = await appConfirm('Clear all pending memory and skill proposals?');
        if (!ok) return;
        setProposalsStatus('spin', 'Clearing…');
        const { clearBrainProposals } = await import('../../brain/client');
        const result = await clearBrainProposals('pending');
        if (!result.ok) {
          setProposalsStatus('err', result.error ?? 'Clear failed');
          return;
        }
        setProposalsStatus('ok', `Cleared ${result.removed ?? 0} proposal(s).`);
        await renderProposalsSection();
      })();
    });
  }

  await mountMemoryProposalsPanel(root, setProposalsStatus, {
    onMemoryAccepted: () => {
      void import('./graph-section').then((m) => m.renderGraphSection());
    },
    renderEmpty: (mount) => {
      renderBrainEmptyState(mount, {
        icon: 'inbox',
        title: "You're all caught up",
        message: 'No pending synthesis proposals. Ingest new sources to generate wiki pages.',
        ctaLabel: 'Go to Ingest',
        onCta: () => { void import('../brain-page').then(({ openBrain }) => openBrain('ingest')); },
      });
    },
  }, {
    list: '#brainProposalsList',
    offline: '#brainProposalsOffline',
    count: '#brainProposalsCount',
  });
}
