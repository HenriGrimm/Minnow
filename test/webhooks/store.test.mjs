import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  resetSecretBoxCacheForTests,
  setSecretKeyBytesForTests,
} from '../../server/security/secret-box.js';
import {
  createSubscription,
  getDeliveryTargetById,
  getSubscriptionById,
  listDeliveryTargetsForEvent,
  listSubscriptions,
} from '../../server/webhooks/store.js';

const FIXED_KEY = Buffer.from('dddddddddddddddddddddddddddddddd', 'utf8');
const SECRET = 'a-secure-test-secret-with-32-characters';
let homeDir;

beforeEach(async () => {
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  setSecretKeyBytesForTests(FIXED_KEY);
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-webhook-store-'));
  process.env.MINNOW_HOME = homeDir;
});

afterEach(async () => {
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  delete process.env.MINNOW_HOME;
  if (homeDir) await fs.rm(homeDir, { recursive: true, force: true });
});

describe('webhook subscription store security', () => {
  test('migrates a legacy plaintext subscription store on first read', async () => {
    const legacy = {
      version: 1,
      subscriptions: [{
        id: '11111111-1111-4111-8111-111111111111',
        label: 'Legacy',
        url: 'https://93.184.216.34/legacy-secret',
        events: ['chat.completed'],
        enabled: true,
        secretRef: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    await fs.writeFile(
      path.join(homeDir, 'webhooks.json'),
      `${JSON.stringify(legacy, null, 2)}\n`,
      'utf8',
    );

    assert.equal((await listSubscriptions())[0].url, 'https://93.184.216.34/…');
    const migrated = JSON.parse(await fs.readFile(path.join(homeDir, 'webhooks.json'), 'utf8'));
    assert.equal(migrated.encrypted, true);
  });

  test('encrypts destination URLs at rest and redacts them from list responses', async () => {
    const created = await createSubscription({
      label: 'Credential URL',
      url: 'https://93.184.216.34/hooks/tenant-secret?token=query-secret',
      events: ['chat.completed'],
      secret: SECRET,
    });

    assert.equal(created.url, 'https://93.184.216.34/…');
    const disk = await fs.readFile(path.join(homeDir, 'webhooks.json'), 'utf8');
    assert.doesNotMatch(disk, /tenant-secret|query-secret|Credential URL/);
    assert.equal(JSON.parse(disk).encrypted, true);

    const internal = await getSubscriptionById(created.id);
    assert.equal(
      internal.url,
      'https://93.184.216.34/hooks/tenant-secret?token=query-secret',
    );
  });

  test('rejects missing and weak signing secrets unless unsigned is explicit', async () => {
    const base = {
      label: 'Weak secret',
      url: 'https://93.184.216.34/hook',
      events: ['chat.completed'],
    };
    await assert.rejects(() => createSubscription(base), /signing secret/i);
    await assert.rejects(
      () => createSubscription({ ...base, secret: 'too-short' }),
      /at least 32 characters/i,
    );
    const unsigned = await createSubscription({ ...base, allowUnsigned: true });
    assert.equal(unsigned.hasSecret, false);
  });

  test('never downgrades a signed subscription when its secret is unavailable', async () => {
    const created = await createSubscription({
      label: 'Missing secret',
      url: 'https://93.184.216.34/hook',
      events: ['chat.completed'],
      secret: SECRET,
    });
    await fs.unlink(path.join(homeDir, 'webhooks', 'secrets', `${created.id}.json`));

    assert.deepEqual(await listDeliveryTargetsForEvent('chat.completed'), []);
    await assert.rejects(
      () => getDeliveryTargetById(created.id),
      /signing secret is unavailable/i,
    );
  });

  test('serializes concurrent mutations without losing subscriptions', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createSubscription({
          label: `Concurrent ${index}`,
          url: `https://93.184.216.34/hook/${index}`,
          events: ['chat.completed'],
          secret: `${SECRET}-${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    assert.equal((await listSubscriptions()).length, 12);
  });
});
