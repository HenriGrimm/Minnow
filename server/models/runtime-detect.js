/**
 * Detect local inference runtimes (llama.cpp, mlx-lm, Ollama, LM Studio).
 */

import { getManagedServerPort, isManagedServerRunning } from '../servers/manager.js';
import { getInstallStatus as getMlxInstallStatus, isMlxSupported } from '../servers/mlx-lm.js';
import { runProcess } from '../process-runner.js';
import { isLlamaRuntimeInstallable, resolveLlamaServer, getInstalledLlamaVariant } from './llama-runtime.js';
import { isGpuCapableVariant } from './llama-variant.js';

/**
 * @param {string} cmd
 */
async function which(cmd) {
  try {
    if (process.platform === 'win32') {
      const { code, stdout } = await runProcess('where', [cmd], { timeout: 3_000 });
      if (code === 0 && stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
      return null;
    }
    const { code, stdout } = await runProcess('which', [cmd], { timeout: 3_000 });
    if (code === 0 && stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 */
async function probeHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * mlxLm.available is true when this machine could run MLX at all (installed or not).
 * @returns {Promise<{ llamaCpp: { available: boolean, path: string | null, bundled: boolean, installable: boolean }, mlxLm: { available: boolean, installed: boolean, installable: boolean, running: boolean, port: number | null }, ollama: { available: boolean, path: string | null, serving: boolean }, lmStudio: { available: boolean, baseUrl: string | null } }>}
 */
export async function detectRuntimes() {
  const [llamaResolved, ollamaPath, lmOk, ollamaOk, mlxStatus, mlxPort] = await Promise.all([
    resolveLlamaServer(),
    which('ollama'),
    probeHttp('http://127.0.0.1:1234/v1/models'),
    probeHttp('http://127.0.0.1:11434/api/tags'),
    getMlxInstallStatus().catch(() => ({ installed: false })),
    getManagedServerPort('mlx-lm').catch(() => null),
  ]);
  const installable = isLlamaRuntimeInstallable();
  const variant = await getInstalledLlamaVariant();
  const mlxSupported = isMlxSupported();

  return {
    mlxLm: {
      available: mlxSupported,
      installed: mlxStatus.installed === true,
      installable: mlxSupported,
      running: isManagedServerRunning('mlx-lm'),
      port: mlxPort,
    },
    llamaCpp: {
      available: Boolean(llamaResolved.path) || installable,
      path: llamaResolved.path,
      bundled:
        llamaResolved.source === 'vendor' ||
        llamaResolved.source === 'managed' ||
        llamaResolved.source === 'fork',
      engineId: llamaResolved.engineId,
      installable,
      variant,
      gpuCapable: variant ? isGpuCapableVariant(variant) : false,
    },
    ollama: {
      available: Boolean(ollamaPath),
      path: ollamaPath,
      serving: ollamaOk,
      baseUrl: ollamaOk ? 'http://127.0.0.1:11434' : null,
    },
    lmStudio: {
      available: lmOk,
      baseUrl: lmOk ? 'http://127.0.0.1:1234' : null,
    },
  };
}
