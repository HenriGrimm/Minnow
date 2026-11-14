import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';

test('Windows Supabase installation uses the guide; installed CLI retains sign-in', async () => {
  const window = new Window();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const commands: string[] = [];
  mock.module('../../src/ui/github-account.ts', {
    namedExports: { mountGitHubAccount: () => () => {} },
  });
  mock.module('../../src/ui/terminal-command-launcher.ts', {
    namedExports: { runCommandInNewTerminal: async (build: Function) => {
      commands.push(build({ shell: 'powershell.exe' }));
    } },
  });
  mock.module('../../src/ui/toast.ts', {
    namedExports: { notify: () => {}, showToast: () => {} },
  });
  globalThis.document = window.document as unknown as Document;
  let installed = false;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    platform: 'win32',
    connections: {
      fly: { state: 'missing' }, clerk: { state: 'missing' },
      supabase: installed ? { state: 'signed-out', bin: 'supabase' } : { state: 'missing' },
    },
  }))) as typeof fetch;
  try {
    const { renderExternalConnections } = await import('../../src/ui/settings-external-connections.ts');
    const mount = document.createElement('div');
    renderExternalConnections(mount);
    await new Promise(resolve => setTimeout(resolve, 0));
    const row = mount.querySelector('[data-settings-search-key="externalConnections.supabase"]')!;
    assert.equal(row.querySelector('button')!.hidden, true);
    const guide = row.querySelector('a')!;
    assert.equal(guide.hidden, false);
    assert.equal(guide.href, 'https://supabase.com/docs/guides/local-development/cli/getting-started');
    assert.deepEqual(commands, []);
    installed = true;
    (mount.querySelector('button') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const signIn = row.querySelector('button')!;
    assert.equal(signIn.hidden, false);
    assert.equal(signIn.textContent, 'Sign in');
    signIn.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(commands, ['& { Set-Location -LiteralPath $env:USERPROFILE -ErrorAction Stop; supabase login }']);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    await window.happyDOM.close();
    mock.restoreAll();
  }
});
