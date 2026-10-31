import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { await environment?.dispose(); });

test('production admission retains a saved empty options clear in its queued command and original profile without making inherited model selection exact', async t => {
  const f = await environment.fixture(t, { respond: async () => 'No inference expected.', toolNames: [], chats: { coordinator: {} } });
  f.modelAdapters.listModels = async () => [{ id: 'model', reasoning: { allowed_options: ['off', 'low', 'high'], default: 'high' } }];
  const target = await f.runtime.context.resolveTarget('coordinator');
  f.repository.ensureManagedChat('coordinator', { projectId: target.scope.projectId });
  const pair = { providerId: f.providerId, modelId: 'model' };
  f.repository.saveProfile('coordinator', { profileId: 'cleared-profile', profileVersion: 1,
    snapshot: { policy: target.policy, modelSelection: { ...pair, options: { reasoningEffort: 'high' } }, exactModel: false } });
  f.repository.saveProfile('coordinator', { profileId: 'cleared-profile', profileVersion: 2,
    snapshot: { policy: target.policy, modelSelection: { ...pair, options: {} }, exactModel: false } });
  const { caller } = await f.runtime.context.humanCaller('coordinator', { workspacePath: f.workspace, ingress: 'cli' });
  const receipt = await f.runtime.service.send(caller, { chatId: 'coordinator', message: 'Queue with the cleared next-message controls.', mode: 'queue', clientRequestId: 'cleared-options' });
  const command = f.repository.getCommand(receipt.commandId);
  assert.deepEqual(command.effectiveCommand.modelSelection, { ...pair, options: {} });
  assert.equal(command.captured.profile.snapshot.exactModel, false, 'catalog revalidation does not change saved role-fallback policy');
  assert.equal(command.captured.profile.profileVersion, 2);
  f.repository.saveProfile('coordinator', { profileId: 'cleared-profile', profileVersion: 3,
    snapshot: { policy: target.policy, modelSelection: { ...pair, options: { reasoningEffort: 'high' } }, exactModel: true } });
  assert.deepEqual(f.repository.getCommand(receipt.commandId).effectiveCommand.modelSelection.options, {});
  assert.deepEqual(f.repository.getProfile('cleared-profile', 2).snapshot.modelSelection.options, {});
  assert.equal(f.calls.length, 0);
});
