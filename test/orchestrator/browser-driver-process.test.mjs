import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { killBrowserProcess, isPidAlive } from '../../server/browser-driver/process.js';

test('browser teardown kills a helper that outlives its parent and releases inherited pipes', { skip: process.platform === 'win32' }, async () => {
  const helper = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.stdout.write('helper-ready\\n');";
  const program = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit']}); process.stdout.write('helper-pid:'+child.pid+'\\n'); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', program], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', helperPid, timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('helper startup timed out')), 5000);
      child.on('error', reject);
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('helper-ready')) { helperPid = Number(/helper-pid:(\d+)/.exec(output)[1]); resolve(); }
      });
    });
    clearTimeout(timer);
    const result = await killBrowserProcess(child, { graceMs: 1000, waitMs: 3000 });
    assert.equal(result.killed, true);
    for (let i = 0; i < 100 && isPidAlive(helperPid); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(isPidAlive(helperPid), false, 'the owned helper must not survive parent exit');
    assert.equal(child.stdout.destroyed, true, 'profile cleanup follows release of descendant pipes');
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});
