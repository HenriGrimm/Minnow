import './bootstrap.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { readConfigJson } from '../config/store.js';
import { loadImageGenerationConfig, resolveImageBinding, resolveImageConnection } from './config.js';
import { normalizeImageRequest, validateImageCapabilities } from './contracts.js';
import { containedPath, imageMetadata, imageThumbnail, readImageReference, sha256, writeImageAsset } from './assets.js';
import { cleanupImageJobs, readImageJob, runImageJob, workspaceJournal } from './jobs.js';

let running = 0;

export async function describeImageGeneration(args, workspace, signal) {
  if (args.job_id) return readImageJob(getMinnowHome(), workspace, args.job_id);
  const config = await loadImageGenerationConfig();
  if (args.list_models === true) {
    try {
      const { adapter, runtime } = await resolveImageConnection({
        ...config,
        providerId: args.provider_id ?? config.providerId,
        adapterId: args.adapter_id ?? config.adapterId,
      });
      const boundedSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
      const models = await adapter.catalog(runtime, boundedSignal);
      return { status: 'Available', models };
    } catch {
      return { status: 'Unavailable', models: [], error: 'Could not load image models. Check provider credentials and the image adapter, then refresh.' };
    }
  }
  try {
    const { binding, adapter, runtime, fingerprint } = await resolveImageBinding(config);
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    const capabilities = await adapter.capabilities(binding.modelId, runtime, boundedSignal);
    const models = await adapter.catalog(runtime, boundedSignal);
    if (models && !models.some(model => model.id === binding.modelId)) throw new Error('Selected model unavailable');
    return { status: 'Ready', binding, fingerprint, capabilities, models, cost: null, notice: 'Cost unavailable; provider charges may apply. Prompts and reference images are uploaded to the selected provider.' };
  } catch (error) {
    return { status: config.enabled ? 'Unavailable' : 'Not configured', binding: config, error: 'Verify the image provider, adapter and model in Models → Routing → Image generation.' };
  }
}

export async function executeImageGeneration(args, options) {
  const tools = await readConfigJson('tools.json');
  const permission = tools?.permissions?.default?.generate_image ?? 'ask';
  if (['plan', 'super-plan'].includes(options.modeId)) throw new Error('Plan mode cannot generate images');
  if (permission === 'off') throw new Error('Image generation is disabled in Settings → Tools');
  if (permission !== 'full' && options.imageApproval?.approved !== true) throw new Error('Image generation requires approval; unattended callers require Full permission');
  const identity = options.executionIdentity;
  if (!identity) throw new Error('Image generation requires a runner execution identity');
  try { return await readImageJob(getMinnowHome(), options.workspaceRoot, sha256(identity)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = await loadImageGenerationConfig();
  const resolved = await resolveImageBinding(config);
  const { binding, adapter, runtime, fingerprint } = resolved;
  if (options.imageApproval && options.imageApproval.fingerprint !== fingerprint) throw new Error('Image binding changed; approve the new provider and model');
  const signal = AbortSignal.any([AbortSignal.timeout(binding.timeoutSeconds * 1000), ...(options.abortSignal ? [options.abortSignal] : [])]);
  const request = normalizeImageRequest(args, binding.defaults);
  if (request.output_path) {
    const extension = path.extname(request.output_path).toLowerCase();
    const format = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }[extension];
    if (!format) throw new Error('Output must have a PNG, JPEG or WebP extension');
    if (request.format && request.format !== format) throw new Error('Output extension must match requested format');
    request.format = format;
  }
  const caps = await adapter.capabilities(binding.modelId, runtime, signal);
  validateImageCapabilities(request, caps);
  const references = [];
  for (const relative of request.reference_paths) references.push(await readImageReference(options.workspaceRoot, relative, signal));
  if (request.output_path) {
    const destination = await containedPath(options.workspaceRoot, request.output_path, true);
    if (await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Image output already exists');
    if (request.reference_paths.includes(request.output_path)) throw new Error('Cannot overwrite a reference image');
  }
  if (running >= binding.maxConcurrentJobs) throw new Error('Image generation is busy; wait for the active job');
  const current = await resolveImageBinding(await loadImageGenerationConfig());
  if (current.fingerprint !== fingerprint) throw new Error('Image binding changed; approve the new provider and model');
  const currentPermission = (await readConfigJson('tools.json'))?.permissions?.default?.generate_image ?? 'ask';
  if (currentPermission === 'off' || (currentPermission !== 'full' && !options.imageApproval?.approved)) throw new Error('Image permission changed');
  if (running >= binding.maxConcurrentJobs) throw new Error('Image generation is busy; wait for the active job');
  running++;
  let job;
  try {
    job = await runImageJob({ home: getMinnowHome(), workspace: options.workspaceRoot, identity, signal,
      metadata: { providerId: binding.providerId, modelId: binding.modelId, adapterId: binding.adapterId, promptHash: sha256(request.prompt), references: references.map(ref => ({ path: ref.path, sha256: ref.sha256 })) },
      execute: async (jobId, update) => {
        signal.throwIfAborted();
        const generated = await adapter.generate({ runtime, modelId: binding.modelId, request, references, signal, capabilities: caps });
        signal.throwIfAborted();
        const metadata = await imageMetadata(generated.bytes, generated.mime);
        const directory = await workspaceJournal(getMinnowHome(), options.workspaceRoot);
        const recovery = path.join(directory, `${jobId}.asset`);
        await fs.writeFile(recovery, generated.bytes, { flag: 'wx', signal, mode: 0o600 });
        await update({ status: 'running', requestId: generated.requestId, usage: generated.usage, cost: generated.cost, recoverable: true });
        const relative = request.output_path ?? `assets/generated/${jobId}.${metadata.extension}`;
        signal.throwIfAborted();
        const artifact = await writeImageAsset(options.workspaceRoot, relative, generated.bytes, signal);
        await fs.unlink(recovery).catch(() => {});
        return { artifacts: [artifact], usage: generated.usage, cost: generated.cost, routedProvider: generated.routedProvider, recoverable: false };
      },
    });
  } finally { running--; }
  void cleanupImageJobs(getMinnowHome(), options.workspaceRoot).catch(() => {});
  return job;
}

export async function imageJobToolResult(job, workspace) {
  const attachments = [];
  if (job.status === 'succeeded') for (const artifact of job.artifacts) {
    const ref = await readImageReference(workspace, artifact.path).catch(() => null);
    if (!ref || ref.sha256 !== artifact.sha256) continue;
    attachments.push({ type: 'image', mime: artifact.mime, alt: 'Generated image',
      url: `/api/preview/file/${artifact.path.split('/').map(encodeURIComponent).join('/')}?workspaceRoot=${encodeURIComponent(workspace)}`,
      dataUrl: `data:image/png;base64,${(await imageThumbnail(ref.bytes)).toString('base64')}`,
      generated: { jobId: job.jobId, providerId: job.providerId, modelId: job.modelId, ...artifact },
    });
  }
  return { result: JSON.stringify(job), attachments };
}
