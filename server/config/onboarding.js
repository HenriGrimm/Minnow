import { readConfigJson, writeConfigJson } from './store.js';
import { resolveConfigPath } from './paths.js';

const queues = new Map();
export const ONBOARDING_LEASE_MS = 30_000;

function freshState() {
  return { version: 1, completedAt: null, lastStep: null, overlayClaimedAt: null, steps: {} };
}

/** Serialize ownership checks and writes against the canonical onboarding file. */
export async function updateOnboarding(body, now = Date.now()) {
  const key = resolveConfigPath('onboarding.json');
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const state = (await readConfigJson('onboarding.json')) ?? freshState();
    const owner = typeof body?.owner === 'string' && body.owner.length <= 128 ? body.owner : null;
    const live = state.overlayOwner && Number(state.overlayExpiresAt) > now;
    const owns = Boolean(owner) && state.overlayOwner === owner;
    const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
    let next;
    switch (body?.action) {
      case 'claim':
        if (!owner) fail('Setup owner is required', 400);
        if (live && !owns) return { claimed: false, state };
        if (state.completedAt && !body.reset) return { claimed: false, state };
        next = { ...(body.reset ? freshState() : state), overlayOwner: owner,
          overlayClaimedAt: new Date(now).toISOString(), overlayExpiresAt: now + ONBOARDING_LEASE_MS };
        break;
      case 'renew':
        if (!owns) fail('Setup is open in another window or its claim expired. Reopen setup to continue.');
        next = { ...state, overlayExpiresAt: now + ONBOARDING_LEASE_MS };
        break;
      case 'release':
        if (state.overlayOwner !== owner || !owner) return { state };
        next = { ...state, overlayOwner: null, overlayClaimedAt: null, overlayExpiresAt: null };
        break;
      case 'save':
        if ((owner && !owns) || (!owner && live)) fail('Setup is open in another window or its claim expired. Reopen setup to continue.');
        if (body.state?.version !== 1 || !body.state.steps || typeof body.state.steps !== 'object') {
          fail('Invalid onboarding state', 400);
        }
        next = { ...body.state, overlayOwner: owns ? owner : null,
          overlayClaimedAt: owns ? state.overlayClaimedAt : null,
          overlayExpiresAt: owns ? now + ONBOARDING_LEASE_MS : null };
        break;
      default: fail('Invalid onboarding action', 400);
    }
    await writeConfigJson('onboarding.json', next);
    return { ...(body.action === 'claim' ? { claimed: true } : {}), state: next };
  });
  queues.set(key, operation);
  try { return await operation; }
  finally { if (queues.get(key) === operation) queues.delete(key); }
}
