/**
 * The in-app scanner accepts only Minnow connect links.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConnectUrl } from '../../src/companion/qr-scanner.ts';

const here = new URL('https://minnow-studio.tail1.ts.net/');
const ticket = 'AbCdEfGhIjKlMnOpQrStUv';

test('a same-origin connect QR is claimed in place', () => {
  assert.deepEqual(parseConnectUrl(`https://minnow-studio.tail1.ts.net/connect#t=${ticket}`, here), { kind: 'ticket', ticket });
});

test('a connect QR for another Minnow address navigates there', () => {
  assert.deepEqual(parseConnectUrl(`http://studio.local:9480/connect#t=${ticket}`, here), {
    kind: 'navigate',
    url: `http://studio.local:9480/connect#t=${ticket}`,
  });
});

test('anything else is rejected', () => {
  for (const raw of [
    'hello',
    `javascript:alert(1)//connect#t=${ticket}`,
    `https://minnow-studio.tail1.ts.net/other#t=${ticket}`,
    'https://minnow-studio.tail1.ts.net/connect#t=short',
    `https://minnow-studio.tail1.ts.net/connect?t=${ticket}`,
  ]) {
    assert.equal(parseConnectUrl(raw, here), null, raw);
  }
});
