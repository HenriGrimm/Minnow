/**
 * Phone-side connection API: connect from a QR ticket, ask the host for access,
 * and hand the sign-in to another address. The resulting credential is an
 * HttpOnly cookie set by the host; nothing here stores a secret.
 */

import { isInstalledPwa } from './pwa-context.ts';

export interface HostInfo {
  hostName: string;
  ingress: 'loopback' | 'lan' | 'tailnet' | 'funnel';
  /** Whether a 6-digit code can be typed (home network only). */
  codeEntry: boolean;
  /** Whether Request access is currently accepted. */
  requestsOpen: boolean;
  paired: boolean;
}

export interface ConnectedDevice {
  id: string;
  name: string;
}

export interface AccessRequest {
  id: string;
  secret: string;
  verifyCode: string;
  expiresAt: string;
}

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

const FALLBACK_HOST_INFO: HostInfo = {
  hostName: 'your computer',
  ingress: 'lan',
  codeEntry: false,
  requestsOpen: true,
  paired: false,
};

async function readError(response: Response, fallback: string): Promise<Error & { code?: string }> {
  try {
    const payload = (await response.json()) as { error?: string; code?: string };
    const err = new Error(payload.error || fallback) as Error & { code?: string };
    err.code = payload.code;
    return err;
  } catch {
    return new Error(fallback);
  }
}

/** Unauthenticated description of the host this page was served by. */
export async function fetchHostInfo(): Promise<HostInfo> {
  try {
    const response = await fetch('/api/auth/host-info', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return FALLBACK_HOST_INFO;
    return { ...FALLBACK_HOST_INFO, ...((await response.json()) as Partial<HostInfo>) };
  } catch {
    return FALLBACK_HOST_INFO;
  }
}

async function claim(body: Record<string, unknown>): Promise<ConnectedDevice> {
  const response = await fetch('/api/auth/claim', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, installed: isInstalledPwa() }),
  });
  if (!response.ok) throw await readError(response, 'This connect link is invalid or has expired.');
  return ((await response.json()) as { device: ConnectedDevice }).device;
}

/** Connect with the single-use ticket from a scanned QR. */
export function claimConnectTicket(ticket: string, name: string): Promise<ConnectedDevice> {
  return claim({ ticket, name });
}

/** Keep only digits and require a six-digit code. */
export function normalizePairingCode(code: string): string {
  const digits = code.replace(/\D/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}

/** Connect with the 6-digit code shown under the QR (home network only). */
export function claimConnectCode(code: string, name: string): Promise<ConnectedDevice> {
  const normalized = normalizePairingCode(code);
  if (!normalized) return Promise.reject(new Error('Enter the 6-digit code from your computer.'));
  return claim({ code: normalized, name });
}

/** Ask the host to approve this device; show `verifyCode` while waiting. */
export async function requestAccess(name: string): Promise<AccessRequest> {
  const response = await fetch('/api/auth/requests', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, installed: isInstalledPwa() }),
  });
  if (!response.ok) throw await readError(response, 'Could not ask for access.');
  return (await response.json()) as AccessRequest;
}

/** Poll an access request; on `approved` the host has set this device's cookie. */
export async function pollAccessRequest(request: Pick<AccessRequest, 'id' | 'secret'>): Promise<AccessRequestStatus> {
  const response = await fetch(`/api/auth/requests/${encodeURIComponent(request.id)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'X-Minnow-Request-Secret': request.secret },
  });
  if (!response.ok) throw await readError(response, 'Could not check the request.');
  const { status } = (await response.json()) as { status: AccessRequestStatus };
  return status;
}

/** A single-use ticket that signs this device in at another Minnow address. */
export async function createHandoffTicket(purpose: 'install' | 'move'): Promise<string> {
  const response = await fetch('/api/auth/handoff', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  if (!response.ok) throw await readError(response, 'Could not prepare the move.');
  return ((await response.json()) as { ticket: string }).ticket;
}

/** The phone's own suggestion for its name, editable before connecting. */
export function suggestedDeviceName(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/iPhone|iPod/i.test(userAgent)) return 'iPhone';
  // iPadOS Safari reports a Mac user agent; touch support gives it away.
  if (/Macintosh/i.test(userAgent) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) return 'iPad';
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows PC';
  return 'My device';
}
