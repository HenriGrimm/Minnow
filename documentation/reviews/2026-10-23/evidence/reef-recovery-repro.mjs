/** Synthetic runtime recovery only; no model, installation, browser or export. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-reef-')));
process.env.MINNOW_HOME = scratch;
globalThis.fetch = async () => { throw new Error('No network permitted in review reproduction'); };
try {
  const { createApp, updateApp, appRoot, listApps, initialBuildRequest, readApp } = await import('../../../../server/reef/store.js');
  const { ReefSupervisor } = await import('../../../../server/reef/supervisor.js');
  const { launchApp, stopAllApps } = await import('../../../../server/reef/runtime.js');
  const app = await createApp({ prompt: 'Synthetic recovery fixture', modelId: 'fixture' });
  const releaseId = randomUUID();
  await updateApp(app.id, current => { current.release = { id: releaseId, commit: 'a'.repeat(40), createdAt: Date.now() }; });
  const release = path.join(appRoot(app.id), 'releases', releaseId);
  await fs.mkdir(path.join(release, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(release, 'dist'));
  await fs.writeFile(path.join(release, 'backend.mjs'), "import 'review-deliberately-missing-dependency'; export function handle(req,res){ res.end('ok'); }\n");
  const marker = path.join(scratch, 'install-attempted');
  const fakeNpm = path.join(scratch, 'npm-fixture.cjs');
  await fs.writeFile(fakeNpm, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'attempted'); process.exit(1);`);
  const tools = { node: process.execPath, npm: fakeNpm };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(launchApp(app.id, tools), /App exited before becoming ready/);
  }
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  console.log(JSON.stringify({ incompleteDependencies: { launchAttempts: 2, reinstallAttempted: false, bothLaunchesFailed: true } }));
  stopAllApps();

  const longApp = await createApp({ prompt: 'a'.repeat(16_000), name: 'Long but individually valid request', look: 'Cozy', modelId: 'fixture' });
  const supervisor = new ReefSupervisor(); // Remains stopped; no build can start.
  const composed = initialBuildRequest(longApp, { named: true });
  await assert.rejects(supervisor.enqueue(longApp.id, composed), /maximum 16000 characters/);
  const saved = await readApp(longApp.id);
  assert.equal(saved.status, 'queued');
  assert.equal(saved.runs.length, 0);
  console.log(JSON.stringify({ validCreationFieldsExceedBuildLimit: { composedLength: composed.length, savedStatus: saved.status, savedRuns: saved.runs.length } }));

  const brokenId = randomUUID();
  await fs.mkdir(appRoot(brokenId), { recursive: true });
  await fs.writeFile(path.join(appRoot(brokenId), 'app.json'), '{incomplete');
  await assert.rejects(listApps(), SyntaxError);
  console.log(JSON.stringify({ corruptSiblingBlocksWholeLibrary: true, validAppsPresent: 2 }));
} finally {
  assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
