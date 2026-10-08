import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { renderGeneratedImageResult } from '../../src/ui/generated-image-result.ts';

test('durable asset preview, actual Copy path click and missing-file feedback', async () => {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  let copied = '';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text; } } } });
  const card = renderGeneratedImageResult({ type: 'image', mime: 'image/png', url: '/api/preview/file/assets/fish.png?workspaceRoot=test', generated: { jobId: 'job', providerId: 'provider', modelId: 'model', path: 'assets/fish.png', width: 16, height: 12, bytes: 100, sha256: 'hash' } });
  assert.match(card.textContent!, /16 × 12/);
  card.querySelector('button')!.click(); await Promise.resolve();
  assert.equal(copied, 'assets/fish.png');
  const image = card.querySelector('img')!;
  image.dispatchEvent(new window.Event('error') as unknown as Event);
  assert.equal(image.hidden, true); assert.match(card.textContent!, /Image unavailable/);
  await window.happyDOM.close();
});
