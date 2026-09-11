/**
 * Run the installed skill's minnow-context.mjs against the active workspace.
 * Scripts live in ~/.minnow/skills/impeccable; PRODUCT.md / DESIGN.md /
 * design.json are read from the workspace (IMPECCABLE_CONTEXT_DIR).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildImpeccableSpawnEnv } from './spawn-env.js';

const CONTEXT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_CHARS = 96_000;

/**
 * @param {string} skillDir Installed Impeccable skill dir (~/.minnow/skills/impeccable)
 * @param {string} workspaceRoot Active workspace for design files
 */
export function toolLoadImpeccableContext(skillDir, workspaceRoot) {
  const scriptPath = path.join(skillDir, 'scripts', 'minnow-context.mjs');

  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({
      result: `Error: missing Impeccable context script at ${scriptPath}. Restart Minnow to reinstall the skill into ${skillDir}.`,
    });
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workspaceRoot,
      // Packaged Electron: ELECTRON_RUN_AS_NODE so execPath runs as Node, not a second app.
      env: buildImpeccableSpawnEnv(workspaceRoot),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, CONTEXT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT_CHARS) {
        stdout = `${stdout.slice(0, MAX_STDOUT_CHARS)}\n…[truncated]`;
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          result: `Error: load_impeccable_context timed out after ${CONTEXT_TIMEOUT_MS / 1000}s`,
        });
        return;
      }
      if (code !== 0) {
        const errText = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
        resolve({
          result:
            `Error: load_impeccable_context exited ${code}\n` +
            (errText || `(workspace ${workspaceRoot})`),
        });
        return;
      }

      const trimmed = stdout.trim() || '{}';
      try {
        const payload = JSON.parse(trimmed);
        if (payload.hasDesignJson === false && payload.designJsonSetupHint) {
          resolve({
            result: `${trimmed}\n\nNote: ${payload.designJsonSetupHint}`,
          });
          return;
        }
      } catch {
        /* Non-JSON stdout — return as-is */
      }
      resolve({ result: trimmed });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        result: `Error: failed to run minnow-context.mjs: ${err.message}`,
      });
    });
  });
}
