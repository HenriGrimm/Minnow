/** Agent-facing Godot inspection and lifecycle tools. */

import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { readSceneOutline } from './scene-outline.js';
import { resolveGodotProject } from './project.js';
import {
  getGodotLogs,
  getGodotStatus,
  runGodotScene,
  runGodotTask,
  startGodotEditor,
  stopGodot,
  validateGodotProject,
} from './controller.js';
import { getGodotDebugStatus, godotDebugRequest, setGodotBreakpoints, startGodotDebug } from './dap-client.js';
import { installManagedGodot } from './installer.js';

function result(value) {
  return JSON.stringify(value, null, 2);
}

export async function toolGodotInspect(args = {}) {
  const workspaceRoot = getEffectiveWorkspaceRoot();
  const action = String(args.action ?? 'status');
  if (action === 'status') {
    const status = await getGodotStatus(workspaceRoot, args);
    return result({
      ...status,
      debug: getGodotDebugStatus(status.project?.root),
    });
  }
  if (action === 'logs') return result(await getGodotLogs(workspaceRoot, args));
  if (action === 'scene_outline') {
    const selected = await resolveGodotProject(workspaceRoot, args.project);
    if (selected.status !== 'selected') return result(selected);
    return result({
      project: selected.project,
      outline: await readSceneOutline(selected.project.root, args.path),
    });
  }
  throw new Error(`Unsupported godot_inspect action: ${action}`);
}

export async function toolGodotControl(args = {}) {
  const workspaceRoot = getEffectiveWorkspaceRoot();
  const action = String(args.action ?? 'status');
  if (action === 'install_engine') return result(await installManagedGodot({ version: args.version }));
  if (action === 'open_editor') return result(await startGodotEditor(workspaceRoot, args));
  if (action === 'run_scene') return result(await runGodotScene(workspaceRoot, args));
  if (action === 'stop') return result(await stopGodot(workspaceRoot, args));
  if (action === 'validate') return result(await validateGodotProject(workspaceRoot, args));
  if (action === 'debug_start') return result(await startGodotDebug(workspaceRoot, args));
  if (action === 'debug_breakpoints') return result(await setGodotBreakpoints(workspaceRoot, args));
  if (action.startsWith('debug_')) {
    return result(await godotDebugRequest(workspaceRoot, {
      ...args,
      action: action.slice('debug_'.length),
    }));
  }
  if (['import', 'test', 'export'].includes(action)) {
    return result(await runGodotTask(workspaceRoot, { ...args, action }));
  }
  throw new Error(`Unsupported godot_control action: ${action}`);
}
