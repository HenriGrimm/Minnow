import fsp from 'node:fs/promises';
import path from 'node:path';

/** Conservative pre-launch estimate. MTPLX's /health memory_plan is authoritative. */
export async function estimateMtplxMemory(modelPath, settings, weightsBytes = 0) {
  let config = {};
  try { config = JSON.parse(await fsp.readFile(path.join(modelPath, 'config.json'), 'utf8')); } catch {}
  const text = config.text_config ?? config;
  const layers = Number(text.num_hidden_layers) || 0;
  const heads = Number(text.num_key_value_heads ?? text.num_attention_heads) || 0;
  const dim = Number(text.head_dim) || (Number(text.hidden_size) / Number(text.num_attention_heads)) || 0;
  const bytesPerElement = settings.paged_kv_quantization === 'q4' ? 0.625 : settings.paged_kv_quantization === 'q8' ? 1.125 : 2;
  const kvBytes = Math.max(0, layers * heads * dim * 2 * (settings.context_window ?? 0) * bytesPerElement);
  // Hybrid/recurrent and sliding-window models may use less; never infer undocumented geometry.
  return { weightsBytes, kvBytes, estimateGb: (weightsBytes * 1.1 + kvBytes + 512 * 1024 ** 2) / 1024 ** 3,
    estimateSource: layers && heads && dim ? 'config-upper-bound' : 'weights-only' };
}

export function diagnoseMtplxFailure(log, exitCode) {
  const text = String(log ?? '');
  if (/out of memory|failed to alloc|insufficient memory|memory.*limit|507|metal.*alloc/i.test(text)) return {
    code: 'oom_vram', title: 'MTPLX ran out of unified memory', detail: text,
    remediation: 'Reduce context window or use KV quantization, then reload.', retryable: true,
  };
  if (/address already in use|EADDRINUSE/i.test(text)) return {
    code: 'port_conflict', title: 'MTPLX port is occupied', detail: text,
    remediation: 'Retry to choose a free port.', retryable: true,
  };
  if (/contract|unverified|missing.*file|not.*supported/i.test(text)) return {
    code: 'model_incompatible', title: 'MTPLX could not validate this model', detail: text,
    remediation: 'Check MTPLX diagnostics and complete the model download.', retryable: false,
  };
  return { code: 'unknown', title: `MTPLX exited${exitCode == null ? '' : ` (${exitCode})`}`, detail: text,
    remediation: 'Check the serve log and Settings → Servers → MTPLX diagnostics.', retryable: true };
}
