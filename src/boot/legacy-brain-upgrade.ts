import { getSessionToken, hasHostSessionToken } from '../api/session-token';
import { appChoice, appConfirm } from '../ui/app-dialog';

const BASE = '/api/brain/legacy-upgrade';

export async function offerLegacyBrainUpgrade(): Promise<void> {
  if (!hasHostSessionToken()) return;
  const request = (action?: 'clean' | 'skip') => fetch(action ? `${BASE}/${action}` : BASE, {
    method: action ? 'POST' : 'GET',
    headers: {
      'X-Minnow-Token': getSessionToken(),
      ...(action === 'clean' ? { 'X-Minnow-Confirm-Legacy-Wiki': 'delete' } : {}),
    },
  });
  try {
    const response = await request();
    if (!response.ok || !(await response.json()).pending) return;
  } catch {
    return;
  }

  let error = '';
  for (;;) {
    const { id } = await appChoice({
      title: 'Brain now uses Memories',
      message: (error ? `${error}\n\n` : '') + 'Agents now use project and personal Memories instead of the old Brain wiki. We recommend cleaning up the old wiki pages, sources, and proposals. Your current Memories, code index, and backups will stay.',
      buttons: [
        { id: 'skip', label: 'Skip' },
        { id: 'clean', label: 'Clean up old Brain data', primary: true },
      ],
      defaultFocusId: 'skip',
      cancelId: 'skip',
    });
    if (id === 'clean' && !await appConfirm('This permanently deletes the legacy wiki pages and sources from this profile. It does not delete current Memories, the code index, or backups.', {
      title: 'Delete old Brain data?',
      confirmLabel: 'Delete old data',
      danger: true,
    })) continue;
    try {
      const response = await request(id === 'clean' ? 'clean' : 'skip');
      if (response.ok || id === 'skip') return;
    } catch {
      if (id === 'skip') return;
    }
    error = 'Could not finish cleaning up the old data. Try again or skip.';
  }
}
