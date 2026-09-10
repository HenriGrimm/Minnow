import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-browser-live-'));
const previousHome = process.env.MINNOW_HOME;
process.env.MINNOW_HOME = homeDir;

const { discoverBrowser } = await import('../../server/browser-driver/index.js');
const { AgentBrowserError, createAgentBrowserService } = await import('../../server/agent-browser/index.js');

const ownerA = { chatId: 'chat-a', runId: 'run-a', agentId: 'agent-a' };
const ownerB = { chatId: 'chat-b', runId: 'run-b', agentId: 'agent-b' };

/** @param {string} filePath */
async function pngDimensions(filePath) {
  const png = await fs.readFile(filePath);
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), size: png.length };
}

/** @param {http.Server} server */
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test.after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  await fs.rm(homeDir, { recursive: true, force: true });
});

test('two owners browse concurrently with isolated state and render full screenshots without a viewer', { timeout: 90_000 }, async (t) => {
  const capability = await discoverBrowser();
  if (!capability.available) return t.skip(capability.detail);

  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      const address = server.address();
      res.writeHead(302, { location: `http://localhost:${address.port}/outside` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Agent fixture</title></head><body>
      <label>Name <input aria-label="Name" value=""></label>
      <button id="action" onclick="document.body.dataset.clicked='yes'">Click me</button>
      <button id="popup" onclick="window.__popup=window.open('/popup')">Open popup</button>
      <main id="state"></main>
    </body></html>`);
  });
  const baseUrl = await listen(server);
  const service = createAgentBrowserService({
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath: capability.executablePath,
      allowedOriginPatterns: ['http://127.0.0.1:*'],
      hardTimeoutMs: 60_000,
    },
  });
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const [a, b] = await Promise.all([
    service.reserveTab(ownerA, { url: baseUrl }),
    service.reserveTab(ownerB, { url: baseUrl }),
  ]);
  assert.notEqual(a.tab.tabId, b.tab.tabId);

  await Promise.all([
    service.evaluate({ ...a, ...ownerCall(a, ownerA), expression: `localStorage.setItem('owner','A')` }),
    service.evaluate({ ...b, ...ownerCall(b, ownerB), expression: `localStorage.setItem('owner','B')` }),
  ]);
  const [valueA, valueB] = await Promise.all([
    service.evaluate({ ...ownerCall(a, ownerA), expression: `localStorage.getItem('owner')` }),
    service.evaluate({ ...ownerCall(b, ownerB), expression: `localStorage.getItem('owner')` }),
  ]);
  assert.equal(valueA, 'A');
  assert.equal(valueB, 'B');

  const snap = await service.snapshot(ownerCall(a, ownerA));
  const input = [...snap.byUid.values()].find((node) => node.role === 'textbox');
  const button = [...snap.byUid.values()].find((node) => node.role === 'button');
  assert.ok(input);
  assert.ok(button);
  await service.fill({ ...ownerCall(a, ownerA), uid: input.uid, text: 'Minnow' });
  const refreshed = await service.snapshot(ownerCall(a, ownerA));
  const refreshedButton = [...refreshed.byUid.values()].find((node) => node.role === 'button');
  assert.ok(refreshedButton);

  const buttonRect = await service.evaluate({
    ...ownerCall(a, ownerA),
    expression: `(() => { const r=document.querySelector('#action').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  });
  await service.setControlMode(a.tab.tabId, 'guide');
  await assert.rejects(
    async () => service.evaluate({ ...ownerCall(a, ownerA), expression: '1' }),
    (error) => error instanceof AgentBrowserError && error.code === 'busy',
  );
  const selection = await service.guideElementAtPoint(a.tab.tabId, buttonRect);
  assert.equal(selection.element.tagName, 'button');
  assert.equal(await service.captureFrame(a.tab.tabId).then((frame) => `${frame.width}x${frame.height}`), '1440x900');
  assert.equal(
    await service.deliverGuide(a.tab.tabId, { selectionToken: selection.selectionToken, message: 'Use this action' }).then((event) => event.message),
    'Use this action',
  );
  assert.equal(service.takeGuideEvents(ownerA).length, 1);
  await service.setControlMode(a.tab.tabId, 'watch');

  await service.click({ ...ownerCall(a, ownerA), uid: refreshedButton.uid });
  assert.deepEqual(
    await service.evaluate({ ...ownerCall(a, ownerA), expression: `({value:document.querySelector('input').value,clicked:document.body.dataset.clicked})` }),
    { value: 'Minnow', clicked: 'yes' },
  );

  await service.evaluate({ ...ownerCall(a, ownerA), expression: `delete document.body.dataset.clicked` });
  await service.setControlMode(a.tab.tabId, 'control');
  await service.dispatchControlInput(a.tab.tabId, { kind: 'pointer', action: 'click', ...buttonRect });
  await service.setControlMode(a.tab.tabId, 'watch');
  assert.equal(await service.evaluate({ ...ownerCall(a, ownerA), expression: 'document.body.dataset.clicked' }), 'yes');

  const popupRect = await service.evaluate({
    ...ownerCall(a, ownerA),
    expression: `(() => { const r=document.querySelector('#popup').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  });
  await service.setControlMode(a.tab.tabId, 'control');
  await service.dispatchControlInput(a.tab.tabId, { kind: 'pointer', action: 'click', ...popupRect });
  await service.setControlMode(a.tab.tabId, 'watch');
  assert.equal(
    await service.evaluate({
      ...ownerCall(a, ownerA),
      expression: `(async()=>{for(let i=0;i<30;i++){if(window.__popup?.closed)return true;await new Promise(r=>setTimeout(r,20))}return false})()`,
    }),
    true,
    'unreserved popup target should be closed',
  );

  const [shotA, shotB] = await Promise.all([
    service.screenshot(ownerCall(a, ownerA)),
    service.screenshot(ownerCall(b, ownerB)),
  ]);
  assert.equal(shotA.ok, true);
  assert.equal(shotB.ok, true);
  if (!shotA.ok || !shotB.ok) return;
  assert.deepEqual(await pngDimensions(shotA.filePath), { width: 1440, height: 900, size: shotA.sizeBytes });
  assert.deepEqual(await pngDimensions(shotB.filePath), { width: 1440, height: 900, size: shotB.sizeBytes });
  if (process.env.AGENT_BROWSER_PROOF_PATH) {
    await fs.copyFile(shotA.filePath, process.env.AGENT_BROWSER_PROOF_PATH);
  }

  await assert.rejects(
    async () => service.evaluate({ ...ownerCall(a, ownerB), expression: '1' }),
    (error) => error instanceof AgentBrowserError && error.code === 'not-owner',
  );

  const reassigned = await service.reassignTab(a.tab.tabId, ownerB);
  assert.ok(reassigned.lease);
  await assert.rejects(
    async () => service.evaluate({ ...ownerCall(a, ownerA), expression: '1' }),
    (error) => error instanceof AgentBrowserError && error.code === 'not-owner',
  );
  assert.equal(
    await service.evaluate({ owner: ownerB, tabId: a.tab.tabId, lease: reassigned.lease, expression: '6 * 7' }),
    42,
  );

  await assert.rejects(
    service.navigate({ owner: ownerB, tabId: a.tab.tabId, lease: reassigned.lease, url: `${baseUrl}/redirect`, timeoutMs: 2_000 }),
    (error) => error?.code === 'allowlist',
  );

  await service.closeTab(b.tab.tabId);
  assert.equal(service.listTabs().length, 1);
  await service.clearTabs();
  assert.deepEqual(service.listTabs(), []);
});

/** @param {{tab:{tabId:string},lease:string|null}} reservation @param {typeof ownerA} owner */
function ownerCall(reservation, owner) {
  assert.ok(reservation.lease);
  return { owner, tabId: reservation.tab.tabId, lease: reservation.lease };
}
