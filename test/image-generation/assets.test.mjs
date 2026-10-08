import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { containedPath, imageMetadata, writeImageAsset } from '../../server/image-generation/assets.js';

test('valid raster saves exclusively; traversal, content spoofing and symlinks fail', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-image-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal((await imageMetadata(bytes)).width, 8);
  await assert.rejects(imageMetadata(Buffer.from('<html>not PNG</html>')));
  await assert.rejects(imageMetadata(bytes, 'image/jpeg'), /MIME/);
  for (const p of ['../outside.png', 'C:\\outside.png', '//server/share/a.png', 'a/../b.png']) await assert.rejects(containedPath(root, p));
  const artifact = await writeImageAsset(root, 'assets/a.png', bytes);
  assert.equal(artifact.mime, 'image/png');
  await assert.rejects(writeImageAsset(root, 'assets/a.png', bytes), /EEXIST/);
  await assert.rejects(writeImageAsset(root, 'assets/a.jpg', bytes), /extension/);
  await fs.symlink(path.join(root, 'assets'), path.join(root, 'linked'), 'junction');
  await assert.rejects(writeImageAsset(root, 'linked/b.png', bytes), /symlink/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(writeImageAsset(root, 'c.png', bytes, controller.signal));
  assert.deepEqual(await fs.readFile(path.join(root, 'assets/a.png')), bytes);
});
