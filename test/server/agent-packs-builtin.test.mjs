import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  BUILTIN_AGENT_PACK_ID,
  BUILTIN_AGENT_PACK_ZIP_ROOT,
  buildBuiltinAgentPackFileMap,
  buildBuiltinAgentPackZip,
} from '../../server/agent-packs/builtin-pack.js';
import { handleAgentPacksRequest } from '../../server/agent-packs/routes.js';
import { validatePackManifest } from '../../server/agent-packs/validate.js';
import { writeTemplateFiles } from '../../server/agent-packs/template.js';
import { listZipEntries } from '../zip-entries.mjs';

const projectRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
const builtinIds = new Set([
  'general',
  'planner',
  'builder',
  'tester',
  'reviewer',
  'researcher',
  'ui-designer',
]);

describe('agent-packs builtin export', () => {
  test('buildBuiltinAgentPackFileMap includes shipped work agents', async () => {
    const files = await buildBuiltinAgentPackFileMap(projectRoot);
    assert.ok(files['manifest.json']);
    assert.ok(files['prompts/builder.full.md']);
    assert.ok(files['prompts/planner.full.md']);

    const manifest = JSON.parse(files['manifest.json']);
    assert.equal(manifest.id, BUILTIN_AGENT_PACK_ID);
    assert.equal(manifest.agents.length, 7);
    assert.ok(manifest.agents.some((agent) => agent.key === 'builder'));
  });

  test('exported manifest passes pack validation on disk', async () => {
    const files = await buildBuiltinAgentPackFileMap(projectRoot);
    const tempRoot = await mkdtemp(join(tmpdir(), 'minnow-builtin-pack-'));
    const packRoot = join(tempRoot, BUILTIN_AGENT_PACK_ID);

    try {
      await writeTemplateFiles(packRoot, files);
      const manifest = JSON.parse(files['manifest.json']);
      const result = validatePackManifest(manifest, packRoot, builtinIds);
      assert.equal(result.ok, true, result.errors?.join('; '));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('buildBuiltinAgentPackZip emits a well-formed zip', async () => {
    const zip = await buildBuiltinAgentPackZip(projectRoot);
    const entries = listZipEntries(zip);

    assert.ok(
      entries.includes(`${BUILTIN_AGENT_PACK_ZIP_ROOT}/manifest.json`),
      `manifest missing from zip; got: ${entries.slice(0, 5).join(', ')}…`,
    );
    assert.ok(entries.includes(`${BUILTIN_AGENT_PACK_ZIP_ROOT}/prompts/builder.full.md`));
    assert.ok(entries.length > 2, 'the pack carries more than its manifest');
  });

  test('GET /api/agent-packs/builtin returns application/zip', async () => {
    /** @type {Record<string, string | number>} */
    const headers = {};
    let body = Buffer.alloc(0);

    const req = { method: 'GET', url: '/api/agent-packs/builtin' };
    const res = {
      statusCode: 0,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      },
    };

    const handled = await handleAgentPacksRequest(req, res, '/api/agent-packs/builtin');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(headers['content-type'], 'application/zip');
    assert.match(String(headers['content-disposition']), /minnow-default-agent-pack\.zip/);
    assert.equal(body.readUInt32LE(0), 0x04034b50);
  });
});
