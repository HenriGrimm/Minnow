import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAuth } from '../../server/git/github-auth.js';

const result = (code = 0, stdout = '') => ({ code, stdout, stderr: '', timedOut: false });
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ installed = true, env = {} } = {}) {
  let login = '';
  let finish;
  let loginOptions;
  let invalidations = 0;
  const calls = [];
  const auth = createGitHubAuth({ env, invalidate: () => invalidations++, run: async (args, options) => {
    calls.push(args);
    if (args[0] === '--version') return result(installed ? 0 : 1);
    if (args[0] === 'api') return result(login ? 0 : 1, login);
    loginOptions = options;
    return new Promise((resolve, reject) => {
      finish = resolve;
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    });
  } });
  return { auth, calls, setLogin: value => { login = value; }, finish: value => finish(value),
    options: () => loginOptions, invalidations: () => invalidations };
}

test('account status works without a repository and exposes only account identity', async () => {
  const h = harness();
  h.setLogin('octocat');
  const status = await h.auth.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.login, 'octocat');
  assert.deepEqual(h.calls[1], ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
  assert.equal('stdout' in status, false);
});

test('missing CLI and environment credentials do not launch a login', async () => {
  for (const options of [{ installed: false }, { env: { GH_TOKEN: 'secret' } }]) {
    const h = harness(options);
    assert.equal((await h.auth.start()).ok, false);
    assert.equal(h.calls.some(args => args[0] === 'auth'), false);
    assert.equal(JSON.stringify(await h.auth.status()).includes('secret'), false);
  }
});

test('concurrent start requests share one flow; split chunks expose only the device code', async () => {
  const h = harness();
  await Promise.all([h.auth.start(), h.auth.start()]);
  assert.equal(h.calls.filter(args => args[0] === 'auth').length, 1);
  h.options().onStderr('! First copy your one-time code: ABC');
  h.options().onStderr('D-1234\ninternal diagnostic secret');
  assert.equal(h.auth.poll().flow.code, 'ABCD-1234');
  assert.equal(JSON.stringify(h.auth.poll()).includes('secret'), false);
  h.setLogin('octocat');
  h.finish(result());
  await flush();
  assert.equal(h.auth.poll().flow.state, 'complete');
  assert.equal(h.auth.poll().flow.code, '');
  assert.equal(h.invalidations(), 1);
});

test('cancellation aborts the process and an older completion cannot replace a retry', async () => {
  const h = harness();
  await h.auth.start();
  const old = h.options();
  h.auth.cancel();
  assert.equal(old.signal.aborted, true);
  await h.auth.start();
  await flush();
  assert.equal(h.auth.poll().flow.state, 'pending');
  h.auth.cancel();
  await flush();
});

test('timeout and failed account verification never report success', async () => {
  const h = harness();
  await h.auth.start();
  h.finish({ ...result(1), timedOut: true });
  await flush();
  assert.match(h.auth.poll().flow.error, /expired/);
  await h.auth.start();
  h.finish(result());
  await flush();
  assert.equal(h.auth.poll().flow.state, 'failed');
  assert.match(h.auth.poll().flow.error, /could not be verified/);
});
