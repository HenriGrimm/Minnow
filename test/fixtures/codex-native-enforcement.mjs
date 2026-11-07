import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../../server/generations/agent-cli/resolve-bin.js';
import { createCodexRpc } from '../../server/generations/codex-app-server/rpc.js';
import { createFakeCodexResponses } from './codex-app-server-responses.mjs';

export const NATIVE_FIXTURE_VERSION = '0.166.0';
export const psQuote = value => `'${value.replaceAll("'", "''")}'`;
export const exists = file => fs.access(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

/** Real OS effects, fake inference. No auth, live config, sandbox setup, or external network. */
export async function createNativeEnforcementFixture({ windowsSandbox, scoped = false, onToolCall, unifiedExec } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-enforcement-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside');
  const endpoint = await createFakeCodexResponses();
  let networkHits = 0, rpc;
  const network = http.createServer((_request, response) => { networkHits++; response.end('NATIVE_NETWORK_MARKER'); });
  await new Promise(resolve => network.listen(0, '127.0.0.1', resolve));
  const events = [], approvals = [];
  let decide = () => 'decline', serial = 0;
  const close = async () => {
    try { await rpc?.close(); }
    finally {
      await endpoint.close(); network.closeAllConnections();
      await new Promise(resolve => network.close(resolve));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  };
  try {
    for (const directory of [home, workspace, outside]) await fs.mkdir(directory);
    await fs.writeFile(path.join(home, 'private-marker.txt'), 'NATIVE_PRIVATE_MARKER');
    await fs.writeFile(path.join(outside, 'outside-marker.txt'), 'NATIVE_OUTSIDE_MARKER');
    await fs.writeFile(path.join(workspace, 'allowed.txt'), 'NATIVE_ALLOWED_MARKER');
    const config = [
      'model_provider = "fixture"', 'model = "gpt-5.5"', 'cli_auth_credentials_store = "file"',
      'web_search = "disabled"', 'allow_login_shell = false',
      ...(scoped ? ['default_permissions = "minnow-read"'] : []),
      '[model_providers.fixture]', 'name = "Fixture"', `base_url = ${JSON.stringify(endpoint.baseUrl)}`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
      '[agents]', 'enabled = false', '[tools]', 'experimental_request_user_input = { enabled = false }',
      '[features]', 'code_mode = false', 'shell_tool = true', ...(unifiedExec === undefined ? [] : ['unified_exec = ' + unifiedExec]), 'hooks = false', 'plugins = false',
      'multi_agent = false', 'apps = false', 'image_generation = false', 'view_image = false',
      'request_permissions_tool = false', 'goals = false', 'memories = false',
      ...(windowsSandbox ? ['[windows]', `sandbox = ${JSON.stringify(windowsSandbox)}`] : []),
    ];
    if (scoped) {
      for (const [name, access, enabled] of [['minnow-read', 'read', false], ['minnow-write', 'write', false], ['network-control', 'read', true]]) {
        config.push(`[permissions.${name}.filesystem]`, '":minimal" = "read"', `":workspace_roots" = "${access}"`,
          `${JSON.stringify(home)} = "deny"`, `${JSON.stringify(outside)} = "deny"`,
          `[permissions.${name}.network]`, `enabled = ${enabled}`);
      }
    }
    await fs.writeFile(path.join(home, 'config.toml'), config.join('\n'));
    const bin = await resolveAgentCliBin({ kind: 'codex' });
    const env = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    // No ambient provider keys, proxy settings, Node options, user config, or real auth file.
    Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home });
    rpc = createCodexRpc({ ...bin, cwd: home, env: applyAgentCliCaptureEnv(env, bin.command) }, {
      onRequest: async row => {
        if (row.method === 'item/tool/call' && onToolCall) return onToolCall(row);
        assert.ok(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(row.method));
        approvals.push(row);
        const decision = await decide(row);
        assert.ok(['accept', 'decline', 'cancel'].includes(decision));
        await rpc.respond(row.id, { decision });
      },
    });
    rpc.subscribe(row => events.push(row));
    const info = await rpc.initialize({ experimentalApi: true });
    assert.ok(info.userAgent.includes(`/${NATIVE_FIXTURE_VERSION} `), 'Review a changed CLI before treating these exclusions as evidence.');
    assert.equal(path.resolve(info.codexHome), path.resolve(home));
    assert.equal(await exists(path.join(home, 'auth.json')), false);
    return {
      root, home, workspace, outside, rpc, endpoint, events, approvals, info, close,
      get networkHits() { return networkHits; },
      networkCommand: `$client = New-Object System.Net.WebClient; $client.Proxy = $null; try { $client.DownloadString('http://127.0.0.1:${network.address().port}/native-effect') } catch { Write-Output $_.Exception.Message; exit 1 }`,
      async command(command, sandboxPolicy, permissionProfile) {
        return rpc.request('command/exec', { command, cwd: workspace, ...(permissionProfile ? { permissionProfile } : { sandboxPolicy }) }, { timeoutMs: 15_000 });
      },
      async turn({ cmd, patch, profile, sandbox = 'read-only', approvalPolicy = 'never', decision = () => 'decline', workdir, yieldTimeMs, expectedStatus = 'completed' }) {
        decide = decision;
        const started = await rpc.request('thread/start', { model: 'gpt-5.5', cwd: workspace, ephemeral: true,
          approvalPolicy, ...(profile ? { permissions: profile } : { sandbox }), baseInstructions: 'Isolated effect fixture.' });
        const id = `native_probe_${++serial}`, eventOffset = events.length, approvalOffset = approvals.length;
        const call = patch == null
          ? { id, name: 'exec_command', args: { cmd, login: false, max_output_tokens: 1500,
            ...(workdir ? { workdir } : {}), ...(yieldTimeMs !== undefined ? { yield_time_ms: yieldTimeMs } : {}) } }
          : { id, name: 'apply_patch', code: patch };
        endpoint.scripts.push({ calls: [call] }, { text: 'Fixture settled.' });
        let unsubscribe, timer;
        const completed = new Promise((resolve, reject) => {
          unsubscribe = rpc.subscribe(row => {
            if (row.method === 'turn/completed' && row.params.threadId === started.thread.id) resolve(row.params.turn);
          });
          timer = setTimeout(() => reject(new Error('Native effect fixture timed out.')), 20_000);
        });
        try {
          await rpc.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Run the isolated fixture.' }] });
          const terminal = await completed;
          assert.equal(terminal.status, expectedStatus, JSON.stringify(terminal.error));
          const output = endpoint.requests.at(-1).input.filter(row => row.call_id === id && row.type.endsWith('output'));
          if (expectedStatus === 'completed') assert.equal(output.length, 1, 'Real native result must return to inference exactly once.');
          return { id, threadId: started.thread.id, output: output[0]?.output ?? '',
            events: events.slice(eventOffset), approvals: approvals.slice(approvalOffset) };
        } finally { clearTimeout(timer); unsubscribe(); }
      },
    };
  } catch (error) { await close(); throw error; }
}
