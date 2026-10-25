import {
  getAgentCliProviderConfig,
  setAgentCliProviderEnabled,
  updateAgentCliProviderSettings,
} from '../providers/store.js';
import { detectAgentCli, verifyAgentCliAuth } from './agent-cli-detect.js';
import { getAgentCliAccountUsage } from './agent-cli-usage.js';
import { createAgentCliLoginService } from './agent-cli-login.js';
import { disposeCodexSessions } from '../generations/codex-app-server/lifecycle.js';
import { getCliCapability } from '../generations/agent-cli/lifecycle.js';
import {
  AGENT_CLI_DEFINITIONS,
  getAgentCliDefinition,
  getAgentCliInstallCommand,
  clearAgentCliModelCatalogCache,
} from './agent-cli-catalog.js';

const login = createAgentCliLoginService({
  verify: (kind) => getAgentCliStatus(kind, { verify: true }),
  onSignedIn: async (kind) => {
    clearAgentCliModelCatalogCache(kind);
    await disposeCodexSessions(session => session.providerId === getAgentCliDefinition(kind).providerId
      && !session.active && !session.waiting);
  },
});

export function shutdownAgentCliLogins() { return login.shutdown(); }

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
    sessionMode: 'auto',
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
    ...(typeof agentCli.interactive === 'boolean' ? { interactive: agentCli.interactive } : {}),
    ...(typeof agentCli.contextWindowTokens === 'number' ? { contextWindowTokens: agentCli.contextWindowTokens } : {}),
    ...(typeof agentCli.maxBudgetUsd === 'number'
      ? { maxBudgetUsd: agentCli.maxBudgetUsd }
      : {}),
    sessionMode: 'auto',
    transport: kind === 'codex' ? 'app-server' : kind === 'claude' ? 'stream-json' : 'replay',
    restartResumeSupported: kind !== 'cursor',
    ...getCliCapability(definition.providerId),
    installCommand: getAgentCliInstallCommand(kind),
    loginCommand: definition.loginCommand,
    updateCommand: definition.updateCommand,
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

  const match = pathname.match(/^\/api\/models\/agent-clis\/([^/]+)\/(verify|enable|settings|usage|prepare-update|login)$/);
  if (!match) return false;
  try {
    const kind = getAgentCliDefinition(decodeURIComponent(match[1])).kind;
    const action = match[2];
    if (action === 'login') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') {
        const id = new URL(req.url ?? pathname, 'http://localhost').searchParams.get('id');
        sendJson(res, 200, { login: login.poll(kind, id) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        let flow;
        if (body.action === 'cancel') flow = await login.cancel(kind, body.id);
        else if (body.action === 'code') flow = login.submit(kind, body.id, body.code);
        else if (body.action === 'start') {
          const { profile, secrets } = await getAgentCliProviderConfig(kind);
          const status = await getAgentCliStatus(kind);
          if (!status.installed) throw new Error('Install the CLI before signing in.');
          if (status.authStatus === 'token' || secrets.cliToken) {
            throw new Error('This CLI uses a configured token. Manage that token before using browser sign-in.');
          }
          flow = await login.start(kind, { binPath: profile?.agentCli?.binPath });
        } else throw new Error('Invalid sign-in action');
        sendJson(res, 200, { login: flow });
        return true;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    if (action === 'usage' && req.method === 'GET') {
      const query = new URL(req.url ?? pathname, 'http://localhost').searchParams;
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 200, { usage: await getAgentCliAccountUsage(kind, { refresh: query.get('refresh') === '1' }) });
      return true;
    }
    if (action === 'verify' && req.method === 'POST') {
      clearAgentCliModelCatalogCache(kind);
      sendJson(res, 200, { agentCli: await getAgentCliStatus(kind, { verify: true }) });
      return true;
    }
    if (action === 'enable' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body?.enabled !== true) await disposeCodexSessions(session => session.providerId === getAgentCliDefinition(kind).providerId);
      const provider = await setAgentCliProviderEnabled(kind, body?.enabled);
      sendJson(res, 200, { provider, agentCli: await getAgentCliStatus(kind) });
      return true;
    }
    if (action === 'prepare-update' && req.method === 'POST') {
      // Idle CLI children hold their binaries open, which blocks a self-update on
      // Windows. Running turns keep their process; conversations resume after.
      const { providerId } = getAgentCliDefinition(kind);
      await disposeCodexSessions(session => session.providerId === providerId && !session.active && !session.waiting);
      sendJson(res, 200, { agentCli: await getAgentCliStatus(kind) });
      return true;
    }
    if (action === 'settings' && req.method === 'PUT') {
      clearAgentCliModelCatalogCache(kind);
      const body = await readJsonBody(req);
      await disposeCodexSessions(session => session.providerId === getAgentCliDefinition(kind).providerId, { forget: true });
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
