import type { ShipGateConfig, ShipGateEvidence, ShipGateState } from '../ship-gate/model';

function rootQuery(workspaceRoot?: string): string {
  return workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : '';
}

export async function loadShipGateState(workspaceRoot?: string): Promise<ShipGateState> {
  const response = await fetch(`/api/ship-gate${rootQuery(workspaceRoot)}`, { cache: 'no-store' });
  const body = await response.json().catch(() => ({})) as ShipGateState & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Could not load ship gate (${response.status})`);
  return body;
}

export async function saveShipGateConfig(
  config: ShipGateConfig,
  workspaceRoot?: string,
): Promise<ShipGateConfig> {
  const response = await fetch('/api/ship-gate/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceRoot, config }),
  });
  const body = await response.json().catch(() => ({})) as { config?: ShipGateConfig; error?: string };
  if (!response.ok || !body.config) throw new Error(body.error ?? 'Could not save ship gate');
  return body.config;
}

export async function saveShipGateEvidence(
  evidence: ShipGateEvidence,
  workspaceRoot?: string,
): Promise<ShipGateEvidence> {
  const response = await fetch('/api/ship-gate/evidence', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceRoot, evidence }),
  });
  const body = await response.json().catch(() => ({})) as { evidence?: ShipGateEvidence; error?: string };
  if (!response.ok || !body.evidence) throw new Error(body.error ?? 'Could not save ship gate evidence');
  return body.evidence;
}
