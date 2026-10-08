import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { describeImageGeneration, executeImageGeneration, imageJobToolResult } from '../image-generation/service.js';

export async function toolGenerateImage(args, options) {
  const workspaceRoot = getEffectiveWorkspaceRoot();
  return imageJobToolResult(await executeImageGeneration(args, { ...options, workspaceRoot }), workspaceRoot);
}

export async function toolImageGenerationInfo(args, options) {
  return JSON.stringify(await describeImageGeneration(args, getEffectiveWorkspaceRoot(), options.abortSignal));
}
