import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';

test('local Git ticks never poll PRs; remote ticks avoid overlapping and stop when hidden', async () => {
  const win = new Window();
  const ops: string[] = [];
  let holdForge = false;
  let release!: () => void;
  let pending: Promise<void>;
  win.fetch = async (_input, init) => {
    const { op } = JSON.parse(String(init?.body ?? '{}'));
    ops.push(op);
    if (op === 'forgeStatus' && holdForge) await pending;
    const payload = op === 'forgeStatus' ? { ok: true, supported: true, host: 'github', hostname: 'github.com', repo: 'a/b' }
      : op === 'prList' ? { ok: true, prs: [] }
        : op === 'runList' ? { ok: true, runs: [] }
          : { ok: true, current: 'main', local: ['main'], remote: [], staged: [], unstaged: [], untracked: [] };
    return new Response(JSON.stringify(payload));
  };
  installHappyDomGlobals(win, { fetch: win.fetch });
  Object.assign(globalThis, { HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement });
  setLocalServerAvailableForTests(true);
  seedMinimalSession('polling-chat');
  document.body.innerHTML = '<main id="sourceControlView"></main>';
  const timers = new Map<number, () => void>();
  win.setInterval = ((callback: () => void, ms: number) => { timers.set(ms, callback); return ms; }) as typeof win.setInterval;
  win.clearInterval = (() => {}) as typeof win.clearInterval;
  const { launchInstance, resetInstancesForTests } = await import('../../src/os/instances.ts');
  const scc = await import('../../src/ui/source-control-center.ts');
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };
  try {
    launchInstance('source-control');
    await scc.openSourceControlCenter({ section: 'pulls' });
    await scc.mountSourceControlCenter();
    await settle();
    ops.length = 0;
    assert.deepEqual([...timers.keys()].sort((a, b) => a - b), [5_000, 60_000]);
    for (let i = 0; i < 4; i++) timers.get(5_000)!();
    await settle();
    assert.ok(ops.includes('status'));
    assert.equal(ops.includes('prList'), false);
    assert.equal(ops.includes('prView'), false);
    assert.equal(ops.includes('runList'), false);
    ops.length = 0;
    holdForge = true;
    pending = new Promise<void>((resolve) => { release = resolve; });
    timers.get(60_000)!();
    timers.get(60_000)!();
    assert.equal(ops.filter((op) => op === 'forgeStatus').length, 1);
    release();
    await settle();
    assert.ok(ops.includes('prList'));
    ops.length = 0;
    launchInstance('code');
    timers.get(60_000)!();
    timers.get(5_000)!();
    await settle();
    assert.deepEqual(ops, []);
  } finally {
    scc.resetSourceControlCenterForTests();
    resetInstancesForTests();
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(win);
  }
});

