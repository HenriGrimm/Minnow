/**
 * Unit tests for server/runtime/session-token.js (MIN-381).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getSessionToken,
  injectSessionTokenScript,
  readSessionTokenFile,
  resetSessionTokenCache,
  timingSafeEqualToken,
} from '../../server/runtime/session-token.js';
import { addRequestAuthToHtml } from '../../server/runtime/spa-auth-html.js';

function navigation(host, remoteAddress) {
  return { headers: { host }, socket: { remoteAddress } };
}

let homeDir;

function setTestHome() {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  homeDir = path.join(
    '/tmp',
    `minnow-session-token-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.MINNOW_HOME = homeDir;
  return homeDir;
}

async function rmTestHome(dir) {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  delete process.env.MINNOW_HOME;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('getSessionToken', () => {
  let home;
  beforeEach(() => {
    home = setTestHome();
  });
  afterEach(() => rmTestHome(home));

  test('generates a 64-char hex token, memoized per process', () => {
    const a = getSessionToken();
    const b = getSessionToken();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test('two resets produce two different tokens', () => {
    const a = getSessionToken();
    resetSessionTokenCache();
    const b = getSessionToken();
    assert.notEqual(a, b);
  });

  test('persists the token so readSessionTokenFile can recover it', () => {
    const token = getSessionToken();
    assert.equal(readSessionTokenFile(), token);
  });

  test('restrictive permissions when supported', async () => {
    if (process.platform === 'win32') return;
    getSessionToken();
    const stat = await fs.stat(path.join(home, 'session-token'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('readSessionTokenFile', () => {
  test('returns empty string when no server has booted yet', () => {
    const home = setTestHome();
    try {
      assert.equal(readSessionTokenFile(), '');
    } finally {
      void rmTestHome(home);
    }
  });
});

describe('timingSafeEqualToken', () => {
  test('accepts matching strings', () => {
    assert.equal(timingSafeEqualToken('abc123', 'abc123'), true);
  });

  test('rejects mismatched strings', () => {
    assert.equal(timingSafeEqualToken('abc123', 'abc124'), false);
  });

  test('rejects mismatched lengths without throwing', () => {
    assert.equal(timingSafeEqualToken('short', 'a-much-longer-value'), false);
  });

  test('rejects empty/missing values', () => {
    assert.equal(timingSafeEqualToken('', 'abc123'), false);
    assert.equal(timingSafeEqualToken('abc123', ''), false);
    assert.equal(timingSafeEqualToken(undefined, 'abc123'), false);
  });
});

describe('injectSessionTokenScript', () => {
  test('injects before </head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectSessionTokenScript(html, 'deadbeef');
    assert.match(out, /<script>window\.__MINNOW_SESSION_TOKEN__="deadbeef";<\/script><\/head>/);
  });

  test('falls back to prepending when </head> is missing', () => {
    const html = '<body>no head here</body>';
    const out = injectSessionTokenScript(html, 'deadbeef');
    assert.match(out, /^<script>window\.__MINNOW_SESSION_TOKEN__="deadbeef";<\/script><body>/);
  });
});

describe('addRequestAuthToHtml', () => {
  beforeEach(() => setTestHome());
  afterEach(() => rmTestHome());

  test('injects the host token for loopback navigations', () => {
    const html = '<html><head></head><body></body></html>';
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.match(addRequestAuthToHtml(html, navigation('127.0.0.1:9473', peer)), /__MINNOW_SESSION_TOKEN__/);
    }
  });

  test('never exposes the host token to a LAN navigation', () => {
    const html = '<html><head></head><body></body></html>';
    for (const host of ['192.168.1.10:9473', '127.0.0.1:9473']) {
      const output = addRequestAuthToHtml(html, navigation(host, '192.168.1.20'));
      assert.equal(output, html);
      assert.equal(output.includes(getSessionToken()), false);
    }
  });

  test('requires a loopback Host even for a loopback peer', () => {
    const html = '<html><head></head><body></body></html>';
    assert.equal(addRequestAuthToHtml(html, navigation('192.168.1.10:9473', '127.0.0.1')), html);
  });
});
