import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from 'builder-util-runtime';
import { PlatformGitHubProvider } from '../../electron/platform-github-provider.ts';
import { defaultUpdaterChannel } from '../../electron/updater-core.ts';

const tags = ['v0.2.1-beta.20261113.1', 'v0.2.1-beta.20261112.1'];
const atom = `<feed>${tags.map(tag => `<entry><title>${tag}</title><link href="https://github.com/henrigrimm/minnow/releases/tag/${tag}"/><content>Notes</content></entry>`).join('')}</feed>`;
function fixture(platform: 'darwin' | 'linux' | 'win32', allowPrerelease = true, error?: Error | string) {
  const requests: string[] = [];
  const updater = { allowPrerelease, currentVersion: '0.2.0', channel: null, fullChangelog: false };
  const executor = { async request(options: { path: string }) {
    const url = options.path;
    requests.push(url);
    if (url.includes('releases.atom')) return atom;
    if (url.endsWith('/latest')) return JSON.stringify({ tag_name: tags[0] });
    if (typeof error === 'string') return error;
    if (error) throw error;
    if (url.includes(tags[0]) && platform !== 'win32') throw new HttpError(404, 'Not found');
    return `version: 0.2.1-beta.20261112.1\nfiles:\n  - url: Minnow-arm64.zip\n    sha512: ZmFrZQ==\n    size: 10\n`;
  } };
  const provider = new PlatformGitHubProvider({ provider: 'custom', owner: 'henrigrimm', repo: 'minnow' }, updater as any,
    { platform, executor: executor as any, isUseMultipleRangeRequest: true });
  return { provider, requests };
}

test('macOS and Linux beta checks skip a Windows-only release using the installed GitHub provider', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const h = fixture(platform);
    const info = await h.provider.getLatestVersion();
    assert.equal(info.tag, tags[1]);
    assert.equal(h.requests.filter(url => url.includes('releases.atom')).length, 1);
    assert.ok(h.requests.some(url => url.includes(platform === 'darwin' ? 'beta-mac.yml' : 'beta-linux.yml')));
    assert.equal(h.provider.resolveFiles(info)[0].url.pathname.includes(tags[1]), true);
    await h.provider.getLatestVersion();
    assert.equal(h.requests.filter(url => url.includes('releases.atom')).length, 2, 'new checks refresh selection');
  }
});

test('Windows keeps the newest release and stable checks never fall back', async () => {
  assert.equal((await fixture('win32').provider.getLatestVersion()).tag, tags[0]);
  await assert.rejects(fixture('darwin', false).provider.getLatestVersion(), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
});

test('network and invalid manifests remain errors rather than silently selecting older releases', async () => {
  const offline = new Error('offline');
  await assert.rejects(fixture('darwin', true, offline).provider.getLatestVersion(), error => error === offline);
  await assert.rejects(fixture('darwin', true, 'files: [').provider.getLatestVersion(), { code: 'ERR_UPDATER_INVALID_UPDATE_INFO' });
  const missing = fixture('darwin', true, new HttpError(404, 'Not found'));
  await assert.rejects(missing.provider.getLatestVersion());
  assert.ok(missing.requests.length < 10, 'exhausted platform releases stop without repeated requests');
});

test('fresh beta installs follow beta while stable installs retain stable defaults', () => {
  assert.equal(defaultUpdaterChannel('0.2.1-beta.20261113.1'), 'beta');
  assert.equal(defaultUpdaterChannel('0.2.1'), 'stable');
});
