import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderPublic } from '../../src/providers/types.ts';
import { filterGenericProviderSettingsRows } from '../../src/ui/settings-providers.ts';

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
