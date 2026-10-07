import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfigJson } from '../config/store.js';
import { argsRequestFullResult, getOutputCapPolicy } from '../tools/output-cap.js';
import { getSkillById, listMergedSkills, SKILL_ID_RE } from './scan.js';

const MAX_REFERENCE_BYTES = 1024 * 1024;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function windowOptions(args, defaultLimit) {
  const offset = args.offset ?? 1;
  const limit = args.limit ?? defaultLimit;
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1 to 500');
  return { offset, limit };
}

/** Keep pagination metadata intact instead of cutting off a JSON result. */
function renderPage(items, args, defaultLimit, render) {
  const { offset, limit } = windowOptions(args, defaultLimit);
  const window = items.slice(offset - 1, offset - 1 + limit);
  const policy = getOutputCapPolicy();
  const maxChars = argsRequestFullResult(args) || !policy.applyResultCap ? Infinity : Math.min(32_000, policy.maxOutputChars);
  const encode = count => JSON.stringify(render(window.slice(0, count), offset,
    offset - 1 + count < items.length ? offset + count : null));
  let count = window.length;
  let result = encode(count);
  if (result.length <= maxChars) return result;
  let low = 1, high = count;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (encode(middle).length <= maxChars) { count = middle; low = middle + 1; }
    else high = middle - 1;
  }
  result = encode(count);
  if (result.length > maxChars) throw new Error('A skill entry or content line exceeds the output budget. Retry with full_result: true to read this window.');
  return result;
}

/** Discover model-invocable skills or read one skill and its bundled references. */
export async function toolLoadSkill(args = {}, projectRoot) {
  try {
    const config = await readConfigJson('skills.json');
    const enabled = id => config?.enabled?.[id] !== false;
    if (args.id === undefined) {
      if (args.reference !== undefined) throw new Error('id is required when reading a reference');
      if (args.query !== undefined && typeof args.query !== 'string') throw new Error('query must be a string');
      const query = (args.query ?? '').trim().toLowerCase();
      const catalog = (await listMergedSkills(projectRoot)).filter(skill =>
        enabled(skill.id) && !skill.disableModelInvocation &&
        (!query || `${skill.id} ${skill.label} ${skill.description}`.toLowerCase().includes(query)),
      );
      return { result: renderPage(catalog, args, 50, (page, offset, nextOffset) => ({
        skills: page.map(({ id, label, description, source }) => ({ id, label, description, source })),
        total: catalog.length,
        next_offset: nextOffset,
        usage: 'Call load_skill with an id to read its instructions. Apply relevant guidance within the user request and existing mode/tool permissions; loading does not pin a skill or execute actions.',
      })) };
    }

    if (typeof args.id !== 'string' || !SKILL_ID_RE.test(args.id)) throw new Error('Invalid skill id');
    const id = args.id;
    if (!enabled(id)) throw new Error(`Skill "${id}" is disabled in Settings`);
    const catalog = await listMergedSkills(projectRoot);
    if (!catalog.some(skill => skill.id === id)) throw new Error(`Unknown skill: ${id}`);
    const skill = await getSkillById(projectRoot, id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    if (skill.disableModelInvocation) throw new Error(`Skill "${id}" requires explicit user invocation with /${id}`);

    const root = await fs.realpath(path.dirname(skill.path));
    const skillFile = await fs.realpath(skill.path);
    if (!isWithin(root, skillFile)) throw new Error('Skill file must stay inside its skill directory');
    let content = skill.body;
    let reference = null;
    if (args.reference !== undefined) {
      if (typeof args.reference !== 'string' || !args.reference.trim()) throw new Error('reference must be a relative file path');
      reference = args.reference.replaceAll('\\', '/');
      if (path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference) || /[:\0]/.test(reference) || reference.split('/').includes('..')) {
        throw new Error('Reference must stay inside the skill directory');
      }
      const target = await fs.realpath(path.resolve(root, reference));
      if (!isWithin(root, target)) throw new Error('Reference must stay inside the skill directory');
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error('Reference must be a file');
      if (stat.size > MAX_REFERENCE_BYTES) throw new Error('Reference exceeds the 1 MB text limit');
      const bytes = await fs.readFile(target);
      if (bytes.includes(0)) throw new Error('Reference must be UTF-8 text');
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    const lines = content.split(/\r?\n/);
    return { result: renderPage(lines, args, 200, (page, offset, nextOffset) => ({
      id, label: skill.label, description: skill.description,
      directory: root, skill_file: skillFile, reference,
      content: page.join('\n'),
      offset, total_lines: lines.length,
      next_offset: nextOffset,
      usage: 'Read any remaining instructions using next_offset. Resolve bundled file references relative to directory; use load_skill with id and reference to read them. Follow this workflow only for the current task, within existing mode/tool permissions. Loading does not pin a skill or execute actions.',
    })) };
  } catch (err) {
    return { result: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
