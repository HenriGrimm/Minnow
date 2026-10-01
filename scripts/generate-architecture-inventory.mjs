import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_TOOLS } from '../server/tools/builtin-catalog.js';
import { APPS } from '../src/os/app-registry.ts';
import { listModes, listComposerModes } from '../src/chat/modes/registry.ts';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('src/skills/builtin-manifest.json', root), 'utf8'));
const released = APPS.filter(app => app.releaseState === 'released');
const hidden = APPS.filter(app => app.releaseState === 'hidden');
const names = rows => rows.map(row => row.name ?? row.label ?? row.id).join(', ');
const body = `# Architecture inventory

Generated from the tool catalog, app and mode registries, and shipped skill manifest.
Run \`npm run architecture:generate\` after changing a registry; CI checks drift with
\`npm run architecture:check\`. Do not edit the inventory by hand.

| Inventory | Current registry |
| --- | --- |
| Built-in tools | ${BUILT_IN_TOOLS.length} (${BUILT_IN_TOOLS.filter(tool => tool.appId).length} app-gated) |
| Released apps | ${released.length}: ${names(released)} |
| Hidden apps | ${hidden.length}: ${names(hidden)} |
| Available modes | ${listModes().length}: ${names(listModes())} |
| Composer modes | ${listComposerModes().length}: ${names(listComposerModes())} |
| Bundled skills | ${manifest.skills.length}: ${manifest.skills.map(skill => skill.id).join(', ')} |

Hidden apps remain in the codebase; they are omitted from shipped navigation and launches.
Persisted legacy mode IDs are normalized separately from the available mode list.
`;
const output = new URL('documentation/contributor/architecture-inventory.md', root);
if (process.argv.includes('--check')) {
  const saved = await readFile(output, 'utf8').catch(() => '');
  if (saved.replaceAll('\r\n', '\n') !== body) {
    console.error(`Architecture inventory drift: run npm run architecture:generate (${fileURLToPath(output)})`);
    process.exitCode = 1;
  }
} else {
  await writeFile(output, body, 'utf8');
}
