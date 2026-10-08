import {
  getDeviceToken,
  hasHostSessionToken,
  saveDeviceToken,
} from './session-token.ts';

export interface CompanionDevice {
  id: string;
  name: string;
  createdAt: string;
}

export interface PairingChallenge {
  code: string;
  deviceName: string;
  expiresAt: string;
  urls: string[];
}

interface PairingExchangeResponse {
  token: string;
  device: CompanionDevice;
}

const PAIRING_FRAGMENT_KEY = 'pair';
const PAIRING_CODE_DIGITS = 6;

/** Keep only digits and require a six-digit LAN pairing code. */
function normalizePairingCode(code: string): string {
  const digits = code.replace(/\D/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}

function pairingCodeFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const fromFragment = new URLSearchParams(raw).get(PAIRING_FRAGMENT_KEY)?.trim() ?? '';
  return normalizePairingCode(fromFragment);
}

function removePairingFragment(): void {
  const url = `${window.location.pathname}${window.location.search}#/desktop`;
  window.history.replaceState(null, '', url);
}

/** Give an installed app its pairing even when iOS creates an empty storage jar. */
export function configureCompanionManifest(): void {
  const token = getDeviceToken();
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link || !token || hasHostSessionToken()) return;
  link.href = `/api/auth/manifest?token=${encodeURIComponent(token)}`;
}

/** Exchange a one-time pairing secret for a named device credential. */
export async function exchangePairingCode(code: string): Promise<PairingExchangeResponse> {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw new Error('Enter the 6-digit pairing code from the host');

  const response = await fetch('/api/auth/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalized }),
  });
  const payload = (await response.json()) as Partial<PairingExchangeResponse> & {
    error?: string;
  };
  if (!response.ok || typeof payload.token !== 'string' || !payload.device) {
    throw new Error(payload.error ?? 'Pairing failed');
  }
  saveDeviceToken(payload.token);
  return payload as PairingExchangeResponse;
}

/** Exchange a URL-fragment pairing secret before authenticated app bootstrap. */
export async function initializeDevicePairing(): Promise<
  'host' | 'device' | 'pairing-required' | 'pairing-failed'
> {
  if (hasHostSessionToken()) return 'host';

  const installToken = new URLSearchParams(window.location.hash.slice(1)).get('device');
  if (installToken) {
    removePairingFragment();
    if (!getDeviceToken()) {
      try { saveDeviceToken(installToken); } catch { return 'pairing-required'; }
    }
  }
  const code = pairingCodeFromLocation();
  // Bookmarked/scanned links often still contain the single-use code. An
  // existing pairing belongs to the device, not to that expired challenge.
  if (getDeviceToken()) {
    if (code) removePairingFragment();
    return 'device';
  }
  if (!code) return 'pairing-required';

  try {
    await exchangePairingCode(code);
    removePairingFragment();
    return 'device';
  } catch {
    return 'pairing-failed';
  }
}

/** Create a short-lived, host-authorized pairing challenge. */
export async function createPairing(deviceName: string): Promise<PairingChallenge> {
  const response = await fetch('/api/auth/pairings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  });
  const payload = (await response.json()) as Partial<PairingChallenge> & { error?: string };
  if (!response.ok || !payload.code || !payload.expiresAt || !Array.isArray(payload.urls)) {
    throw new Error(payload.error ?? 'Could not create pairing link');
  }
  return payload as PairingChallenge;
}

/** List named devices from the host-only management endpoint. */
export async function fetchCompanionDevices(): Promise<CompanionDevice[]> {
  const response = await fetch('/api/auth/devices', { cache: 'no-store' });
  const payload = (await response.json()) as { devices?: CompanionDevice[]; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? 'Could not load paired devices');
  }
  return Array.isArray(payload.devices) ? payload.devices : [];
}

/** Revoke a device; its next API request receives 401. */
export async function revokeCompanionDevice(deviceId: string): Promise<void> {
  const response = await fetch(`/api/auth/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  if (response.ok) return;
  const payload = (await response.json()) as { error?: string };
  throw new Error(payload.error ?? 'Could not revoke device');
}

