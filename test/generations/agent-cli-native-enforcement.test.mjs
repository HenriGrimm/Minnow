import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNativeEnforcementFixture, psQuote, exists } from '../fixtures/codex-native-enforcement.mjs';
import { __setCodexInvocationForTests, shutdownCodexSessions } from '../../server/generations/codex-app-server/manager.js';
import { pumpCodexAppServer } from '../../server/generations/codex-app-server/pump.js';
import { createGenerationState } from '../../server/generations/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../../server/generations/agent-cli/resolve-bin.js';

const installed = { skip: process.env.MINNOW_CODEX_NATIVE_ENFORCEMENT !== '1' || process.platform !== 'win32', timeout: 120_000 };
const patch = (file, value = 'NATIVE_PATCH_MARKER') => `*** Begin Patch\n*** Add File: ${file.replaceAll('\\', '/')}\n+${value}\n*** End Patch`;
const read = file => `Get-Content -LiteralPath ${psQuote(file)}`;
const write = file => `Set-Content -LiteralPath ${psQuote(file)} -Value NATIVE_WRITE_MARKER`;

test('production dynamic-only adapter rejects adversarial native command/edit calls before effects', installed, async () => {
  const f = await createNativeEnforcementFixture();
  const previous = process.env.MINNOW_HOME, states = [];
  process.env.MINNOW_HOME = f.root; resetMinnowHomeCache();
  try {
    // Use the production manager configuration, changing only inference/auth to
    // scratch data. No native sandbox/toggle/policy change is made by the test.
    const bin = await resolveAgentCliBin({ kind: 'codex' });
    const auth = path.join(f.root, 'fake-auth.json'); await fs.writeFile(auth, '{}');
    __setCodexInvocationForTests(async session => {
      const original = await fs.readFile(path.join(session.home, 'config.toml'), 'utf8');
      await fs.writeFile(path.join(session.home, 'config.toml'), `model_provider = "fixture"\n${original}\n[model_providers.fixture]\nname = "Fixture"\nbase_url = ${JSON.stringify(f.endpoint.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
      const env = {};
      for (const name of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name];
      Object.assign(env, { CODEX_HOME: session.home, HOME: session.home, USERPROFILE: session.home });
      return { ...bin, cwd: session.home, env: applyAgentCliCaptureEnv(env, bin.command) };
    });
    for (const [index, call] of [
      { id: 'unexposed_command', name: 'exec_command', args: { cmd: write(path.join(f.workspace, 'forbidden-command.txt')) } },
      { id: 'unexposed_edit', name: 'apply_patch', code: patch(path.join(f.workspace, 'forbidden-edit.txt')) },
    ].entries()) {
      f.endpoint.scripts.push({ calls: [call] }, { text: 'Fixture rejected native call.' });
      const state = createGenerationState({ providerId: 'codex-cli', chatId: `native-denied-${index}`, body: {
        model: 'gpt-5.5', stream: true, messages: [{ role: 'user', content: 'Run fixture.' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
        minnow_native_policy: { allow: true, workspace: f.workspace }, // untrusted request cannot grant native authority
      } }); states.push(state);
      await pumpCodexAppServer({ state, runtime: { profile: { agentCli: { kind: 'codex' } }, secrets: { codexAuthPath: auth } },
        candidate: { providerId: 'codex-cli', modelId: 'gpt-5.5' }, index: 0, idleMs: 5000, maxMs: 15000, canFailover: false });
      assert.equal(state.status, 'complete', state.errorMessage);
      const returned = f.endpoint.requests.at(-1).input.find(item => item.call_id === call.id && item.type.endsWith('output'));
      assert.match(returned.output, /unsupported|not found|not available|unrecognized|unknown|No usable execution environment/i);
      assert.equal(await exists(path.join(f.workspace, 'forbidden-command.txt')), false);
      assert.equal(await exists(path.join(f.workspace, 'forbidden-edit.txt')), false);
    }
  } finally {
    await shutdownCodexSessions(); __setCodexInvocationForTests();
    for (const state of states) clearTimeout(state.evictTimer);
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache(); await f.close();
  }
});

// These tests assert observed exclusions, NOT a product capability grant. If an
// upstream behavior changes, review the matrix rather than loosening assertions.
test('Windows default sandbox configuration is not an OS read-only boundary', installed, async t => {
  const f = await createNativeEnforcementFixture();
  try {
    const file = path.join(f.workspace, 'readonly-command-exec.txt');
    const result = await f.command(['cmd.exe', '/d', '/c', 'echo NATIVE_WRITE_MARKER > readonly-command-exec.txt'], { type: 'readOnly', networkAccess: false });
    assert.equal(result.exitCode, 0);
    assert.match(await fs.readFile(file, 'utf8'), /NATIVE_WRITE_MARKER/);
    t.diagnostic('0.166.0 Windows: command/exec readOnly without explicit windows.sandbox wrote a scratch marker. Do not admit native mode based on protocol policy alone.');
  } finally { await f.close(); }
});

test('MXC read-only enforces Plan writes but does not isolate private-home reads', installed, async t => {
  const f = await createNativeEnforcementFixture({ windowsSandbox: 'mxc' });
  try {
    const allowed = await f.turn({ cmd: read(path.join(f.workspace, 'allowed.txt')) });
    assert.match(allowed.output, /NATIVE_ALLOWED_MARKER/);
    assert.equal(allowed.approvals.length, 0);
    const privateRead = await f.turn({ cmd: read(path.join(f.home, 'private-marker.txt')) });
    assert.match(privateRead.output, /NATIVE_PRIVATE_MARKER/);
    assert.equal(privateRead.approvals.length, 0);
    const shellWrite = await f.turn({ cmd: write(path.join(f.workspace, 'plan-shell.txt')) });
    assert.equal(await exists(path.join(f.workspace, 'plan-shell.txt')), false);
    assert.match(shellWrite.output, /denied|blocked|read.only/i);
    const edit = await f.turn({ patch: patch('plan-patch.txt') });
    assert.equal(await exists(path.join(f.workspace, 'plan-patch.txt')), false);
    assert.match(edit.output, /denied|rejected|approval/i);
    assert.equal(edit.approvals.length, 0, 'never must not solicit an escalation');
    t.diagnostic('MXC readOnly: permitted read worked; shell/patch Plan writes had no effect; private CODEX_HOME marker was readable without approval.');
  } finally { await f.close(); }
});

test('MXC scoped profiles constrain shell effects; approvals and patch escalation need trusted admission', installed, async t => {
  const f = await createNativeEnforcementFixture({ windowsSandbox: 'mxc', scoped: true });
  try {
    const allowed = await f.turn({ profile: 'minnow-read', cmd: read(path.join(f.workspace, 'allowed.txt')) });
    assert.match(allowed.output, /NATIVE_ALLOWED_MARKER/);
    assert.equal(allowed.approvals.length, 0, 'never is not Ask-for-every-read');
    for (const file of [path.join(f.home, 'private-marker.txt'), path.join(f.outside, 'outside-marker.txt')]) {
      const result = await f.turn({ profile: 'minnow-read', cmd: read(file) });
      assert.doesNotMatch(result.output, /NATIVE_PRIVATE_MARKER|NATIVE_OUTSIDE_MARKER/);
      assert.match(result.output, /denied|blocked/i);
    }
    await fs.symlink(f.outside, path.join(f.workspace, 'junction'), 'junction');
    const escape = await f.turn({ profile: 'minnow-read', cmd: read(path.join(f.workspace, 'junction', 'outside-marker.txt')) });
    assert.doesNotMatch(escape.output, /NATIVE_OUTSIDE_MARKER/);
    const plan = await f.turn({ profile: 'minnow-read', cmd: write(path.join(f.workspace, 'profile-plan.txt')) });
    assert.equal(await exists(path.join(f.workspace, 'profile-plan.txt')), false);
    assert.match(plan.output, /denied|blocked/i);
    const shell = await f.turn({ profile: 'minnow-write', cmd: write(path.join(f.workspace, 'allowed-shell.txt')) });
    assert.match(await fs.readFile(path.join(f.workspace, 'allowed-shell.txt'), 'utf8'), /NATIVE_WRITE_MARKER/);
    assert.equal(shell.approvals.length, 0, 'Allowed in-sandbox shell effects bypass an approval-only admission hook.');
    const outsideWrite = path.join(f.outside, 'denied-shell.txt');
    await f.turn({ profile: 'minnow-write', cmd: write(outsideWrite), workdir: f.outside });
    assert.equal(await exists(outsideWrite), false, 'A model-controlled workdir cannot expand the workspace roots.');

    const target = path.join(f.workspace, 'approval-patch.txt');
    let inspected = 0;
    const decision = value => async row => {
      assert.equal(row.method, 'item/fileChange/requestApproval');
      const { threadId, turnId, itemId } = row.params;
      assert.ok(threadId && turnId && itemId);
      const item = f.events.find(event => event.method === 'item/started' && event.params.threadId === threadId
        && event.params.turnId === turnId && event.params.item?.id === itemId)?.params.item;
      assert.equal(item.type, 'fileChange');
      assert.equal(item.changes[0].path, target);
      assert.equal(await exists(target), false, 'Approval precedes the write.');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await exists(target), false, 'No effect while approval is held.');
      inspected++;
      return value;
    };
    const denied = await f.turn({ profile: 'minnow-write', approvalPolicy: 'untrusted', patch: patch('approval-patch.txt'), decision: decision('decline') });
    assert.equal(denied.approvals.length, 1);
    assert.equal(await exists(target), false);
    const accepted = await f.turn({ profile: 'minnow-write', approvalPolicy: 'untrusted', patch: patch('approval-patch.txt'), decision: decision('accept') });
    assert.equal(accepted.approvals.length, 1);
    assert.equal(await fs.readFile(target, 'utf8'), 'NATIVE_PATCH_MARKER\n');
    assert.equal(inspected, 2);
    const nativeTest = "require('node:assert/strict').equal(require('node:fs').readFileSync('approval-patch.txt','utf8'),'NATIVE_PATCH_MARKER\\n'); console.log('NATIVE_TEST_OK');";
    const tested = await f.turn({ profile: 'minnow-read', cmd: `& ${psQuote(process.execPath)} -e ${psQuote(nativeTest)}` });
    assert.match(tested.output, /NATIVE_TEST_OK/);
    // An explicit deny entry survives approval; a read grant alone does not
    // prevent an accepted file-change from writing. Plan must deny the request.
    const escalated = path.join(f.outside, 'accepted-patch-escape.txt');
    const escalation = await f.turn({ profile: 'minnow-read', approvalPolicy: 'untrusted', patch: patch(escalated),
      decision: async row => {
        assert.equal(row.method, 'item/fileChange/requestApproval');
        assert.equal(await exists(escalated), false);
        return 'accept';
      } });
    assert.equal(escalation.approvals.length, 1);
    assert.equal(await exists(escalated), false, String(escalation.output));
    const planApproved = path.join(f.workspace, 'accepted-plan-patch.txt');
    const planEscalation = await f.turn({ profile: 'minnow-read', approvalPolicy: 'untrusted', patch: patch('accepted-plan-patch.txt'),
      decision: async row => {
        assert.equal(row.method, 'item/fileChange/requestApproval');
        assert.equal(await exists(planApproved), false);
        return 'accept';
      } });
    assert.equal(planEscalation.approvals.length, 1);
    assert.equal(await fs.readFile(planApproved, 'utf8'), 'NATIVE_PATCH_MARKER\n');
    // A real native command remains usable without granting arbitrary networking.
    const networkBlocked = await f.turn({ profile: 'minnow-write', cmd: f.networkCommand });
    assert.equal(f.networkHits, 0);
    assert.doesNotMatch(networkBlocked.output, /NATIVE_NETWORK_MARKER/);
    const networkControl = await f.turn({ profile: 'network-control', cmd: f.networkCommand });
    assert.equal(f.networkHits, 1, 'Positive control proves the listener and command actually work.');
    assert.match(networkControl.output, /NATIVE_NETWORK_MARKER/);
    assert.equal(await exists(path.join(f.home, 'auth.json')), false);
    const cancelledFile = path.join(f.workspace, 'cancelled-patch.txt');
    const cancelled = await f.turn({ profile: 'minnow-write', approvalPolicy: 'untrusted', patch: patch('cancelled-patch.txt'), expectedStatus: 'interrupted',
      decision: async row => {
        assert.equal(row.method, 'item/fileChange/requestApproval');
        assert.equal(await exists(cancelledFile), false);
        return 'cancel';
      } });
    assert.equal(cancelled.approvals.length, 1);
    assert.equal(await exists(cancelledFile), false);
    t.diagnostic('MXC scoped: reads/shell writes work; Plan, private/outside/junction reads, outside shell writes and network-off deny. Held/declined patch approval prevents effect; accept overrides workspace read permission but not explicit outside deny. An OS profile is not a trusted Minnow action-admission bridge.');
  } finally { await f.close(); }
});
