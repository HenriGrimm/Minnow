import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAuthMiddleware } from '../../server/runtime/auth-middleware.js';
import { createPreviewAccessMiddleware, startIsolatedPreviewHost, stopIsolatedPreviewHost } from '../../server/preview/isolated-host.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

test('workspace preview JavaScript cannot obtain host authority', async (t) => {
  const puppeteer = (await import('puppeteer').catch(() => null))?.default;
  if (!puppeteer) {
    t.skip('Puppeteer is not installed');
    return;
  }
  const browserPath = await puppeteer.executablePath();
  try {
    await fs.access(browserPath);
  } catch {
    t.skip('Chromium is not installed');
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-preview-origin-'));
  const workspace = path.join(home, 'workspace');
  const oldHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  await fs.mkdir(workspace);
  await setWorkspaceRoot(workspace);
  const hostToken = getSessionToken();
  let privilegedCalls = 0;
  const auth = createAuthMiddleware();
  const access = createPreviewAccessMiddleware();
  const main = http.createServer((req, res) => {
    auth(req, res, () => access(req, res, () => {
      if (req.url?.startsWith('/api/tools')) {
        privilegedCalls += 1;
        res.end('host authority');
      } else {
        res.statusCode = 404;
        res.end();
      }
    }));
  });
  let browser;
  try {
    await startIsolatedPreviewHost();
    await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
    const mainOrigin = `http://127.0.0.1:${main.address().port}`;
    await fs.writeFile(path.join(workspace, 'asset.txt'), 'workspace asset');
    await fs.writeFile(path.join(workspace, 'index.html'), `<!doctype html><script>
      window.previewProof = {
        url: location.href,
        hostToken: window.__MINNOW_SESSION_TOKEN__ || null,
        visibleCookie: document.cookie,
      };
      fetch(${JSON.stringify(mainOrigin)} + '/api/tools?token=' +
        encodeURIComponent(location.pathname.split('/')[2] || ''),
        { mode: 'no-cors' }).catch(() => {});
      fetch('asset.txt').then((response) => response.text())
        .then((text) => { window.previewProof.asset = text; });
    </script><p>Preview loaded</p>`);
    const accessResponse = await fetch(`${mainOrigin}/api/preview/access`, {
      headers: { 'X-Minnow-Token': hostToken },
    });
    assert.equal(accessResponse.status, 200);
    const grant = await accessResponse.json();
    const open = new URL(`/p/${grant.token}/api/preview/file/index.html`, grant.origin);

    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(open.href, { waitUntil: 'networkidle0' });
    const proof = await page.evaluate(() => window.previewProof);
    assert.ok(proof);
    assert.equal(new URL(proof.url).origin, grant.origin);
    assert.equal(new URL(proof.url).searchParams.has('token'), false);
    assert.equal(proof.url.includes(hostToken), false);
    assert.equal(proof.hostToken, null);
    assert.equal(proof.visibleCookie, '');
    assert.equal(proof.asset, 'workspace asset');
    assert.equal(privilegedCalls, 0);

    const denied = await fetch(`${mainOrigin}/api/tools?token=${grant.token}`);
    assert.equal(denied.status, 401);
    assert.equal(privilegedCalls, 0);
    const previewTools = await fetch(`${grant.origin}/p/${grant.token}/api/tools`);
    assert.equal(previewTools.status, 404);
    const hidden = await fetch(`${grant.origin}/p/${grant.token}/api/preview/file/.env`);
    assert.equal(hidden.status, 403);
    const outside = await fetch(`${grant.origin}/p/${grant.token}/api/preview/file/..%2Foutside.txt`);
    assert.notEqual(outside.status, 200);
  } finally {
    await browser?.close();
    await new Promise((resolve) => main.close(resolve));
    await stopIsolatedPreviewHost();
    if (oldHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = oldHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});
