import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPendingRestore } from '../../server/backup/restore-apply.js';
import { scheduleRollback } from '../../server/backup/restore.js';

const moduleUrl = new URL('../../server/backup/restore-apply.js', import.meta.url).href;
function interrupt(home, after) {
  const script = `
    import fs from 'node:fs';
    import { applyPendingRestore } from ${JSON.stringify(moduleUrl)};
    let moves = 0;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if ((!from.includes('.tmp-') || to.endsWith('restore-last.json')) && ++moves === ${after}) process.exit(47);
    };
    applyPendingRestore({home:process.argv[1]});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, home], {encoding:'utf8'});
  assert.equal(result.status, 47, result.stderr);
}

for (const credentials of [false, true]) {
  for (const rollback of [false, true]) {
    test('recovers each interrupted move and metadata commit: credentials=' + credentials + ', undo=' + rollback, async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-interrupted-swap-'));
      try {
        for (let after = 1; after <= (credentials ? 8 : 6); after++) {
          const home = path.join(base, String(after));
          const staged = path.join(home, 'restore-staging', 'fixture', 'tree');
          const roots = [{path:'brain', kind:'dir', exclude:['cache']}, {path:'sessions', kind:'dir'}];
          if (credentials) roots.push({path:'.key', kind:'file'});
          for (const [tree, state] of [[home, 'old'], [staged, 'new']]) {
            for (const folder of ['brain', 'sessions']) {
              await fs.mkdir(path.join(tree, folder), {recursive:true});
              await fs.writeFile(path.join(tree, folder, 'state'), state);
            }
            if (credentials) await fs.writeFile(path.join(tree, '.key'), state);
          }
          await fs.writeFile(path.join(home, 'brain', 'cache'), 'retained');
          await fs.writeFile(path.join(home, 'restore-pending.json'), JSON.stringify({
            id:'fixture', roots, includeCredentials:credentials,
          }));
          if (rollback) {
            assert.equal(applyPendingRestore({home}).applied, true);
            await scheduleRollback(home);
          }
          interrupt(home, after);
          assert.equal(applyPendingRestore({home}).applied, true);
          for (const folder of ['brain','sessions']) {
            assert.equal(await fs.readFile(path.join(home, folder, 'state'), 'utf8'), rollback ? 'old' : 'new');
          }
          assert.equal(await fs.readFile(path.join(home,'brain','cache'), 'utf8'), 'retained');
          if (credentials) assert.equal(await fs.readFile(path.join(home,'.key'), 'utf8'), rollback ? 'old' : 'new');
          assert.equal(applyPendingRestore({home}).applied, false);
        }
      } finally { await fs.rm(base, {recursive:true, force:true}); }
    });
  }
}
