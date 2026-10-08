/**
 * Read the maintained, project-neutral design reference from the Minnow app root.
 * Bundled markdown — no workspace dependency or subprocess. Callable as a
 * plain tool from normal chat/work agents (no mode/hub coupling).
 */

import fs from 'node:fs';
import path from 'node:path';

const REFERENCE_RELATIVE = path.join(
  'src',
  'skills',
  'frontend-design',
  'reference',
  'frontend-aesthetics.md',
);

/**
 * @param {string} appRoot Minnow install (npm start cwd)
 * @returns {Promise<{ result: string }>}
 */
export async function toolLoadAestheticsReference(appRoot) {
  const referencePath = path.join(appRoot, REFERENCE_RELATIVE);

  if (!fs.existsSync(referencePath)) {
    return {
      result: `Error: missing frontend-aesthetics reference at ${referencePath}. Update or reinstall Minnow from a release that includes this asset. For a source checkout, restore src/skills/frontend-design/reference/frontend-aesthetics.md.`,
    };
  }

  try {
    const contents = await fs.promises.readFile(referencePath, 'utf8');
    return { result: contents };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: `Error: failed to read frontend-aesthetics reference: ${message}`,
    };
  }
}
