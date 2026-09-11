/**
 * Minnow context loader: upstream PRODUCT/DESIGN JSON plus optional .impeccable/design.json.
 * Prints one JSON object to stdout for agent consumption.
 * Missing sidecar is soft success (exit 0); invalid sidecar when present is a hard error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from './context.mjs';

/** Shown when .impeccable/design.json is absent (setup state, not a process failure). */
const DESIGN_JSON_SETUP_HINT =
  'Run /impeccable document in this workspace to generate .impeccable/design.json.';

/**
 * Workspace where PRODUCT.md, DESIGN.md, and .impeccable/ live.
 * IMPECCABLE_CONTEXT_DIR is set by Minnow's load_impeccable_context tool; manual
 * runs use the cwd (the script itself lives in ~/.minnow/skills/impeccable).
 */
function resolveWorkspaceRoot() {
  const envDir = process.env.IMPECCABLE_CONTEXT_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  return process.cwd();
}

/**
 * Resolve sidecar path under contextDir (monorepo IMPECCABLE_CONTEXT_DIR safe).
 *
 * @param {string} contextDir
 * @param {string} workspaceRoot for relative paths in errors
 * @returns {{
 *   hasDesignJson: boolean,
 *   designJson: Record<string, unknown> | null,
 *   designJsonSetupHint: string | null,
 * }}
 */
function loadDesignJson(contextDir, workspaceRoot) {
  const designJsonPath = path.join(contextDir, '.impeccable', 'design.json');

  if (!fs.existsSync(designJsonPath)) {
    return {
      hasDesignJson: false,
      designJson: null,
      designJsonSetupHint: DESIGN_JSON_SETUP_HINT,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(designJsonPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid .impeccable/design.json: ${message}`);
  }

  if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
    throw new Error(
      `Expected design.json schemaVersion 2 or 3, got ${String(parsed.schemaVersion)}`,
    );
  }

  return {
    hasDesignJson: true,
    designJson: parsed,
    designJsonSetupHint: null,
  };
}

function main() {
  try {
    const workspaceRoot = resolveWorkspaceRoot();
    const ctx = loadContext(workspaceRoot);
    const sidecar = loadDesignJson(ctx.contextDir, workspaceRoot);

    const payload = {
      ...ctx,
      ...sidecar,
      workspaceRoot,
      designJsonPath: path.relative(
        workspaceRoot,
        path.join(ctx.contextDir, '.impeccable', 'design.json'),
      ),
    };

    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

main();
