import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { ProviderPublic } from '../../src/providers/types.ts';
import {
  createAgentCliProviderSettingsRow,
  filterGenericProviderSettingsRows,
} from '../../src/ui/settings-providers.ts';

function provider(
  id: string,
  apiKind: ProviderPublic['apiKind'],
): ProviderPublic {
  return {
    id,
    label: id,
    baseUrl: apiKind === 'agent-cli-v1' ? '' : 'http://localhost:1234',
    apiKind,
    enabled: true,
    hasApiKey: false,
    hasBearer: false,
  };
}

test('Settings Providers excludes CLI-managed rows from generic edit and delete controls', () => {
  const visible = filterGenericProviderSettingsRows([
    provider('lm-studio-local', 'lm-studio-v0'),
    provider('claude-code-cli', 'agent-cli-v1'),
    provider('codex-cli', 'agent-cli-v1'),
    provider('openai', 'openai-v1'),
  ]);

  assert.deepEqual(visible.map((row) => row.id), ['lm-studio-local', 'openai']);
  assert.ok(visible.every((row) => row.baseUrl));
});

test('Settings Providers shows CLI connections with their state and a management link', () => {
  const win = new Window({ url: 'http://localhost/#/app/models/providers' });
  globalThis.document = win.document as unknown as Document;
  try {
    const row = createAgentCliProviderSettingsRow(provider('codex-cli', 'agent-cli-v1'));
    assert.equal(row.dataset.providerId, 'codex-cli');
    assert.match(row.textContent ?? '', /Codex CLI|codex-cli/);
    assert.match(row.textContent ?? '', /Enabled/);
    assert.match(row.textContent ?? '', /Manage CLI/);
    assert.equal(row.querySelector('.settings-providers-edit-panel'), null);
    assert.equal(row.querySelector('[data-provider-remove]'), null);
  } finally {
    win.close();
    delete (globalThis as { document?: unknown }).document;
  }
});
