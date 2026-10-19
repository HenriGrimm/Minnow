/**
 * Host-side device management: remote access status and toggles, connect
 * sessions (the QR), access requests, and the paired device list.
 */

export type DeviceKind = 'phone' | 'tablet' | 'computer' | 'unknown';

export interface DeviceCredentialInfo {
  id: string;
  label: 'browser' | 'home-screen' | 'other-origin';
  origin: string;
  createdAt: string;
  lastSeenAt?: string;
}

export interface CompanionDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  createdAt: string;
  lastSeenAt?: string;
  lastIngress?: string;
  credentials: DeviceCredentialInfo[];
}

export interface LanStatus {
  state: 'off' | 'starting' | 'on' | 'error';
  port: number;
  urls: string[];
  error?: { code: string; message: string };
}

export interface AnywhereStatus {
  state: 'off' | 'unavailable' | 'starting' | 'needs-login' | 'needs-approval' | 'ready' | 'error';
  funnel?: boolean;
  authUrl?: string;
  feature?: 'https' | 'funnel' | 'device';
  url?: string;
  dnsName?: string;
  loginName?: string;
  tailnet?: string;
  code?: string;
  message?: string;
}

export interface RemoteStatus {
  lan: LanStatus;
  anywhere: AnywhereStatus;
}

export interface ConnectSession {
  id: string;
  expiresAt: string;
  code?: string;
  targets: { kind: 'anywhere' | 'lan'; url: string; baseUrl: string }[];
}

export interface ConnectSessionStatus {
  id: string;
  status: 'waiting' | 'claimed' | 'expired';
  device?: { id: string; name: string };
}

export interface PendingAccessRequest {
  id: string;
  name: string;
  kind: DeviceKind;
  verifyCode: string;
  installed: boolean;
  ingress: string;
  createdAt: string;
  expiresAt: string;
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* empty body */
  }
  if (!response.ok) {
    const err = new Error((payload as { error?: string } | null)?.error ?? fallback) as Error & { code?: string };
    err.code = (payload as { code?: string } | null)?.code;
    throw err;
  }
  return payload as T;
}

function post(url: string, body: unknown = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function fetchRemoteStatus(): Promise<RemoteStatus> {
  return json(await fetch('/api/remote/status', { cache: 'no-store' }), 'Could not load remote access status');
}

export async function setLanEnabled(enabled: boolean): Promise<RemoteStatus> {
  return json(await post('/api/remote/lan', { enabled }), 'Could not change home network access');
}

export async function setAnywhere(enabled: boolean, opts: { funnel?: boolean } = {}): Promise<RemoteStatus> {
  return json(await post('/api/remote/anywhere', { enabled, ...opts }), 'Could not change Anywhere access');
}

export async function logoutAnywhere(): Promise<RemoteStatus> {
  return json(await post('/api/remote/anywhere/logout'), 'Could not sign out of Tailscale');
}

export async function createConnectSession(): Promise<ConnectSession> {
  return json(await post('/api/auth/connect-sessions'), 'Could not create a connect code');
}

export async function fetchConnectSession(id: string): Promise<ConnectSessionStatus> {
  return json(
    await fetch(`/api/auth/connect-sessions/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    'Could not check the connect code',
  );
}

export async function fetchDevices(): Promise<CompanionDevice[]> {
  const payload = await json<{ devices?: CompanionDevice[] }>(
    await fetch('/api/auth/devices', { cache: 'no-store' }),
    'Could not load devices',
  );
  return Array.isArray(payload.devices) ? payload.devices : [];
}

export async function renameDevice(id: string, name: string): Promise<CompanionDevice> {
  const response = await fetch(`/api/auth/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return (await json<{ device: CompanionDevice }>(response, 'Could not rename the device')).device;
}

export async function revokeDevice(id: string): Promise<void> {
  await json(await fetch(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Could not disconnect the device');
}

export async function fetchAccessRequests(): Promise<PendingAccessRequest[]> {
  const payload = await json<{ requests?: PendingAccessRequest[] }>(
    await fetch('/api/auth/requests', { cache: 'no-store' }),
    'Could not load access requests',
  );
  return Array.isArray(payload.requests) ? payload.requests : [];
}

export async function approveAccessRequest(id: string, opts: { attachToDeviceId?: string } = {}): Promise<void> {
  await json(await post(`/api/auth/requests/${encodeURIComponent(id)}/approve`, opts), 'Could not approve the request');
}

export async function denyAccessRequest(id: string): Promise<void> {
  await json(await post(`/api/auth/requests/${encodeURIComponent(id)}/deny`), 'Could not decline the request');
}

/** Whether phones can currently reach this host at all. */
export function isRemoteAccessOn(status: RemoteStatus): boolean {
  return status.lan.state === 'on' || status.anywhere.state === 'ready';
}

/** Broadcast so every open Devices surface refreshes after a change here. */
export function notifyDevicesChanged(): void {
  window.dispatchEvent(new Event('minnow-devices-changed'));
}

/** Open an external page (Tailscale sign-in) in the system browser. */
export function openExternalUrl(url: string): void {
  const bridge = (window as Window & { minnow?: { app?: { openExternal?: (href: string) => Promise<unknown> } } }).minnow;
  if (bridge?.app?.openExternal) {
    void bridge.app.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
