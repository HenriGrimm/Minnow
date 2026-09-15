/**
 * Paths for the managed voice Python runtime under ~/.minnow/voice.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMinnowHome } from '../config/home.js';

/** Voice runtime root (~/.minnow/voice). */
export function getVoiceRoot() {
  return path.join(getMinnowHome(), 'voice');
}

/** Python venv for the voice worker. */
export function getVoiceVenvDir() {
  return path.join(getVoiceRoot(), 'venv');
}

/** Install + worker metadata (~/.minnow/voice/meta.json). */
export function getVoiceMetaPath() {
  return path.join(getVoiceRoot(), 'meta.json');
}

/** Persistent worker stdout/stderr log. */
export function getVoiceLogPath() {
  return path.join(getMinnowHome(), 'logs', 'voice-worker.log');
}

/** Absolute path to the bundled worker.py script. */
export function getVoiceWorkerScriptPath(modulePath = fileURLToPath(import.meta.url)) {
  // Python cannot read Electron's virtual ASAR filesystem.
  const script = path.join(path.dirname(modulePath), 'python', 'worker.py');
  return script.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/** Root for downloaded voice model snapshots (~/.minnow/models/voice). */
export function getVoiceModelsRoot() {
  return path.join(getMinnowHome(), 'models', 'voice');
}

/**
 * Destination directory for a voice model snapshot.
 * @param {string} modelId HuggingFace repo id (org/name)
 */
export function voiceModelDir(modelId) {
  const safe = modelId.replace(/\//g, '--');
  return path.join(getVoiceModelsRoot(), safe);
}

/** Installed voice models manifest (~/.minnow/voice/installed.json). */
export function getVoiceInstalledPath() {
  return path.join(getVoiceRoot(), 'installed.json');
}

/** Voice model download job index (~/.minnow/voice/downloads.json). */
export function getVoiceDownloadsIndexPath() {
  return path.join(getVoiceRoot(), 'downloads.json');
}

/** Reference audio uploads for voice clone (~/.minnow/voice/refs). */
export function getVoiceRefsDir() {
  return path.join(getVoiceRoot(), 'refs');
}

/** Saved voice-clone prompts (~/.minnow/voice/clone-prompts). */
export function getVoiceClonePromptsDir() {
  return path.join(getVoiceRoot(), 'clone-prompts');
}
