import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedExternalUrl,
  isAllowedShellNavigation,
  isTrustedShellIpcSource,
} from '../../electron/navigation-policy.ts';

test('external URL dispatch allows web and mail links but rejects privileged schemes', () => {
  assert.equal(allowedExternalUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(allowedExternalUrl('mailto:dev@example.com'), 'mailto:dev@example.com');
  for (const url of [
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi',
    'ms-settings:privacy', 'vscode://open', 'https://user:pass@example.com',
    '//example.com', 'not a url',
  ]) assert.equal(allowedExternalUrl(url), null, url);
});

test('shell navigation accepts hash routes only within its app document', () => {
  const app = 'http://127.0.0.1:9473/';
  assert.equal(isAllowedShellNavigation('http://127.0.0.1:9473/#/app/code', app), true);
  for (const url of [
    'http://127.0.0.1:9473/api/tools',
    'http://localhost:9473/',
    'https://example.com/',
    'file:///tmp/index.html',
    'data:text/html,hi',
  ]) assert.equal(isAllowedShellNavigation(url, app), false, url);
});

test('privileged IPC requires registered main frame at the app document', () => {
  const frame = {};
  const base = {
    senderId: 7,
    trustedIds: new Set([7]),
    senderFrame: frame,
    mainFrame: frame,
    senderUrl: 'http://127.0.0.1:9473/#/app/code',
    appUrl: 'http://127.0.0.1:9473/',
  };
  assert.equal(isTrustedShellIpcSource(base), true);
  assert.equal(isTrustedShellIpcSource({ ...base, senderFrame: {} }), false);
  assert.equal(isTrustedShellIpcSource({ ...base, trustedIds: new Set() }), false);
  assert.equal(isTrustedShellIpcSource({ ...base, senderUrl: 'https://example.com' }), false);
  assert.equal(isTrustedShellIpcSource({ ...base, appUrl: null }), false);
});
