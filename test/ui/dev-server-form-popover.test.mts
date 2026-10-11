import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { openDevServerFormPopover } from '../../src/ui/dev-server-form-popover.ts';
import { isChromePopoverOpen, resetChromePopoverRegistryForTests } from '../../src/ui/preview-electron-visibility.ts';
import type { DevServerListItem } from '../../src/config/dev-servers-api.ts';

let win: InstanceType<typeof Window>;
let close: (() => void) | undefined;
let anchor: HTMLButtonElement;

beforeEach(() => {
  win = new Window();
  installHappyDomGlobals(win);
  resetChromePopoverRegistryForTests();
  anchor = document.createElement('button');
  document.body.append(anchor);
});

afterEach(async () => {
  close?.();
  close = undefined;
  await teardownHappyDomAsync(win);
});

const field = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const form = () => document.querySelector<HTMLFormElement>('#devServerFormPopover form')!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(overrides: Partial<Parameters<typeof openDevServerFormPopover>[0]> = {}) {
  close = openDevServerFormPopover({
    anchor,
    workspacePath: '/repo',
    worktrees: [{ value: '/repo', label: 'main (workspace)' }],
    getPorts: () => [],
    nextFreePort: async () => 3001,
    onSave: async () => {},
    onSaved: () => {},
    onClose: () => {},
    ...overrides,
  });
}

const existing: DevServerListItem = {
  id: 'web', name: 'Website', status: 'stopped', runId: null, pid: null,
  healthOk: null, startedAt: null, portInUse: false, port: 5173, network: 'lan',
  command: 'pnpm dev', healthUrl: 'http://localhost:5173/', error: null,
  def: {
    id: 'web', name: 'Website', command: 'pnpm dev', cwd: 'apps/web',
    port: 5173, network: 'lan', healthUrl: 'http://localhost:5173/',
    worktreeRoot: '/linked', autoStart: true, source: 'user',
  },
};

test('new server keeps advanced fields collapsed and saves safe defaults', async () => {
  const submissions: unknown[] = [];
  let saved = 0;
  open({ onSave: async (values) => { submissions.push(values); }, onSaved: () => { saved++; } });
  assert.equal(document.activeElement, field('command'));
  assert.equal(document.querySelector('details')!.open, false);
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(isChromePopoverOpen(), true);
  field('command').value = ' npm run dev ';
  form().requestSubmit();
  await settle();
  assert.deepEqual(submissions, [{
    name: 'Web app', command: 'npm run dev', cwd: '.', port: 3000,
    network: 'local', healthUrl: '', autoStart: false, worktreeRoot: '',
  }]);
  assert.equal(saved, 1);
  assert.equal(document.querySelector('#devServerFormPopover'), null);
  assert.equal(isChromePopoverOpen(), false);
  assert.equal(document.activeElement, anchor);
});

test('invalid basics do not submit and invalid advanced fields are revealed', () => {
  let submissions = 0;
  open({ onSave: async () => { submissions++; } });
  form().requestSubmit();
  field('command').value = 'npm run dev';
  field('port').value = '65536';
  form().requestSubmit();
  assert.equal(submissions, 0);
  field('port').value = '5173';
  field('healthUrl').value = 'not a URL';
  form().requestSubmit();
  assert.equal(document.querySelector('details')!.open, true);
  assert.equal(submissions, 0);
});

test('editing preserves advanced settings when collapsed and allows clearing health URL', async () => {
  const submissions: unknown[] = [];
  open({ existing, onSave: async (values) => { submissions.push(values); } });
  // A configured checkout absent from the latest list must not silently become the workspace.
  assert.equal(document.querySelector<HTMLSelectElement>('[name="worktreeRoot"]')!.value, '/linked');
  field('healthUrl').value = '';
  form().requestSubmit();
  await settle();
  assert.deepEqual(submissions, [{
    name: 'Website', command: 'pnpm dev', cwd: 'apps/web', port: 5173,
    network: 'lan', healthUrl: '', autoStart: true, worktreeRoot: '/linked',
  }]);
});

test('startup.md command fields stay locked and are not cleared on save', async () => {
  let submitted: Record<string, unknown> = {};
  open({
    existing: { ...existing, def: { ...existing.def!, source: 'startup.md' } },
    onSave: async (values) => { submitted = values; },
  });
  assert.equal(field('command').disabled, true);
  assert.equal(field('cwd').disabled, true);
  assert.equal(field('healthUrl').disabled, true);
  assert.equal(document.activeElement, field('name'));
  form().requestSubmit();
  await settle();
  assert.equal(submitted.command, 'pnpm dev');
  assert.equal('healthUrl' in submitted, false);
  assert.equal('cwd' in submitted, false);
});

test('save failures keep the draft and allow retry without duplicate in-flight requests', async () => {
  let rejectSave!: (error: Error) => void;
  let requests = 0;
  open({ onSave: () => {
    requests++;
    return new Promise((_, reject) => { rejectSave = reject; });
  } });
  field('command').value = 'npm run dev';
  form().requestSubmit();
  form().dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(requests, 1);
  rejectSave(new Error('Could not save server'));
  await settle();
  assert.equal(field('command').value, 'npm run dev');
  assert.equal(document.querySelector('[role="alert"]')!.textContent, 'Could not save server');
  assert.equal(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, false);
  form().requestSubmit();
  assert.equal(requests, 2);
  rejectSave(new Error('Retry failed'));
  await settle();
});

test('free-port action resolves a conflict and preserves a newer manual port choice', async () => {
  let resolvePort!: (port: number) => void;
  open({
    getPorts: () => [{ port: 3000, pid: 42, process: 'node', address: 'localhost', protected: false }],
    nextFreePort: () => new Promise((resolve) => { resolvePort = resolve; }),
  });
  assert.match(document.querySelector('[data-role="port-warn"]')!.textContent!, /Port 3000 is in use/);
  const free = document.querySelector<HTMLButtonElement>('[data-form-action="free-port"]')!;
  free.click();
  resolvePort(3001);
  await settle();
  assert.equal(field('port').value, '3001');
  assert.equal(document.querySelector<HTMLElement>('.dev-server-screen__port-warning')!.hidden, true);
  field('port').value = '3000';
  field('port').dispatchEvent(new win.Event('input'));
  free.click();
  field('port').value = '5173';
  resolvePort(3001);
  await settle();
  assert.equal(field('port').value, '5173');
});

test('Escape closes only the popover, restores focus, and removes the preview obstruction', () => {
  let closed = 0;
  let escapedToParent = 0;
  open({ onClose: () => { closed++; } });
  const parent = () => { escapedToParent++; };
  document.addEventListener('keydown', parent);
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(closed, 1);
  assert.equal(escapedToParent, 0);
  assert.equal(document.activeElement, anchor);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(isChromePopoverOpen(), false);
  close?.();
  assert.equal(closed, 1);
  document.removeEventListener('keydown', parent);
});

test('clicking outside dismisses without moving focus back to the trigger', () => {
  open();
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  outside.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(document.querySelector('#devServerFormPopover'), null);
  assert.equal(document.activeElement, outside);
  assert.equal(isChromePopoverOpen(), false);
});
