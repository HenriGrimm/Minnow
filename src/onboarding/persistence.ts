import { isServerStorageMode } from '../config/storage-mode';
import { createDefaultOnboardingState } from './state-core';
import type { OnboardingPersistedState } from './types';

const STORAGE_KEY = 'minnow.onboarding.v1';
const owner = crypto.randomUUID();
let claimed = false;

function readLocalMirror(): OnboardingPersistedState | null {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return state?.version === 1 ? state : null;
  } catch { return null; }
}

function writeLocalMirror(state: OnboardingPersistedState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function updateServer(action: string, state?: OnboardingPersistedState, reset = false): Promise<{
  claimed?: boolean; state: OnboardingPersistedState;
}> {
  const response = await fetch('/api/config/onboarding', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, owner: action === 'save' && !claimed ? null : owner, state, reset }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Could not save setup (${response.status}). Try again.`);
  }
  return response.json();
}

/** Use the browser's cross-window mutex when running without the tool server. */
async function updateLocal<T>(update: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(STORAGE_KEY, update);
  }
  return update();
}

export async function loadOnboardingState(): Promise<OnboardingPersistedState> {
  if (!isServerStorageMode()) return readLocalMirror() ?? createDefaultOnboardingState();
  try {
    const response = await fetch('/api/config/file?key=onboarding.json', { cache: 'no-store' });
    if (response.status === 404) return createDefaultOnboardingState();
    if (!response.ok) throw new Error('Setup storage is unavailable.');
    const state = await response.json();
    if (state?.version !== 1) throw new Error('Invalid setup state.');
    return state;
  } catch (error) {
    if (claimed) throw error;
    return readLocalMirror() ?? createDefaultOnboardingState();
  }
}

/** Only update the mirror after the canonical write succeeds. */
export async function saveOnboardingState(state: OnboardingPersistedState): Promise<void> {
  if (isServerStorageMode()) {
    const saved = await updateServer('save', state);
    try { writeLocalMirror(saved.state); } catch {}
    return;
  }
  await updateLocal(() => {
    const current = readLocalMirror();
    if (current?.overlayOwner && Number(current.overlayExpiresAt) > Date.now()
      && current.overlayOwner !== owner) throw new Error('Setup is open in another window.');
    if (claimed && current?.overlayOwner !== owner) throw new Error('Setup is open in another window.');
    writeLocalMirror({ ...state, overlayOwner: claimed ? owner : null,
      overlayClaimedAt: claimed ? current?.overlayClaimedAt ?? state.overlayClaimedAt : null,
      overlayExpiresAt: claimed ? Date.now() + 30_000 : null });
  });
}

export async function markOnboardingComplete(state: OnboardingPersistedState): Promise<OnboardingPersistedState> {
  const next: OnboardingPersistedState = { ...state, completedAt: new Date().toISOString(), lastStep: 'done' };
  await saveOnboardingState(next);
  return next;
}

export async function tryClaimOnboardingOverlay(
  state: OnboardingPersistedState, reset = false,
): Promise<{ claimed: boolean; state: OnboardingPersistedState }> {
  const result = isServerStorageMode()
    ? await updateServer('claim', undefined, reset)
    : await updateLocal(() => {
      const current = readLocalMirror() ?? state;
      if (current.overlayOwner && Number(current.overlayExpiresAt) > Date.now()
        && current.overlayOwner !== owner) return { claimed: false, state: current };
      if (current.completedAt && !reset) return { claimed: false, state: current };
      const next = { ...(reset ? createDefaultOnboardingState() : current), overlayOwner: owner,
        overlayClaimedAt: new Date().toISOString(), overlayExpiresAt: Date.now() + 30_000 };
      writeLocalMirror(next);
      return { claimed: true, state: next };
    });
  claimed = result.claimed === true;
  return { claimed, state: result.state };
}

export async function renewOnboardingOverlayClaim(): Promise<void> {
  if (!claimed) return;
  if (isServerStorageMode()) { await updateServer('renew'); return; }
  await updateLocal(() => {
    const state = readLocalMirror();
    if (state?.overlayOwner !== owner) {
      throw new Error('Setup claim expired. Reopen setup to continue.');
    }
    writeLocalMirror({ ...state, overlayExpiresAt: Date.now() + 30_000 });
  });
}

export async function releaseOnboardingOverlayClaim(state: OnboardingPersistedState): Promise<OnboardingPersistedState> {
  if (isServerStorageMode()) {
    const result = await updateServer('release');
    claimed = false;
    return result.state;
  }
  return updateLocal(() => {
    const current = readLocalMirror() ?? state;
    if (current.overlayOwner !== owner) return current;
    const next = { ...current, overlayOwner: null, overlayClaimedAt: null, overlayExpiresAt: null };
    writeLocalMirror(next);
    claimed = false;
    return next;
  });
}

export async function resetOnboardingForRerun(): Promise<OnboardingPersistedState> {
  const result = await tryClaimOnboardingOverlay(await loadOnboardingState(), true);
  if (!result.claimed) throw new Error('Setup is already open in another window.');
  return result.state;
}
