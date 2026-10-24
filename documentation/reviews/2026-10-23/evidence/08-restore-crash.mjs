// Run: node documentation/reviews/2026-10-23/evidence/08-restore-crash.mjs
// Exits a child after the first directory was installed, then retries in the parent.
// Only synthetic files under a fresh temporary home are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyPendingRestore } from '../../../../server/backup/restore-apply.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-restore-crash-'));
const id = 'synthetic-interruption';
try {
  for (const name of ['issues', 'brain']) {
    await fs.mkdir(path.join(home, name), { recursive: true });
    await fs.mkdir(path.join(home, 'restore-staging', id, 'tree', name), { recursive: true });
    await fs.writeFile(path.join(home, name, 'value.txt'), 'old-' + name);
    await fs.writeFile(path.join(home, 'restore-staging', id, 'tree', name, 'value.txt'), 'restored-' + name);
  }
  await fs.writeFile(path.join(home, 'restore-pending.json'), JSON.stringify({
    version: 1, id, kind: 'restore', roots: [{ path: 'issues', kind: 'dir' }, { path: 'brain', kind: 'dir' }], includeCredentials: false,
  }));
  const moduleUrl = new URL('../../../../server/backup/restore-apply.js', import.meta.url).href;
  const childCode = `import fs from 'node:fs'; const original=fs.renameSync; let moves=0; fs.renameSync=(...args)=>{const result=original(...args); if (++moves===2) process.exit(77); return result;}; const {applyPendingRestore}=await import(${JSON.stringify(moduleUrl)}); applyPendingRestore({home:process.env.MINNOW_HOME});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], { env: { ...process.env, MINNOW_HOME: home }, windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 77);
  const result = applyPendingRestore({ home });
  const values = {};
  for (const name of ['issues', 'brain']) values[name] = await fs.readFile(path.join(home, name, 'value.txt'), 'utf8');
  console.log(JSON.stringify({ injectedExitCode: child.status, retryApplied: result.applied, retryErrorCode: result.error?.split(':')[0], values }));
  assert.equal(result.applied, true, 'A process crash during directory swaps must recover to a complete profile before stores open');
  assert.deepEqual(values, { issues: 'restored-issues', brain: 'restored-brain' });
} finally {
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(home, { recursive: true, force: true });
}

