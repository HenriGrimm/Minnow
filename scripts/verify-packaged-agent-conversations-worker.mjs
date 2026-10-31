import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGED_AGENT_CHECKS, PACKAGED_AGENT_RECEIPT } from './verify-packaged-agent-conversations.mjs';

const checks = [];
let failedCheck = 'asar-esm-runtime', closeSessionsDb, runtime;
const app = path.resolve(process.argv[2] ?? '');
const home = path.resolve(process.env.MINNOW_HOME ?? '');
const packed = relative => import(pathToFileURL(path.join(app, relative)).href);
// This probe needs no network. A newly added fetch side effect must fail the gate.
globalThis.fetch = async () => { throw new Error('Packaged verification does not permit network requests'); };
async function check(name, operation) { failedCheck = name; await operation(); checks.push(name); }

try {
  let createChatRepository, createProductionChatRuntime, loadChatPreparationComposer, captureChatProfile, exportChatArchive;
  await check('asar-esm-runtime', async () => {
    assert.ok(process.versions.electron, 'Use the supplied packaged Electron executable');
    assert.equal(path.basename(app), 'app.asar');
    assert.equal(path.resolve(process.cwd()), home);
    const { ensureMinnowLayout } = await packed('server/config/home.js');
    await ensureMinnowLayout();
    ({ createChatRepository } = await packed('server/chats/repository.js'));
    ({ createProductionChatRuntime } = await packed('server/chats/runtime.js'));
    ({ loadChatPreparationComposer, captureChatProfile } = await packed('server/chats/preparation.js'));
    ({ exportChatArchive } = await packed('server/chats/archive.js'));
    ({ closeSessionsDb } = await packed('server/config/sessions-db.js'));
  });
  let repository;
  await check('native-sqlite', async () => {
    repository = createChatRepository();
    assert.equal(typeof repository.getDatabase().prepare('SELECT sqlite_version() AS version').get().version, 'string');
  });
  await check('canonical-transcript', async () => {
    const workspace = path.join(home, 'workspace'); await fs.mkdir(workspace, { recursive: true });
    repository.createChat({ id: 'packaged-probe', name: 'Packaged probe', workspacePath: workspace, modeId: 'general' });
    const fence = repository.claimExecution({ chatId: 'packaged-probe', executionId: 'packaged-execution', ownerId: 'packaged-host' });
    repository.appendMessage('packaged-probe', { role: 'assistant', content: 'Packaged canonical transcript.' }, { fence, messageId: 'packaged-message' });
    repository.updateExecution('packaged-execution', { status: 'completed' }, { fence });
    repository.releaseLease('packaged-probe', fence);
    assert.equal(repository.readTranscript('packaged-probe').messages[0].content, 'Packaged canonical transcript.');
  });
  await check('archive', async () => {
    const archive = exportChatArchive(repository.getDatabase());
    assert.equal(archive.version, 1);
    assert.ok(archive.tables.chat_message_identities.some(row => row.message_id === 'packaged-message'));
  });
  await check('composer-bundle', async () => {
    const composer = await loadChatPreparationComposer();
    assert.equal(typeof composer.composeChatPrompt, 'function');
  });
  await check('packaged-prompt-capture', async () => {
    const profile = await captureChatProfile(repository.getChat('packaged-probe'), {
      projectId: 'packaged-project', workspaceId: 'packaged-workspace', canonicalKey: path.join(home, 'workspace'),
    }, { workspaceIds: ['packaged-workspace'], modelSelection: { providerId: 'fixture', modelId: 'fixture' } });
    const bodies = Object.values({ ...profile.prompt.sources.builtinRaw, ...profile.prompt.sources.userRaw });
    assert.ok(bodies.some(body => typeof body === 'string' && body.trim()), 'Capture actual prompt assets from the packaged app');
    assert.equal(profile.policy.modeId, 'general');
  });
  await check('manual-assets', async () => {
    const manual = await fs.readFile(path.join(path.dirname(app), 'documentation/manual/chat/chatting.md'), 'utf8');
    assert.ok(manual.trim());
  });
  await check('runtime-dispose', async () => {
    runtime = createProductionChatRuntime({ repository, generations: () => [] });
    await runtime.dispose(); runtime = null;
    assert.equal(repository.readTranscript('packaged-probe').messages[0].content, 'Packaged canonical transcript.');
    closeSessionsDb(); closeSessionsDb = null;
  });
  assert.equal(checks.length, PACKAGED_AGENT_CHECKS.length);
  console.log(PACKAGED_AGENT_RECEIPT + JSON.stringify({ version: 1, nonce: process.argv[3], status: 'PASS', checks }));
} catch {
  console.log(PACKAGED_AGENT_RECEIPT + JSON.stringify({ version: 1, nonce: process.argv[3], status: 'FAIL', checks, failedCheck }));
  process.exitCode = 1;
} finally {
  await runtime?.dispose().catch(() => {});
  closeSessionsDb?.();
}
