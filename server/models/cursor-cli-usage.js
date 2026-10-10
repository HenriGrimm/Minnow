import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeCursorUsage } from './cli-usage-normalize.js';
import { CliUsageError, readBoundedUsageJson, usageHttpError } from './claude-cli-usage.js';

const DASHBOARD = 'https://api2.cursor.sh/aiserver.v1.DashboardService';

/** Mirrors the CLI's own credential store; CURSOR_CONFIG_DIR does not move it. */
export function cursorAuthPath(options = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return path.join(env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  if (platform === 'darwin') return path.join(home, '.cursor', 'auth.json');
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'cursor', 'auth.json');
}

/** Read only the native login store. Never refresh tokens independently of the CLI. */
export async function readCursorUsageCredentials(options = {}) {
  const env = options.env ?? process.env;
  // Minnow's configured Cursor token is passed as CURSOR_API_KEY for inference.
  if (options.cliToken?.trim() || env.CURSOR_API_KEY?.trim() || env.CURSOR_API_ENDPOINT?.trim()) {
    throw new CliUsageError('unsupported', 'Subscription usage is unavailable for this API configuration.');
  }
  let auth;
  try { auth = JSON.parse(await fs.readFile(cursorAuthPath(options), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw new CliUsageError('error', 'Could not read the Cursor login. Verify the CLI and retry.');
    }
  }
  if (!auth?.accessToken || typeof auth.accessToken !== 'string') {
    throw new CliUsageError('signed-out', 'Sign in to Cursor Agent to see account usage.');
  }
  let claims = {};
  try { claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) ?? {}; }
  catch { /* opaque token: the endpoint decides */ }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= (options.now ?? Date.now)()) {
    throw new CliUsageError('signed-out', 'Cursor login has expired. Verify or sign in to the CLI, then refresh.');
  }
  return { token: auth.accessToken, accountKey: typeof claims.sub === 'string' ? claims.sub : undefined };
}

/** Private vendor endpoint (the CLI's own /usage RPCs): isolate its contract and never expose its raw body. */
export async function readCursorAccountUsage(credentials, options = {}) {
  const call = async (method) => {
    const response = await (options.fetch ?? fetch)(`${DASHBOARD}/${method}`, {
      method: 'POST', body: '{}',
      headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new CliUsageError('signed-out', 'Cursor account usage needs a current login. Verify or sign in to the CLI.');
    }
    if (!response.ok) throw usageHttpError(response, 'Cursor');
    return readBoundedUsageJson(response, 'Cursor');
  };
  // The plan name is decoration; a failure there must not hide the meters.
  const [usage, plan] = await Promise.all([call('GetCurrentPeriodUsage'), call('GetPlanInfo').catch(() => null)]);
  const normalized = normalizeCursorUsage(usage, plan?.planInfo);
  if (!normalized.windows.length) throw new CliUsageError('unavailable', 'Cursor did not report included usage for this account.');
  return normalized;
}
