import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentCliNativeCodingCapability, assertMinnowToolMode } from '../../server/models/agent-cli-native.js';
import { validateAgentCliProfile } from '../../server/providers/validate.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../../server/generations/agent-cli/resolve-bin.js';
import { cliHash } from '../../server/generations/agent-cli/checkpoints.js';
import { pumpAgentCliUpstream } from '../../server/generations/agent-cli/pump.js';
import { createGenerationState } from '../../server/generations/store.js';

const exec = promisify(execFile);

test('native capability is unavailable for every adapter; version/platform/mode cannot grant authority', () => {
  for (const kind of ['codex', 'claude', 'cursor', 'unknown', undefined]) {
    assert.deepEqual(Object.keys(agentCliNativeCodingCapability(kind)).sort(), ['available', 'effective', 'reason']);
    assert.equal(agentCliNativeCodingCapability(kind).available, false);
    assert.equal(agentCliNativeCodingCapability(kind).effective, 'minnow');
    assert.doesNotThrow(() => assertMinnowToolMode({ kind }));
    assert.doesNotThrow(() => assertMinnowToolMode({ kind, nativeCodingTools: false }));
    for (const value of [true, 'true', 1, null]) {
      assert.throws(() => assertMinnowToolMode({ kind, nativeCodingTools: value }), error => error.cliPolicyRejected === true);
    }
  }
  assert.equal(validateAgentCliProfile({ kind: 'codex' }).nativeCodingTools, undefined);
  assert.equal(validateAgentCliProfile({ kind: 'codex', nativeCodingTools: false }).nativeCodingTools, false);
  assert.equal(validateAgentCliProfile({ kind: 'codex', nativeCodingTools: true }).nativeCodingTools, true, 'preference is not authority');
  assert.equal(agentCliNativeCodingCapability('codex', { platform: 'win32', version: '0.166.0' }).available, true);
  assert.equal(agentCliNativeCodingCapability('codex', { platform: 'linux', version: '0.166.0' }).available, false);
  assert.equal(agentCliNativeCodingCapability('codex', { platform: 'win32', version: '0.167.0' }).available, false);
  assert.throws(() => validateAgentCliProfile({ kind: 'codex', nativeCodingTools: 'false' }), /Invalid/);
  for (const kind of ['claude', 'cursor']) assert.throws(() => validateAgentCliProfile({ kind, nativeCodingTools: true }), /Codex-only/);
});

test('utility/tool-choice-none and legacy replay paths reject native opt-in without failover', async () => {
  for (const kind of ['codex', 'claude', 'cursor']) {
    const state = createGenerationState({ providerId: `fixture-${kind}`, fallbackRole: 'title', body: {
      model: 'fixture', messages: [{ role: 'user', content: 'Title only.' }], tool_choice: 'none',
    } });
    try {
      const result = await pumpAgentCliUpstream({ state,
        runtime: { profile: { agentCli: { kind, nativeCodingTools: true, allowUtilityRoles: true } }, secrets: {} },
        candidate: { providerId: `fixture-${kind}`, modelId: 'fixture' }, index: 0, canFailover: true });
      assert.equal(result.outcome, 'fatal');
      assert.equal(state.status, 'error');
      assert.match(state.errorMessage, /native coding tools/i);
    } finally { clearTimeout(state.evictTimer); }
  }
});

// No login, provider requests, live settings, native actions or paid inference.
// Regenerate for the installed binary rather than treating current web docs as
// its schema. Explicit opt-in keeps normal CI independent of CLI installation.
test('installed Codex generates the reviewed native protocol in an isolated home', {
  skip: process.env.MINNOW_CODEX_SCHEMA_SMOKE !== '1', timeout: 30_000,
}, async t => {
  const bin = await resolveAgentCliBin({ kind: 'codex' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-schema-test-'));
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, { CODEX_HOME: root, HOME: root, USERPROFILE: root });
  const options = { cwd: root, env: applyAgentCliCaptureEnv(env, bin.command), timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 };
  try {
    const version = (await exec(bin.command, [...bin.argsPrefix, '--version'], options)).stdout.trim();
    assert.equal(version, 'codex-cli 0.166.0', 'Unknown native schema version: review it before updating this fixture; native execution stays off.');
    const out = path.join(root, 'schemas');
    await exec(bin.command, [...bin.argsPrefix, 'app-server', 'generate-json-schema', '--experimental', '--out', out], options);
    const names = ['v2/ThreadStartParams.json', 'v2/TurnStartParams.json', 'v2/ThreadReadParams.json',
      'v2/ThreadTurnsListParams.json', 'CommandExecutionRequestApprovalParams.json', 'FileChangeRequestApprovalParams.json'];
    const schemas = {}, digests = {};
    for (const name of names) {
      const bytes = await fs.readFile(path.join(out, name));
      schemas[name] = JSON.parse(bytes); digests[name] = cliHash(bytes);
    }
    const start = schemas[names[0]], turn = schemas[names[1]], read = schemas[names[2]], pages = schemas[names[3]];
    assert.deepEqual(start.definitions.SandboxMode.enum, ['read-only', 'workspace-write', 'danger-full-access']);
    assert.deepEqual(start.definitions.ThreadHistoryMode.enum, ['legacy', 'paginated']);
    assert.deepEqual(start.definitions.AskForApproval.oneOf[0].enum, ['untrusted', 'on-request', 'never']);
    const readonly = turn.definitions.SandboxPolicy.oneOf.find(row => row.title === 'ReadOnlySandboxPolicy');
    assert.equal(readonly.properties.networkAccess.default, false);
    assert.ok(read.properties.includeTurns);
    assert.ok(pages.properties.cursor);
    assert.ok(pages.properties.itemsView);
    for (const name of names.slice(4)) {
      for (const key of ['threadId', 'turnId', 'itemId']) assert.ok(schemas[name].required.includes(key));
    }
    // These are protocol shape checks, not proof of sandbox/approval enforcement.
    assert.equal(agentCliNativeCodingCapability('codex').available, false);
    t.diagnostic(JSON.stringify({ version, platform: process.platform, arch: process.arch, schemaDigests: digests }));
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
