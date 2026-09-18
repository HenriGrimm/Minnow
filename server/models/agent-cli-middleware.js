import {
  getAgentCliProviderConfig,
  setAgentCliProviderEnabled,
  updateAgentCliProviderSettings,
} from '../providers/store.js';
import { detectAgentCli, verifyAgentCliAuth } from './agent-cli-detect.js';
import {
  AGENT_CLI_DEFINITIONS,
  getAgentCliDefinition,
  getAgentCliInstallCommand,
} from './agent-cli-catalog.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** @param {'claude'|'codex'|'cursor'} kind @param {{ verify?: boolean }} [options] */
export async function getAgentCliStatus(kind, options = {}) {
  const definition = getAgentCliDefinition(kind);
  const { profile, secrets } = await getAgentCliProviderConfig(kind);
  const agentCli = profile?.agentCli ?? {
    kind,
    allowUtilityRoles: false,
    maxConcurrent: 1,
    sessionMode: 'replay',
  };
  const detection = options.verify
    ? await verifyAgentCliAuth(kind, {
        binPath: agentCli.binPath,
        cliToken: secrets.cliToken,
      })
    : await detectAgentCli(kind, {
        binPath: agentCli.binPath,
        cliToken: secrets.cliToken,
      });
  return {
    kind,
    providerId: definition.providerId,
    label: definition.label,
    installed: detection.installed,
    authStatus: detection.authStatus,
    enabled: profile?.enabled === true,
    ...(detection.version ? { version: detection.version } : {}),
    ...(detection.resolvedBinPath ? { binPath: detection.resolvedBinPath } : {}),
    ...(agentCli.binPath ? { binPathOverride: agentCli.binPath } : {}),
    hasCliToken: Boolean(secrets.cliToken?.trim()),
    allowUtilityRoles: agentCli.allowUtilityRoles === true,
    maxConcurrent: agentCli.maxConcurrent,
    ...(typeof agentCli.maxBudgetUsd === 'number'
      ? { maxBudgetUsd: agentCli.maxBudgetUsd }
      : {}),
    sessionMode: 'replay',
    installCommand: getAgentCliInstallCommand(kind),
    loginCommand: definition.loginCommand,
    checkedAt: detection.checkedAt,
    ...(detection.verifiedAt ? { verifiedAt: detection.verifiedAt } : {}),
  };
}

export async function listAgentCliStatuses() {
  return Promise.all(
    Object.keys(AGENT_CLI_DEFINITIONS).map((kind) => getAgentCliStatus(kind)),
  );
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 */
export async function handleAgentCliModelsRequest(req, res, pathname) {
  if (pathname === '/api/models/agent-clis' && req.method === 'GET') {
    try {
      sendJson(res, 200, { agentClis: await listAgentCliStatuses() });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const match = pathname.match(/^\/api\/models\/agent-clis\/([^/]+)\/(verify|enable|settings)$/);
  if (!match) return false;
  try {
    const kind = getAgentCliDefinition(decodeURIComponent(match[1])).kind;
    const action = match[2];
    if (action === 'verify' && req.method === 'POST') {
      sendJson(res, 200, { agentCli: await getAgentCliStatus(kind, { verify: true }) });
      return true;
    }
    if (action === 'enable' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const provider = await setAgentCliProviderEnabled(kind, body?.enabled);
      sendJson(res, 200, { provider, agentCli: await getAgentCliStatus(kind) });
      return true;
    }
    if (action === 'settings' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const provider = await updateAgentCliProviderSettings(kind, body);
      sendJson(res, 200, { provider, agentCli: await getAgentCliStatus(kind) });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
