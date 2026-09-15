import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  getHfCreatorAvatar,
  getHfCreatorAvatarImage,
  resetHfAvatarForTests,
  setHfAvatarFetchForTests,
} from '../../server/models/hf-avatar.js';

describe('Hugging Face creator avatars', () => {
  afterEach(resetHfAvatarForTests);

  test('accepts only the Hugging Face avatar CDN', async () => {
    setHfAvatarFetchForTests(async (url) => ({
      ok: String(url).includes('/organizations/'),
      json: async () => ({
        avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/qwen.png',
      }),
    }));
    assert.equal(
      await getHfCreatorAvatar('Qwen'),
      'https://cdn-avatars.huggingface.co/v1/production/uploads/qwen.png',
    );
  });

  test('rejects unsafe owners and redirect targets', async () => {
    let calls = 0;
    setHfAvatarFetchForTests(async () => {
      calls += 1;
      return { ok: true, json: async () => ({ avatarUrl: 'https://example.com/tracker.png' }) };
    });
    assert.equal(await getHfCreatorAvatar('../Qwen'), null);
    assert.equal(calls, 0);
    assert.equal(await getHfCreatorAvatar('Qwen'), null);
  });

  test('proxies only small raster images', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    setHfAvatarFetchForTests(async (url) => {
      if (String(url).includes('/organizations/')) {
        return {
          ok: true,
          json: async () => ({
            avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/qwen.webp',
          }),
        };
      }
      if (String(url).includes('/users/')) return { ok: false };
      return new Response(bytes, { headers: { 'Content-Type': 'image/webp' } });
    });
    const image = await getHfCreatorAvatarImage('Qwen');
    assert.equal(image?.contentType, 'image/webp');
    assert.deepEqual(image?.body, Buffer.from(bytes));
  });
});
