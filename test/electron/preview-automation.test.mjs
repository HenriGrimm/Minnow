import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * Build after `npm run electron:build` so dist includes preview-guest-actions.js.
 */
const {
  previewExecJs,
  wrapPreviewGuestUserCode,
  previewCapturePageBase64,
  previewClearGuest,
  previewGetGuestInfo,
  previewNavigateAwait,
  isNavigationAbortedError,
} = await import('../../electron/dist/preview-guest-actions.js');

function createMockWebContents(overrides = {}) {
  const state = {
    url: 'about:blank',
    title: '',
    loading: false,
    loadCalls: [],
    execCalls: [],
    captureCalls: 0,
    ...overrides,
  };
  const isLoadingFn =
    typeof overrides.isLoading === 'function' ? overrides.isLoading : () => state.loading;
  return {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: isLoadingFn,
    executeJavaScript: async (code, userGesture) => {
      state.execCalls.push({ code, userGesture });
      if (state.execResult !== undefined) return state.execResult;
      return state.execReturn;
    },
    capturePage:
      overrides.capturePage ??
      (async () => {
        state.captureCalls += 1;
        return {
          toPNG: () => Buffer.from('png-bytes'),
        };
      }),
    loadURL: async (url) => {
      state.loadCalls.push(url);
      if (state.loadReject) {
        throw state.loadReject;
      }
      state.url = url;
      state.title = state.titleAfterLoad ?? 'Loaded';
    },
    _state: state,
  };
}

test('immediate menu snapshot captures a loading page without waiting for guest scripts', async () => {
  const wc = createMockWebContents({ loading: true });
  const result = await previewCapturePageBase64(wc, { immediate: true, captureTimeoutMs: 50 });
  assert.equal(result, Buffer.from('png-bytes').toString('base64'));
  assert.equal(wc._state.captureCalls, 1);
  assert.deepEqual(wc._state.execCalls, []);
});

test('immediate snapshot times out a hung GPU capture without retrying', async () => {
  let calls = 0;
  const wc = createMockWebContents({ capturePage: () => { calls++; return new Promise(() => {}); } });
  assert.equal(await previewCapturePageBase64(wc, { immediate: true, captureTimeoutMs: 20 }), '');
  assert.equal(calls, 1);
});

describe('preview guest actions', () => {
  test('previewExecJs calls executeJavaScript with userGesture true', async () => {
    const wc = createMockWebContents({ execReturn: 42 });
    const val = await previewExecJs(wc, '1 + 1');
    assert.equal(val, 42);
    assert.equal(wc._state.execCalls.length, 1);
    assert.equal(wc._state.execCalls[0].userGesture, true);
    assert.match(wc._state.execCalls[0].code, /\(0, eval\)\("1 \+ 1"\)/);
  });

  test('wrapPreviewGuestUserCode supports multi-statement scripts', () => {
    const wrapped = wrapPreviewGuestUserCode('const n = 2; n + 2');
    assert.match(wrapped, /\(0, eval\)\("const n = 2; n \+ 2"\)/);
  });

  test('previewExecJs maps executeJavaScript rejection to __execError', async () => {
    const wc = createMockWebContents();
    wc.executeJavaScript = async () => {
      throw new Error('Script failed to execute, this normally means an error was thrown.');
    };
    const val = await previewExecJs(wc, '1 + 1');
    assert.ok(val && typeof val === 'object' && '__execError' in val);
    assert.match(String(val.__execError), /Script failed to execute/);
  });

  test('previewExecJs times out a hung executeJavaScript without waiting forever', async () => {
    const wc = createMockWebContents();
    wc.executeJavaScript = () => new Promise(() => {});
    const started = Date.now();
    const val = await previewExecJs(wc, 'while (true) {}', { timeoutMs: 50 });
    assert.ok(val && typeof val === 'object' && '__execError' in val);
    assert.match(String(val.__execError), /timed out after 50ms/);
    assert.ok(Date.now() - started < 1000);
  });

  test('previewExecJs returns destroyed-guest error without calling executeJavaScript', async () => {
    const wc = createMockWebContents();
    wc.isDestroyed = () => true;
    const val = await previewExecJs(wc, '1 + 1');
    assert.deepEqual(val, { __execError: 'Preview guest is destroyed' });
    assert.equal(wc._state.execCalls.length, 0);
  });

  test('wrapPreviewGuestUserCode times out a never-settling Promise', async () => {
    const wrapped = wrapPreviewGuestUserCode('new Promise(() => {})', 50);
    const started = Date.now();
    const result = await eval(wrapped);
    assert.ok(result && typeof result === 'object' && '__execError' in result);
    assert.match(String(result.__execError), /timed out after 50ms/);
    assert.ok(Date.now() - started < 1000);
  });

  test('wrapPreviewGuestUserCode still returns a resolved eval result', async () => {
    const wrapped = wrapPreviewGuestUserCode('1 + 1', 500);
    assert.equal(await eval(wrapped), 2);
  });

  test('previewExecJs returns guest JS errors instead of throwing', async () => {
    const wc = createMockWebContents({
      execReturn: { __execError: 'boom' },
    });
    const val = await previewExecJs(wc, 'throw new Error("boom")');
    assert.deepEqual(val, { __execError: 'boom' });
  });

  test('previewCapturePageBase64 returns base64 PNG', async () => {
    const wc = createMockWebContents();
    const b64 = await previewCapturePageBase64(wc);
    assert.equal(b64, Buffer.from('png-bytes').toString('base64'));
    assert.equal(wc._state.captureCalls, 1);
  });

  test('previewCapturePageBase64 retries when PNG is empty', async () => {
    let captureCalls = 0;
    const wc = createMockWebContents({
      capturePage: async () => {
        captureCalls += 1;
        const bytes = captureCalls >= 2 ? Buffer.from('png-bytes') : Buffer.alloc(0);
        return { toPNG: () => bytes };
      },
    });
    const b64 = await previewCapturePageBase64(wc);
    assert.equal(b64, Buffer.from('png-bytes').toString('base64'));
    assert.equal(captureCalls, 2);
  });

  test('previewCapturePageBase64 times out a hung capturePage without retrying', async () => {
    let captureCalls = 0;
    const wc = createMockWebContents({
      capturePage: () => {
        captureCalls += 1;
        return new Promise(() => {});
      },
    });
    const started = Date.now();
    const b64 = await previewCapturePageBase64(wc, { captureTimeoutMs: 50 });
    assert.equal(b64, '');
    assert.equal(captureCalls, 1);
    assert.ok(Date.now() - started < 1000);
  });

  test('previewCapturePageBase64 waits for guest loading to finish', async () => {
    let loading = true;
    const wc = createMockWebContents({
      isLoading: () => loading,
    });
    setTimeout(() => {
      loading = false;
    }, 80);
    const started = Date.now();
    const b64 = await previewCapturePageBase64(wc);
    assert.equal(b64, Buffer.from('png-bytes').toString('base64'));
    assert.ok(Date.now() - started >= 50);
  });

  test('previewGetGuestInfo returns url title loading', () => {
    const wc = createMockWebContents({
      url: 'https://example.com',
      title: 'Example',
      loading: true,
    });
    assert.deepEqual(previewGetGuestInfo(wc), {
      url: 'https://example.com',
      title: 'Example',
      loading: true,
    });
  });

  test('previewNavigateAwait resolves on successful loadURL', async () => {
    const wc = createMockWebContents({ titleAfterLoad: 'Minnow' });
    const result = await previewNavigateAwait(wc, 'http://127.0.0.1:5173/');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'http://127.0.0.1:5173/');
    assert.equal(result.title, 'Minnow');
    assert.deepEqual(wc._state.loadCalls, ['http://127.0.0.1:5173/']);
  });

  test('previewNavigateAwait returns error when loadURL rejects', async () => {
    const wc = createMockWebContents({ loadReject: new Error('ERR_FAILED') });
    const result = await previewNavigateAwait(wc, 'https://bad.test/');
    assert.equal(result.ok, false);
    assert.match(result.errorDescription ?? '', /ERR_FAILED/);
  });

  test('isNavigationAbortedError detects ERR_ABORTED', () => {
    assert.equal(isNavigationAbortedError({ errno: -3, code: 'ERR_ABORTED' }), true);
    assert.equal(isNavigationAbortedError(new Error('ERR_ABORTED (-3) loading about:blank')), true);
    assert.equal(isNavigationAbortedError(new Error('ERR_FAILED')), false);
  });

  test('previewClearGuest skips when guest is already blank', async () => {
    const wc = createMockWebContents({ url: 'about:blank', loading: false });
    await previewClearGuest(wc);
    assert.deepEqual(wc._state.loadCalls, []);
  });

  test('previewClearGuest loads about:blank', async () => {
    const wc = createMockWebContents({ url: 'https://example.com/' });
    await previewClearGuest(wc);
    assert.deepEqual(wc._state.loadCalls, ['about:blank']);
    assert.equal(wc._state.url, 'about:blank');
  });

  test('previewClearGuest ignores ERR_ABORTED from loadURL', async () => {
    const wc = createMockWebContents({
      url: 'https://example.com/',
      loadReject: Object.assign(new Error('ERR_ABORTED (-3) loading about:blank'), {
        errno: -3,
        code: 'ERR_ABORTED',
      }),
    });
    await previewClearGuest(wc);
    assert.deepEqual(wc._state.loadCalls, ['about:blank']);
  });

  test('previewClearGuest rethrows non-abort loadURL errors', async () => {
    const wc = createMockWebContents({
      url: 'https://example.com/',
      loadReject: new Error('ERR_FAILED'),
    });
    await assert.rejects(() => previewClearGuest(wc), /ERR_FAILED/);
  });
});
