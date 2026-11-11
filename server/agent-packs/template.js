/**
 * Authoring template for agent packs (shared by disk scaffold and zip download).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';

/** Folder name inside the downloadable zip archive. */
export const AGENT_PACK_TEMPLATE_ZIP_ROOT = 'agent-pack-template';

/**
 * Relative file paths and UTF-8 contents for a starter pack.
 * @param {{ packId?: string }} [options]
 * @returns {Record<string, string>}
 */
export function getAgentPackTemplateFileMap(options = {}) {
  const packId = options.packId ?? 'my-pack';
  const manifest = {
    id: packId,
    label: 'My agent pack',
    version: '0.1.0',
    description: 'Replace with a short summary of what this pack adds.',
    enabled: true,
    agents: [
      {
        key: 'example',
        label: 'Example agent',
        description: 'Replace with your first work agent.',
        prompts: {
          full: 'prompts/example.full.md',
        },
        allowedTools: ['read_file', 'find_files', 'list_directory'],
        defaultForModes: ['general'],
        contextStrategy: { policy: 'inherit', maxInputTokens: null },
      },
    ],
    defaults: { providerId: null, modelId: null },
  };

  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'README.md': [
      '# Agent pack template',
      '',
      '1. Rename this folder to your pack id (`^[a-z][a-z0-9-]{0,63}$`).',
      '2. Set the same id in `manifest.json` (`id` must match the folder name).',
      '3. Edit agent prompts under `prompts/` and adjust `allowedTools`.',
      '4. Copy the folder to `~/.minnow/agent-packs/<your-pack-id>/`.',
      '5. Enable the pack under Settings → Agents → Agent packs.',
      '',
      'Folders starting with `_` are ignored by the scanner.',
      '',
    ].join('\n'),
    'prompts/example.full.md': [
      'You are an example work agent from a Minnow agent pack.',
      '',
      'Replace this prompt with role-specific instructions.',
      '',
    ].join('\n'),
  };
}

/** On-disk `_template` scaffold (authoring folder under ~/.minnow/agent-packs). */
export function getDiskTemplateFileMap() {
  const files = getAgentPackTemplateFileMap({ packId: '_template' });
  const manifest = JSON.parse(files['manifest.json']);
  manifest.label = 'Agent pack template (authoring only)';
  manifest.version = '0.0.0';
  manifest.description =
    'Copy this folder to a new id under agent-packs/ (without leading underscore).';
  manifest.enabled = false;
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  files['README.md'] =
    '# Agent pack template\n\n' +
    'Copy this directory to `~/.minnow/agent-packs/<your-pack-id>/` and edit `manifest.json`. ' +
    'Folders starting with `_` are ignored by the scanner.\n';
  return files;
}

/**
 * Write template files into a directory (creates subfolders as needed).
 * @param {string} rootDir
 * @param {Record<string, string>} fileMap
 */
export async function writeTemplateFiles(rootDir, fileMap) {
  await fs.mkdir(rootDir, { recursive: true });
  for (const [relPath, content] of Object.entries(fileMap)) {
    const target = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

/**
 * Build a STORE-method zip buffer for browser download.
 * @param {string} [zipRoot]
 * @returns {Buffer}
 */
export function buildAgentPackTemplateZip(zipRoot = AGENT_PACK_TEMPLATE_ZIP_ROOT) {
  const fileMap = getAgentPackTemplateFileMap({ packId: 'my-pack' });
  return buildZipFromFileMap(fileMap, zipRoot);
}

/**
 * Build a STORE zip from relative paths under a single root folder.
 * @param {Record<string, string>} fileMap
 * @param {string} zipRoot
 * @returns {Buffer}
 */
export function buildZipFromFileMap(fileMap, zipRoot) {
  const entries = Object.entries(fileMap).map(([rel, content]) => ({
    name: `${zipRoot}/${rel.replace(/\\/g, '/')}`,
    data: Buffer.from(content, 'utf8'),
  }));
  return createStoreZip(entries);
}

/** Minimal zip writer (uncompressed entries, no external deps). */
export function createStoreZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}
