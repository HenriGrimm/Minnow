import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  const window = new Window();
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  globalThis.Node = window.Node as unknown as typeof Node;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

test('parses ACP arguments and private environment without shell expansion', async () => {
  const { parseAcpArgs, parseAcpSecretEnv } = await import(
    '../../src/ui/settings-acp-agents.ts'
  );
  assert.deepEqual(parseAcpArgs('--stdio\n\n--profile\nlocal'), [
    '--stdio',
    '--profile',
    'local',
  ]);
  assert.deepEqual(parseAcpSecretEnv('API_KEY=secret=value\nORG_ID=local'), {
    API_KEY: 'secret=value',
    ORG_ID: 'local',
  });
  assert.throws(() => parseAcpSecretEnv('not valid=value'), /Invalid environment variable name/);
});

test('registers an ACP agent from the Agents center form', async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init };
    const submitted = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        agent: {
          ...submitted,
          envKeys: Object.keys(submitted.secretEnv ?? {}),
          hasPrivateEnvironment: Boolean(Object.keys(submitted.secretEnv ?? {}).length),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const { mountAcpRegistration } = await import('../../src/ui/settings-acp-agents.ts');
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  let saved = false;
  mountAcpRegistration(mount, () => {
    saved = true;
  });

  (document.getElementById('acpAgentId-new') as HTMLInputElement).value = 'local-helper';
  (document.getElementById('acpAgentLabel-new') as HTMLInputElement).value = 'Local helper';
  (document.getElementById('acpAgentCommand-new') as HTMLInputElement).value = 'helper-acp';
  (document.getElementById('acpAgentArgs-new') as HTMLTextAreaElement).value = '--stdio\n--quiet';
  (document.getElementById('acpAgentEnv-new') as HTMLTextAreaElement).value = 'ACP_TOKEN=private';
  (mount.querySelector('button') as HTMLButtonElement).click();

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(captured);
  assert.equal(captured.url, '/api/models/acp-agents');
  assert.equal(captured.init?.method, 'POST');
  const submitted = JSON.parse(String(captured.init?.body));
  assert.deepEqual(submitted, {
    id: 'local-helper',
    label: 'Local helper',
    command: 'helper-acp',
    args: ['--stdio', '--quiet'],
    enabled: true,
    secretEnv: { ACP_TOKEN: 'private' },
  });
  assert.equal(saved, true);
  assert.match(mount.textContent ?? '', /Agent registered/);
  assert.equal((document.getElementById('acpAgentEnv-new') as HTMLTextAreaElement).value, '');
});
