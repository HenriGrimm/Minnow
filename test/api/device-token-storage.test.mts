/**
 * Companion device token persistence across browser and installed PWA contexts.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const TOKEN =
  'minnow_device_0123456789abcdef012345678.abcdefghijklmnopqrstuvwxyz0123456789ABCDE';

describe('client device token storage', () => {
  let localStorage: StorageLike;
  let cookieJar: string;

  beforeEach(async () => {
    localStorage = createMemoryStorage();
    cookieJar = '';
    const g = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
      document?: Document;
    };
    g.window = {
      localStorage,
      isSecureContext: true,
      location: { href: 'https://minnow.test/' },
    } as unknown as Window & typeof globalThis;
    g.document = {
      get cookie() {
        return cookieJar;
      },
      set cookie(value: string) {
        const [pair] = value.split(';');
        const [name, rawValue = ''] = pair.split('=');
        if (!name) return;
        if (value.includes('Max-Age=0')) {
          cookieJar = cookieJar
            .split(';')
            .map((part) => part.trim())
            .filter((part) => !part.startsWith(`${name}=`))
            .join('; ');
          return;
        }
        const next = cookieJar
          .split(';')
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith(`${name}=`));
        next.push(`${name}=${rawValue}`);
        cookieJar = next.join('; ');
      },
    } as unknown as Document;
  });

  afterEach(() => {
    const g = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
      document?: Document;
    };
    delete g.window;
    delete g.document;
  });

  test('saveDeviceToken mirrors into localStorage and cookie', async () => {
    const { saveDeviceToken, getDeviceToken } = await import('../../src/api/session-token.ts');
    saveDeviceToken(TOKEN);
    assert.equal(localStorage.getItem('minnow.auth.deviceToken'), TOKEN);
    assert.match(cookieJar, /minnow_device=/);
    assert.equal(getDeviceToken(), TOKEN);
  });

  test('getDeviceToken hydrates localStorage from cookie', async () => {
    cookieJar = `minnow_device=${encodeURIComponent(TOKEN)}`;
    const { getDeviceToken } = await import('../../src/api/session-token.ts');
    assert.equal(getDeviceToken(), TOKEN);
    assert.equal(localStorage.getItem('minnow.auth.deviceToken'), TOKEN);
  });

  test('pairing survives unavailable localStorage using the cookie', async () => {
    localStorage.setItem = () => { throw new Error('Storage restricted'); };
    const { saveDeviceToken, getDeviceToken } = await import('../../src/api/session-token.ts');
    saveDeviceToken(TOKEN);
    assert.equal(getDeviceToken(), TOKEN);
    localStorage.getItem = () => { throw new Error('Storage restricted'); };
    assert.equal(getDeviceToken(), TOKEN);
  });

  test('pairing survives unavailable cookies using localStorage', async () => {
    Object.defineProperty(document, 'cookie', {
      get() { throw new Error('Cookies restricted'); },
      set() { throw new Error('Cookies restricted'); },
    });
    const { saveDeviceToken, getDeviceToken } = await import('../../src/api/session-token.ts');
    saveDeviceToken(TOKEN);
    assert.equal(getDeviceToken(), TOKEN);
  });

  test('malformed cookies do not break bootstrap and invalid storage uses the cookie', async () => {
    const { getDeviceToken } = await import('../../src/api/session-token.ts');
    cookieJar = 'minnow_device=%invalid';
    assert.equal(getDeviceToken(), '');
    cookieJar = `minnow_device=${TOKEN}`;
    localStorage.setItem('minnow.auth.deviceToken', 'invalid');
    assert.equal(getDeviceToken(), TOKEN);
  });

  test('reports when neither store can remember a pairing', async () => {
    localStorage.setItem = () => { throw new Error('Storage restricted'); };
    Object.defineProperty(document, 'cookie', { get: () => '', set: () => {} });
    const { saveDeviceToken } = await import('../../src/api/session-token.ts');
    assert.throws(() => saveDeviceToken(TOKEN), /Allow browser storage/);
  });

  test('clearDeviceToken removes localStorage and cookie', async () => {
    const { saveDeviceToken, clearDeviceToken, getDeviceToken } = await import(
      '../../src/api/session-token.ts'
    );
    saveDeviceToken(TOKEN);
    clearDeviceToken();
    assert.equal(localStorage.getItem('minnow.auth.deviceToken'), null);
    assert.equal(cookieJar.includes('minnow_device='), false);
    assert.equal(getDeviceToken(), '');
  });
});

describe('installed PWA detection', () => {
  test('detects iOS standalone flag', async () => {
    const g = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
    g.window = {
      navigator: { standalone: true },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window & typeof globalThis;
    const { isInstalledPwa } = await import('../../src/api/pwa-context.ts');
    assert.equal(isInstalledPwa(), true);
    delete g.window;
  });
});
