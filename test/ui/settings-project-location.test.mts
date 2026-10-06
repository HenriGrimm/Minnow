import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { renderProjectLocationSettings } from '../../src/ui/settings-project-location';

test('project location auto-saves on change, reports errors, and resets', async () => {
  const window = new Window();
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window, document: window.document });
  const writes: string[] = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') {
      const { path } = JSON.parse(String(init.body));
      writes.push(path);
      return new Response(JSON.stringify(path === 'relative'
        ? { error: 'Choose an absolute folder path' }
        : { newProjectParent: path || '/home/user/Projects' }), { status: path === 'relative' ? 400 : 200 });
    }
    return new Response(JSON.stringify({ newProjectParent: '/projects' }));
  };
  try {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    await renderProjectLocationSettings(mount);
    const input = mount.querySelector('input')!;
    const status = mount.querySelector('[role="status"]')!;
    assert.equal(input.value, '/projects');
    input.value = '/new-projects';
    input.dispatchEvent(new window.Event('input'));
    assert.deepEqual(writes, []);
    input.dispatchEvent(new window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['/new-projects']);
    assert.equal(status.textContent, 'Saved');
    assert.equal(input.disabled, false);
    input.value = 'relative';
    input.dispatchEvent(new window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(status.textContent, 'Choose an absolute folder path');
    assert.equal(input.disabled, false);
    input.value = '';
    input.dispatchEvent(new window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(input.value, '/home/user/Projects');
    assert.equal(status.textContent, 'Saved');
  } finally {
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
