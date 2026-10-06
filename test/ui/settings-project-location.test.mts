import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { renderProjectLocationSettings } from '../../src/ui/settings-project-location';

test('project location auto-saves on blur, reports errors, and resets without a Save button', async () => {
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
    const browse = mount.querySelector('button')!;
    assert.deepEqual(Array.from(mount.querySelectorAll('button'), (button) => button.textContent), ['Browse…']);
    assert.equal(input.value, '/projects');
    input.value = '/new-projects';
    input.dispatchEvent(new window.Event('input'));
    assert.deepEqual(writes, []);
    input.dispatchEvent(new window.FocusEvent('blur'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['/new-projects']);
    assert.equal(status.textContent, 'Saved');
    assert.equal(input.disabled, false);
    input.value = 'relative';
    input.dispatchEvent(new window.FocusEvent('blur'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(status.textContent, 'Choose an absolute folder path');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.disabled, false);
    input.value = '/draft';
    input.dispatchEvent(new window.Event('input'));
    assert.equal(input.getAttribute('aria-invalid'), 'false');
    input.dispatchEvent(new window.FocusEvent('blur', { relatedTarget: browse }));
    assert.equal(browse.disabled, false);
    assert.deepEqual(writes, ['/new-projects', 'relative']);
    browse.dispatchEvent(new window.FocusEvent('blur'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(input.value, '/draft');
    input.value = '';
    input.dispatchEvent(new window.FocusEvent('blur'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(input.value, '/home/user/Projects');
    assert.equal(status.textContent, 'Default restored');
    assert.deepEqual(writes, ['/new-projects', 'relative', '/draft', '']);
    input.value = '/keyboard';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    input.dispatchEvent(new window.FocusEvent('blur'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['/new-projects', 'relative', '/draft', '', '/keyboard']);
    input.value = '/discard';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(input.value, '/keyboard');
  } finally {
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
