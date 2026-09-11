import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { loadDefaultModelValue, persistDefaultModelValue, readPersistedDefaultModelValue, resolveDefaultModelSelectValue, applyDefaultModelToChat } from '../../src/ui/default-model.ts';

test('disk preference wins over origin cache and remains bound without catalog options', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
  const original = globalThis.fetch;
  let value: string | null = 'host\u001fsaved';
  setStorageModeForTests('server');
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === 'PUT') value = JSON.parse(String(init.body)).value;
    return Response.json({ value });
  }) as typeof fetch;
  try {
    localStorage.setItem('minnow-default-model-select', 'stale-origin-model');
    await loadDefaultModelValue();
    assert.equal(readPersistedDefaultModelValue(), value);
    assert.equal(resolveDefaultModelSelectValue(['other-model']), value);
    const chat: { modelId?: string; providerId?: string } = {};
    applyDefaultModelToChat(chat);
    assert.deepEqual(chat, { providerId: 'host', modelId: 'saved' });
    await Promise.all([persistDefaultModelValue('host\u001ffirst'), persistDefaultModelValue('host\u001flast')]);
    assert.equal(value, 'host\u001flast');
    localStorage.clear();
    await loadDefaultModelValue();
    assert.equal(readPersistedDefaultModelValue(), 'host\u001flast');
  } finally {
    globalThis.fetch = original;
    setStorageModeForTests(null);
    localStorage.clear();
  }
});
