/**
 * SSRF guard tests for outgoing webhooks.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isPrivateIpAddress,
  resetSsrfCachesForTests,
  resolveWebhookTarget,
  sanitizeError,
  validateWebhookUrl,
} from '../../server/webhooks/ssrf.js';

describe('validateWebhookUrl', () => {
  test('rejects private IPv4 literals', async () => {
    const privateUrls = [
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://192.168.0.1/hook',
      'https://169.254.169.254/hook',
      'https://0.0.0.0/hook',
    ];
    for (const url of privateUrls) {
      await assert.rejects(
        () => validateWebhookUrl(url),
        /private\/internal addresses/,
      );
    }
  });

  test('rejects localhost hostnames', async () => {
    await assert.rejects(
      () => validateWebhookUrl('https://localhost/hook'),
      /private\/internal addresses/,
    );
  });

  test('accepts public HTTPS IP literal', async () => {
    const url = 'https://93.184.216.34/hook';
    assert.equal(await validateWebhookUrl(url), url);
  });

  test('rejects credentials embedded in the destination URL', async () => {
    await assert.rejects(
      () => validateWebhookUrl('https://user:password@93.184.216.34/hook'),
      /embedded credentials/,
    );
  });

  test('pins the approved address for the outbound socket lookup', async () => {
    const target = await resolveWebhookTarget('https://93.184.216.34/hook');
    const records = await new Promise((resolve, reject) => {
      target.lookup('93.184.216.34', { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
    assert.deepEqual(records, [{ address: '93.184.216.34', family: 4 }]);
  });

  test('allows local http only when flag is set', async () => {
    await assert.rejects(
      () => validateWebhookUrl('http://127.0.0.1/hook'),
      /https/,
    );
    const url = 'http://127.0.0.1/hook';
    assert.equal(await validateWebhookUrl(url, { allowLocalHttp: true }), url);
  });
});

describe('isPrivateIpAddress', () => {
  test('flags IPv4-mapped loopback', () => {
    resetSsrfCachesForTests();
    assert.equal(isPrivateIpAddress('::ffff:127.0.0.1'), true);
  });

  test('flags non-global and special-use address ranges', () => {
    for (const address of [
      '100.64.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '2001:db8::1',
      'ff02::1',
    ]) {
      assert.equal(isPrivateIpAddress(address), true, address);
    }
  });
});

describe('sanitizeError', () => {
  test('redacts IPv6 and URLs', () => {
    const out = sanitizeError('POST https://[2001:db8::1]:443/hook failed for fe80::1');
    assert.match(out, /\[redacted/);
    assert.doesNotMatch(out, /2001:db8/);
    assert.doesNotMatch(out, /fe80::/);
  });

  test('preserves non-address colons', () => {
    const msg = 'failed at 12:34:56 today';
    assert.equal(sanitizeError(msg), msg);
  });

  test('redacts IPv4-mapped IPv6 as one unit', () => {
    assert.equal(
      sanitizeError('to ::ffff:192.168.0.1 closed'),
      'to [redacted] closed',
    );
  });
});
