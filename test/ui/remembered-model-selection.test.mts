import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { persistDefaultModelValue, readDefaultModelBinding, resolveEffectiveChatModelBinding, loadDefaultModelValue } from '../../src/models/selection.ts';
import { captureLaunchModel } from '../../src/models/launch-selection.ts';

test('launch overrides and reopening older chats do not change the remembered selection', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
  setStorageModeForTests('localStorage');
  await persistDefaultModelValue('provider\u001fnew-model');
  assert.equal(resolveEffectiveChatModelBinding({ providerId: 'other', modelId: 'old-model' }).modelId, 'old-model');
  const launch = await captureLaunchModel('launch\u001fspecific');
  assert.deepEqual(launch, { providerId: 'launch', modelId: 'specific' });
  assert.equal(readDefaultModelBinding().modelId, 'new-model');
  await persistDefaultModelValue('provider\u001flater');
  assert.equal(launch.modelId, 'specific');
  setStorageModeForTests(null);
});

test('a stale preference read cannot replace a newer explicit selection', async () => {
  const original = globalThis.fetch;
  let resolveRead!: (value: Response) => void;
  setStorageModeForTests('server');
  globalThis.fetch = (async (_url, init) => init?.method === 'PUT' ? Response.json({ revision: 20 }) : await new Promise<Response>((resolve) => { resolveRead = resolve; })) as typeof fetch;
  try {
    const reading = loadDefaultModelValue(); await new Promise((resolve) => setTimeout(resolve, 0));
    await persistDefaultModelValue('provider\u001fexplicit');
    resolveRead(Response.json({ value: 'provider\u001fstale', revision: 1 })); await reading;
    assert.equal(readDefaultModelBinding().modelId, 'explicit');
  } finally { globalThis.fetch = original; setStorageModeForTests(null); }
});


test('a stale provider without a chat model cannot contaminate the remembered binding', async () => {
  setStorageModeForTests('localStorage');
  await persistDefaultModelValue('remembered-provider\u001fremembered-model');
  assert.deepEqual(resolveEffectiveChatModelBinding({ providerId: 'stale-provider', modelId: '' }), {
    providerId: 'remembered-provider', modelId: 'remembered-model', selectValue: 'remembered-provider\u001fremembered-model',
  });
  setStorageModeForTests(null);
});


test('issue reasoning is isolated, cleared on model changes and consumed with launch selection', async () => {
  const { issueLaunchReasoning, setIssueLaunchReasoning, setIssueLaunchModel, clearIssueLaunchModel } = await import('../../src/models/launch-selection.ts');
  const key = 'workspace\0ISSUE-1';
  setIssueLaunchModel(key, 'provider\u001fmodel');
  setIssueLaunchReasoning(key, 'high');
  assert.equal(issueLaunchReasoning(key), 'high');
  assert.equal(issueLaunchReasoning('other\0ISSUE-1'), undefined);
  setIssueLaunchModel(key, 'provider\u001fmodel');
  assert.equal(issueLaunchReasoning(key), 'high');
  setIssueLaunchModel(key, 'provider\u001fother');
  assert.equal(issueLaunchReasoning(key), undefined);
  setIssueLaunchReasoning(key, 'off');
  clearIssueLaunchModel(key);
  assert.equal(issueLaunchReasoning(key), undefined);
});
