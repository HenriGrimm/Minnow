/**
 * Post-sync Minnow patches for vendored Impeccable reference/ and SKILL.upstream.md.
 * Idempotent: safe to run after every impeccable:sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listHarnessCommandNames } from '../../src/skills/impeccable/harness-registry.mjs';
import { parseValidCommandsFromPin } from '../../src/skills/impeccable/harness-registry-node.mjs';

/** Placeholder prefix: server/impeccable/skill-install.js rewrites it to ~/.minnow/skills/impeccable on install. */
const MINNOW_SCRIPTS_PATH = 'src/skills/impeccable/scripts';

const CONTEXT_LOAD_INSTRUCTION =
  'Call the `load_impeccable_context` tool first to load PRODUCT.md, DESIGN.md, and optional `.impeccable/design.json`. Manual fallback from the workspace root: `node src/skills/impeccable/scripts/minnow-context.mjs`.';

/** craft.md Step 1 — agents must not call run_impeccable or npx for shape. */
const CRAFT_STEP1_VARIANTS = [
  'Run {{command_prefix}}impeccable shape, passing along whatever feature description the user provided. Shape is **required** for craft; it is what produces a confirmed direction.',
  'Run /impeccable shape, passing along whatever feature description the user provided. Shape is **required** for craft; it is what produces a confirmed direction.',
  'Run $impeccable shape, passing along whatever feature description the user provided. Shape is **required** for craft; it is what produces a confirmed direction.',
];

const CRAFT_STEP1_NEW =
  "Follow the **Shape workflow** section below (`## Prerequisite workflow: shape`). Run that discovery interview in chat using the user's feature description. Do not call `run_impeccable` or `npx impeccable shape`. Shape is **required** for craft; it is what produces a confirmed direction.";

const UPSTREAM_SCRIPTS_PREFIX = '.agents/skills/impeccable/scripts/';

/**
 * @param {string} targetDir
 * @returns {Record<string, unknown>}
 */
function loadCommandMetadata(targetDir) {
  const metadataPath = path.join(targetDir, 'scripts', 'command-metadata.json');
  if (!fs.existsSync(metadataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
}

/**
 * @param {string} content
 * @param {Record<string, unknown>} metadata
 * @returns {string}
 */
function patchMinnowTokens(content, metadata) {
  let text = content;

  text = text.replaceAll('{{command_prefix}}', '/');
  text = text.replaceAll('{{scripts_path}}', MINNOW_SCRIPTS_PATH);
  text = text.replaceAll(UPSTREAM_SCRIPTS_PREFIX, `${MINNOW_SCRIPTS_PATH}/`);
  text = text.replaceAll('{{ask_instruction}}', 'Use the `ask_question` tool to');
  text = text.replaceAll('{{config_file}}', 'AGENTS.md');
  text = text.replace(/\{\{model\}\}/g, '');

  const commandNames = Object.keys(metadata).sort();
  text = text.replaceAll('{{available_commands}}', commandNames.join(', '));
  text = text.replaceAll('{{command_hint}}', commandNames.join('|'));

  // Context loader setup blocks and inline invocations → Minnow tool first.
  text = text.replace(
    /```bash\s*\nnode (?:\{\{scripts_path\}\}|[^\n`]+)\/(?:load-context|context)\.mjs[^\n]*\n```/g,
    CONTEXT_LOAD_INSTRUCTION,
  );
  text = text.replace(
    /Run the shared loader first so you know what already exists:\s*\n\s*\n(?:Call the `load_impeccable_context` tool[^\n]*\.|```bash[\s\S]*?```)/,
    `Run the shared loader first so you know what already exists:\n\n${CONTEXT_LOAD_INSTRUCTION}`,
  );
  text = text.replace(
    /run `node [^`]+(?:load-context|context)\.mjs`/gi,
    'call the `load_impeccable_context` tool',
  );
  text = text.replace(
    /`node [^`]+(?:load-context|context)\.mjs`/g,
    '`load_impeccable_context` tool (fallback: `node src/skills/impeccable/scripts/minnow-context.mjs`)',
  );
  text = text.replace(
    /node [^\n`]+(?:load-context|context)\.mjs/g,
    (match) => {
      if (match.includes('minnow-context')) return match;
      return '`load_impeccable_context` tool (fallback: `node src/skills/impeccable/scripts/minnow-context.mjs`)';
    },
  );

  // SKILL.upstream setup step 1 (v3 context.mjs boot line).
  text = text.replace(
    /Run `node (?:\{\{scripts_path\}\}|src\/skills\/impeccable\/scripts)\/context\.mjs` once per session\.[^\n]*/g,
    `${CONTEXT_LOAD_INSTRUCTION} If you've already loaded context in this conversation, do not re-run it. **If PRODUCT.md is missing, stop and follow \`reference/init.md\` before doing anything else.**`,
  );

  text = text.replace(/npx impeccable detect/g, '`run_impeccable` with `command: detect`');

  // Upstream $impeccable slash syntax → Minnow /impeccable (avoid hooks$impeccable.json).
  text = text.replace(/\$impeccable(?![\w.-])/g, '/impeccable');

  text = text.replace(/impeccable teach/g, '/impeccable init');
  text = text.replace(/`impeccable init`/g, '`/impeccable init`');

  return text;
}

/**
 * @param {string} text
 * @returns {string}
 */
function patchCraftStep1(text) {
  let patched = text;
  for (const variant of CRAFT_STEP1_VARIANTS) {
    patched = patched.replace(variant, CRAFT_STEP1_NEW);
  }
  return patched;
}

/**
 * @param {string} filePath
 * @param {string} text
 * @param {Record<string, unknown>} metadata
 * @returns {string}
 */
function patchMarkdownFile(filePath, text, metadata) {
  let patched = patchMinnowTokens(text, metadata);
  if (path.basename(filePath) === 'craft.md') {
    patched = patchCraftStep1(patched);
  }
  return patched;
}

/**
 * @param {string} targetDir Absolute path to src/skills/impeccable (or override)
 */
export function applyMinnowImpeccablePatches(targetDir) {
  const pinPath = path.join(targetDir, 'scripts', 'pin.mjs');
  let harnessNames = listHarnessCommandNames();
  if (fs.existsSync(pinPath)) {
    const pinSource = fs.readFileSync(pinPath, 'utf8');
    if (pinSource.includes('{{command_prefix}}')) {
      fs.writeFileSync(
        pinPath,
        pinSource.replaceAll('{{command_prefix}}', '/'),
        'utf8',
      );
    }

    harnessNames = parseValidCommandsFromPin(pinPath);
    const commandsPath = path.join(targetDir, 'harness-commands.json');
    fs.writeFileSync(commandsPath, `${JSON.stringify(harnessNames, null, 2)}\n`, 'utf8');
  }

  const metadata = loadCommandMetadata(targetDir);
  const referenceDir = path.join(targetDir, 'reference');

  if (fs.existsSync(referenceDir)) {
    const extraHarnessLegacy = ['teach.md', 'personas.md'];
    const harnessFiles = new Set([
      ...harnessNames.map((name) => `${name}.md`),
      ...extraHarnessLegacy,
    ]);

    for (const name of harnessFiles) {
      const filePath = path.join(referenceDir, name);
      if (!fs.existsSync(filePath)) continue;
      const patched = patchMarkdownFile(
        filePath,
        fs.readFileSync(filePath, 'utf8'),
        metadata,
      );
      fs.writeFileSync(filePath, patched, 'utf8');
    }
  }

  const upstreamSkill = path.join(targetDir, 'SKILL.upstream.md');
  if (fs.existsSync(upstreamSkill)) {
    const patched = patchMarkdownFile(
      upstreamSkill,
      fs.readFileSync(upstreamSkill, 'utf8'),
      metadata,
    );
    fs.writeFileSync(upstreamSkill, patched, 'utf8');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetDir = path.resolve(
    process.argv[2] || path.join(process.cwd(), 'src/skills/impeccable'),
  );
  applyMinnowImpeccablePatches(targetDir);
  console.log(`[impeccable:patches] Applied Minnow patches → ${targetDir}`);
}
