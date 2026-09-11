/**
 * Super Plan artifacts: where they live, what a valid one looks like, and the
 * move that gives a run its final file name. I/O module (excluded from the
 * pure-core guard).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

import { formatParseErrors, isParseErrors, parsePlan } from '../orchestrator/core/parse-plan.js';
import { findImplementationCode } from './no-code-guard.js';

export const PLANS_DIR = 'documentation/plans';
export const REFERENCES_DIR = `${PLANS_DIR}/references`;

/** Shortest spec or plan the pipeline accepts as real work. */
const MIN_ARTIFACT_CHARS = 160;

// ── Paths ────────────────────────────────────────────────────────────────────

/**
 * @param {string} slug
 */
export function specPathFor(slug) {
  return `${REFERENCES_DIR}/${slug}-spec.md`;
}

/**
 * @param {string} slug
 */
export function researchPathFor(slug) {
  return `${REFERENCES_DIR}/${slug}-research.md`;
}

/**
 * @param {string} slug
 */
export function planPathFor(slug) {
  return `${PLANS_DIR}/${slug}.md`;
}

/**
 * Where each artifact is (or will be) for this run.
 * @param {import('./types').RunState} state
 * @returns {{ specPath: string, researchPath: string, planPath: string }}
 */
export function artifactPaths(state) {
  const slug = state.slug || state.runId;
  return {
    specPath: state.artifacts?.spec?.path || specPathFor(slug),
    researchPath: state.artifacts?.research?.path || researchPathFor(slug),
    planPath: state.artifacts?.plan?.path || planPathFor(slug),
  };
}

/**
 * Absolute path for a workspace-relative artifact path, refusing anything that
 * escapes `documentation/plans/`.
 * @param {string} workspacePath
 * @param {string} relative
 * @returns {string}
 */
export function resolveArtifactPath(workspacePath, relative) {
  if (!workspacePath) throw new Error('This run has no workspace folder.');
  const root = path.resolve(workspacePath);
  const plans = path.resolve(root, PLANS_DIR);
  const absolute = path.resolve(root, String(relative ?? '').replace(/\\/g, '/'));
  const inside = path.relative(plans, absolute);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`Super Plan only writes under ${PLANS_DIR}/ (got "${relative}")`);
  }
  return absolute;
}

/**
 * Normalise a model-supplied path for comparison with an expected one.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeRelativePath(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/**
 * @param {string} workspacePath
 * @param {string} relative
 * @returns {Promise<string | null>}
 */
export async function readArtifact(workspacePath, relative) {
  try {
    return await readFile(resolveArtifactPath(workspacePath, relative), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} workspacePath
 * @param {string} relative
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeArtifact(workspacePath, relative, content) {
  const absolute = resolveArtifactPath(workspacePath, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

/**
 * @param {string} workspacePath
 * @param {string} relative
 * @returns {Promise<boolean>}
 */
export async function artifactExists(workspacePath, relative) {
  try {
    await stat(resolveArtifactPath(workspacePath, relative));
    return true;
  } catch {
    return false;
  }
}

// ── Content checks ───────────────────────────────────────────────────────────

/**
 * @param {string} markdown
 * @returns {string}
 */
export function contentSha256(markdown) {
  return createHash('sha256').update(String(markdown), 'utf8').digest('hex');
}

/**
 * The first `#` heading, without trailing decoration.
 * @param {string} markdown
 * @returns {string}
 */
export function titleOf(markdown) {
  const body = String(markdown ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const match = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return match ? match[1].replace(/[*_`]/g, '').trim() : '';
}

/**
 * @param {string} markdown
 * @returns {number}
 */
function sectionCount(markdown) {
  return (String(markdown).match(/^##[ \t]+\S/gm) ?? []).length;
}

const UI_TERMS = /\b(ui|ux|frontend|front-end|css|layout|dashboard|screen|component|modal|dialog|button|form|sidebar|toolbar|responsive|accessib\w*|a11y|animation|theme|styles?|widget|tooltip|navigation)\b/gi;
const UI_PATHS = /\.(css|scss|tsx|jsx|vue|svelte|html)\b|\bsrc\/(ui|components|styles|pages|views)\//i;

/**
 * Does this artifact plan interface work? Several distinct UI terms, or files
 * that are plainly UI, mean yes. One passing mention does not.
 * @param {string} markdown
 * @returns {boolean}
 */
export function mentionsUi(markdown) {
  const text = String(markdown ?? '');
  if (UI_PATHS.test(text)) return true;
  const terms = new Set((text.match(UI_TERMS) ?? []).map((t) => t.toLowerCase()));
  return terms.size >= 3;
}

/**
 * @param {string | null} markdown
 * @param {string} relative
 * @param {'spec' | 'plan'} kind
 * @returns {string[]}
 */
function structuralErrors(markdown, relative, kind) {
  const label = kind === 'spec' ? 'build spec' : 'plan';
  if (markdown === null) return [`The ${label} was not saved. Write it to \`${relative}\` with save_file.`];
  if (markdown.replace(/\s+/g, '').length < MIN_ARTIFACT_CHARS) {
    return [`The ${label} at \`${relative}\` is too short to be useful. Write the complete document.`];
  }
  const errors = [];
  if (!titleOf(markdown)) errors.push(`The ${label} needs a \`# Title\` heading on its first heading line.`);
  if (sectionCount(markdown) < 2) errors.push(`The ${label} needs its \`##\` sections (see the required structure).`);
  const code = findImplementationCode(markdown);
  if (code) errors.push(code);
  return errors;
}

/**
 * @param {string | null} markdown
 * @param {string} relative
 * @returns {{ ok: boolean, errors: string[], title: string, sha256: string | null, bytes: number, involvesUi: boolean }}
 */
export function checkSpec(markdown, relative) {
  const errors = structuralErrors(markdown, relative, 'spec');
  return {
    ok: errors.length === 0,
    errors,
    title: markdown ? titleOf(markdown) : '',
    sha256: markdown === null ? null : contentSha256(markdown),
    bytes: markdown === null ? 0 : Buffer.byteLength(markdown, 'utf8'),
    involvesUi: markdown ? mentionsUi(markdown) : false,
  };
}

/**
 * A plan must be a board-ready task graph: front matter, a Wave Breakdown and
 * tasks with Build / Test / Accept / Touches. `parsePlan`'s errors carry line
 * numbers and hints, which is what makes the retry converge.
 *
 * @param {string | null} markdown
 * @param {string} relative
 * @param {{ previousSha256?: string | null, requireChange?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[], title: string, sha256: string | null, bytes: number, involvesUi: boolean, tasks: number }}
 */
export function checkPlan(markdown, relative, options = {}) {
  const errors = structuralErrors(markdown, relative, 'plan');
  let tasks = 0;
  if (markdown !== null && errors.length === 0) {
    const parsed = parsePlan(markdown);
    if (isParseErrors(parsed)) {
      errors.push(`The plan at \`${relative}\` does not parse as a board plan. Fix these and save it again:\n${formatParseErrors(/** @type {any} */ (parsed))}`);
    } else {
      tasks = /** @type {any} */ (parsed).tasks.length;
    }
  }
  const sha256 = markdown === null ? null : contentSha256(markdown);
  if (errors.length === 0 && options.requireChange && options.previousSha256 && sha256 === options.previousSha256) {
    errors.push(`The plan at \`${relative}\` did not change. Apply the requested revisions, then save it again.`);
  }
  return {
    ok: errors.length === 0,
    errors,
    title: markdown ? titleOf(markdown) : '',
    sha256,
    bytes: markdown === null ? 0 : Buffer.byteLength(markdown, 'utf8'),
    involvesUi: markdown ? mentionsUi(markdown) : false,
    tasks,
  };
}

// ── Identity ─────────────────────────────────────────────────────────────────

const GENERIC_TITLE_WORDS = /\b(build|product|technical|feature|implementation|project)?\s*(spec|specs|specification|brief|requirements|prd|plan)\b/gi;

/**
 * Kebab stem for a title, without the "build spec" / "plan" decoration models
 * like to add.
 * @param {string} title
 * @returns {string}
 */
export function slugFromTitle(title) {
  const cleaned = String(title ?? '')
    .replace(/[—–:|]+/g, ' ')
    .replace(GENERIC_TITLE_WORDS, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return trimSlug(cleaned, 56);
}

/**
 * Kebab stem for a prompt: the first words, capped.
 * @param {string} prompt
 * @param {number} [max]
 * @returns {string}
 */
export function slugFromPrompt(prompt, max = 40) {
  const cleaned = String(prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return trimSlug(cleaned, max);
}

/**
 * @param {string} slug
 * @param {number} max
 * @returns {string}
 */
function trimSlug(slug, max) {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > max / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '');
}

/**
 * The run's final file stem. Taken from the spec title; a stem another plan
 * already uses gets the run's short suffix.
 * @param {import('./types').RunState} state
 * @param {string} title
 * @returns {Promise<string>}
 */
export async function chooseSlug(state, title) {
  const base = slugFromTitle(title) || slugFromPrompt(state.prompt) || 'plan';
  const suffix = state.runId.split('-').pop()?.slice(0, 6) || 'run';
  const taken = async (slug) =>
    (await artifactExists(/** @type {string} */ (state.workspacePath), planPathFor(slug))) ||
    (await artifactExists(/** @type {string} */ (state.workspacePath), specPathFor(slug)));
  if (!(await taken(base))) return base;
  return `${base}-${suffix}`;
}

/**
 * Move a file inside documentation/plans/, replacing nothing.
 * @param {string} workspacePath
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function moveArtifact(workspacePath, from, to) {
  if (normalizeRelativePath(from) === normalizeRelativePath(to)) return;
  const source = resolveArtifactPath(workspacePath, from);
  const target = resolveArtifactPath(workspacePath, to);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') throw error;
    await copyFile(source, target);
    await unlink(source);
  }
}
