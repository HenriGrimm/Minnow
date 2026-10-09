import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mountReefExport } from '../../src/ui/reef-export.ts';
import type { ReefApp } from '../../src/reef/types.ts';

const fixture = (): ReefApp => ({
  version: 1, templateVersion: 1, id: 'app-1', name: 'Desk Pet', description: 'A desktop companion',
  modelId: 'local', createdAt: 1, updatedAt: 2, status: 'ready',
  release: { id: 'release-2', commit: 'abc', createdAt: 2 },
  runs: [], exports: [], chatIds: [], messages: [],
});

async function withDom(callback: (host: HTMLElement, dom: Window) => Promise<void>) {
  const dom = new Window();
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = dom.document as unknown as Document;
  const host = document.createElement('section'); document.body.append(host);
  try { await callback(host, dom); }
  finally { globalThis.document = previous.document; globalThis.fetch = previous.fetch; await dom.happyDOM.abort(); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('export snapshots preserve selections, focused actions and open logs while builds finish', async () => {
  await withDom(async (host, dom) => {
    const app = fixture();
    app.exports.push({ id: 'export-1', method: 'local', target: 'win32', arch: 'x64', releaseId: 'release-1', status: 'building', log: 'Packaging app' });
    globalThis.fetch = (async () => Response.json({ platform: 'win32', arch: 'x64', docker: true, github: true })) as typeof fetch;
    const view = mountReefExport(host, app, async () => {});
    await view.open();
    const target = host.querySelector<HTMLSelectElement>('[aria-label="Export operating system"]')!;
    const arch = host.querySelector<HTMLSelectElement>('[aria-label="Export architecture"]')!;
    const method = host.querySelector<HTMLSelectElement>('[aria-label="Export method"]')!;
    assert.equal(method.value, 'local');
    target.value = 'linux'; target.dispatchEvent(new dom.Event('change'));
    assert.equal(method.value, 'source'); assert.ok(!Array.from(method.options).some(option => option.value === 'local'));
    method.value = 'docker'; method.dispatchEvent(new dom.Event('change')); arch.value = 'arm64';
    const details = host.querySelector<HTMLDetailsElement>('.reef-export-log')!; details.open = true;
    assert.match(host.textContent!, /Windows · x64/); assert.match(host.textContent!, /Previous version/);
    assert.equal(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, true);
    app.exports[0] = { ...app.exports[0], status: 'ready', filename: 'desk-pet.exe', log: 'Packaging app\nDone' };
    view.update(app);
    assert.equal(host.querySelector('.reef-export-log'), details); assert.equal(details.open, true);
    assert.match(details.textContent!, /Done/); assert.match(host.textContent!, /Ready to download/);
    assert.equal(target.value, 'linux'); assert.equal(arch.value, 'arm64'); assert.equal(method.value, 'docker');
    const download = host.querySelector<HTMLButtonElement>('[aria-label="Download desk-pet.exe"]')!;
    download.focus(); view.update(app); assert.equal(document.activeElement, download);
    assert.equal(download.hidden, false); assert.equal(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, false);
    target.value = 'darwin'; target.dispatchEvent(new dom.Event('change'));
    assert.equal(method.value, 'source'); assert.ok(!Array.from(method.options).some(option => option.value === 'docker'));
  });
});

test('exports submit once, refresh in place, and retry the failed target and architecture', async () => {
  await withDom(async (host, dom) => {
    const app = fixture(); const requests: unknown[] = [];
    let finish: () => void = () => {};
    globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      if (String(url).endsWith('/capabilities')) return Response.json({ platform: 'win32', arch: 'x64', docker: false, github: false });
      requests.push(JSON.parse(String(options?.body)));
      await new Promise<void>(resolve => { finish = resolve; });
      const item = { id: `export-${requests.length}`, target: 'linux', arch: 'arm64', method: 'source', releaseId: 'release-2', status: 'queued' as const };
      app.exports.push(item); return Response.json(item);
    }) as typeof fetch;
    let refreshes = 0;
    const view = mountReefExport(host, app, async () => { refreshes++; view.update(app); });
    await view.open();
    const target = host.querySelector<HTMLSelectElement>('[aria-label="Export operating system"]')!;
    target.value = 'linux'; target.dispatchEvent(new dom.Event('change'));
    host.querySelector<HTMLSelectElement>('[aria-label="Export architecture"]')!.value = 'arm64';
    const form = host.querySelector('form')!;
    form.dispatchEvent(new dom.Event('submit', { cancelable: true }));
    form.dispatchEvent(new dom.Event('submit', { cancelable: true })); await tick();
    assert.equal(requests.length, 1); assert.equal(form.getAttribute('aria-busy'), 'true');
    finish(); await tick(); await tick();
    assert.equal(refreshes, 1); assert.match(host.textContent!, /Queued/);
    assert.equal(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, true);
    app.exports[0] = { ...app.exports[0], status: 'failed', error: 'Compiler unavailable', log: 'Could not build' }; view.update(app);
    assert.match(host.querySelector('.reef-export-row .reef-export-error')!.textContent!, /Compiler unavailable/);
    target.value = 'win32'; target.dispatchEvent(new dom.Event('change'));
    const retry = host.querySelector<HTMLButtonElement>('[aria-label="Retry Linux export"]')!;
    retry.click(); retry.click(); await tick();
    assert.deepEqual(requests[1], { target: 'linux', arch: 'arm64', method: 'source', cloudConsent: false });
    assert.equal(requests.length, 2); finish(); await tick(); await tick();
  });
});

test('capability failures can be recovered with refresh without leaving enabled invalid controls', async () => {
  await withDom(async host => {
    let failed = true;
    globalThis.fetch = (async () => failed ? Response.json({ error: 'Tool server unavailable' }, { status: 503 }) : Response.json({ platform: 'darwin', arch: 'arm64', docker: false, github: true })) as typeof fetch;
    const view = mountReefExport(host, fixture(), async () => {});
    await view.open();
    assert.equal(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, true);
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Tool server unavailable/);
    failed = false;
    host.querySelector<HTMLButtonElement>('.reef-export-refresh')!.click(); await tick(); await tick();
    assert.equal(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, false);
    assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="Export operating system"]')!.value, 'darwin');
    assert.equal(host.querySelector<HTMLElement>('[role="alert"]')!.hidden, true);
  });
});
