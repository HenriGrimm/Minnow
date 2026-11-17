import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let binary = '/fixture/old/mtplx';
let resolutions = 0;
mock.module('../../server/process-runner.js', { namedExports: {
  runProcess: async (_command, args) => {
    if (args[0] === 'mtplx') {
      resolutions++;
      return { code: 0, stdout: binary, stderr: '' };
    }
    if (args[0] === '--version') return { code: 0, stdout: '2.12.3', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  },
} });
const { getMtplxStatus, refreshMtplxStatus } = await import('../../server/models/mtplx-runtime.js');

test('explicit MTPLX refresh bypasses cached external installation detection', async () => {
  assert.equal((await getMtplxStatus()).path, '/fixture/old/mtplx');
  binary = '/fixture/updated/mtplx';
  assert.equal((await getMtplxStatus()).path, '/fixture/old/mtplx');
  assert.equal(resolutions, 1);
  assert.equal((await refreshMtplxStatus()).path, '/fixture/updated/mtplx');
  assert.equal(resolutions, 2);
  assert.equal((await getMtplxStatus()).path, '/fixture/updated/mtplx');
  assert.equal(resolutions, 2);
});
