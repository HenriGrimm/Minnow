import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultSkillLabel,
  parseSkillFrontmatter,
} from '../server/skills/parse-frontmatter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.join(__dirname, '../src/skills');
const OUT_FILE = path.join(SKILLS_ROOT, 'builtin-manifest.json');

function shouldExposeSkillDir(dirName) {
  if (dirName.startsWith('_')) return false;
  if (dirName === 'library') return false;
  return true;
}

async function main() {
  const skills = [];
  let entries;
  try {
    entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (err) {
    console.error('Cannot read skills root:', err);
    process.exit(1);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !shouldExposeSkillDir(entry.name)) continue;

    const skillPath = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
    let raw;
    try {
      raw = await fs.readFile(skillPath, 'utf8');
    } catch {
      console.warn(`Skip ${entry.name}: no SKILL.md`);
      continue;
    }

    try {
      const { meta } = parseSkillFrontmatter(raw);
      const id = meta.name.trim();
      if (id !== entry.name) {
        console.warn(`Skip ${entry.name}: name mismatch`);
        continue;
      }
      skills.push({
        id,
        label: meta.label?.trim() || defaultSkillLabel(id),
        description: meta.description.trim(),
        source: 'builtin',
        version: meta.version?.trim() || undefined,
        disableModelInvocation: meta['disable-model-invocation'] === 'true',
      });
    } catch (err) {
      console.warn(`Skip ${entry.name}:`, err.message);
    }
  }

  skills.sort((a, b) => a.label.localeCompare(b.label));

  await fs.writeFile(
    OUT_FILE,
    `${JSON.stringify({ skills }, null, 2)}\n`,
    'utf8',
  );
  console.log(`Wrote ${skills.length} skills to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
