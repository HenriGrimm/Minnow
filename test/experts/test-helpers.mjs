import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function fixtureExpertsDir() {
  return path.join(__dirname, '../fixtures/experts');
}

export async function loadExpertFixtureMap() {
  const root = fixtureExpertsDir();
  const map = {};
  const ids = await fs.readdir(root, { withFileTypes: true });
  for (const dirent of ids) {
    if (!dirent.isDirectory()) continue;
    const fullPath = path.join(root, dirent.name, 'expert.full.md');
    try {
      const raw = await fs.readFile(fullPath, 'utf8');
      map[`./experts/${dirent.name}/expert.full.md`] = raw;
    } catch {
      /* skip dirs without full md */
    }
  }
  return map;
}
