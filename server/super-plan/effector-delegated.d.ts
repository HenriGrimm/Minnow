/**
 * Delegated effector for the Super Plan run engine (W4-A).
 *
 * `interview` / `draft` leases, compare-and-set claiming, heartbeats, and
 * content-addressed artifacts. See `effector-delegated.js` for the contract.
 */

import type { AttemptEnd } from '../orchestrator/engine';

/** The two pipeline stages a renderer drives; every other role is headless. */
export const DELEGATED_ROLES: readonly ('interview' | 'draft')[];

/** How often the claimer should heartbeat. Advertised on the lease. */
export const DEFAULT_HEARTBEAT_MS: number;

/** How long a lease survives without a heartbeat before it is reaped. */
export const DEFAULT_EXPIRY_MS: number;

/** Clock used by the effector. Tests replace it to drive expiry deterministically. */
export const delegatedClock: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

/** Deterministic content address for an artifact. */
export function contentAddress(content: string): string;

export interface DelegatedLease {
  attemptId: string;
  taskId: string | null;
  role: string;
  seedKind: string;
  claimedBy: string | null;
  heartbeatMs: number;
  expiryMs: number;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export type ClaimResult =
  | { ok: true; status: 200; lease: DelegatedLease }
  | { ok: false; status: 409; error: string };

export type HeartbeatResult =
  | { ok: true; status: 200; expiresAt: number; lease: DelegatedLease }
  | { ok: false; status: 409; error: string };

export interface DelegatedEffector {
  inspect(): Array<{ taskId: string | null; role: string; attemptId: string }>;
  start(desired: {
    taskId: string | null;
    role: string;
    seedKind?: string;
  }): Promise<{ attemptId: string }>;
  claim(attemptId: string, clientId: string): ClaimResult;
  heartbeat(attemptId: string, clientId: string): HeartbeatResult;
  finish(
    attemptId: string,
    end?: { outcome?: string; summary?: string; evidence?: Record<string, unknown> },
  ): Promise<{ ok: boolean; status: number; duplicate?: boolean; error?: string }>;
  writeArtifact(input?: {
    stage?: string;
    path?: string;
    content?: string;
    attemptId?: string;
  }): { ok: true; duplicate: boolean; address: string; path: string | null };
  stop(attemptId: string): Promise<void>;
  onEnd(handler: (end: AttemptEnd) => Promise<void> | void): void;
  readonly started: Array<{
    taskId: string | null;
    role: string;
    attemptId: string;
    seedKind?: string;
  }>;
  leases(): DelegatedLease[];
  leaseOf(attemptId: string): DelegatedLease | null;
  vanishAll(): void;
}

export interface CreateDelegatedEffectorOptions {
  runId?: string;
  clock?: {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
  };
  heartbeatMs?: number;
  expiryMs?: number;
}

export function createDelegatedEffector(
  options?: CreateDelegatedEffectorOptions,
): DelegatedEffector;

/** The live delegated effector registered for a run, if any. */
export function getDelegatedEffector(runId: string): DelegatedEffector | undefined;

/** Tests: drop the registry so runs do not leak across cases. */
export function resetDelegatedEffectors(): void;

export function createDelegatedClaimHandler(effector: {
  claim: (attemptId: string, clientId: string) => ClaimResult;
}): (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => Promise<void>;
