import {
  createLandlockAdapter,
  resolveMinnowSandboxHelper,
  wrapWithLandlock,
} from './landlock.js';
import {
  modeAttemptsSandbox,
  normalizeShellSandboxMode,
} from './mode.js';
import { buildWorkspacePolicy } from './policy.js';
import { createSeatbeltAdapter } from './seatbelt.js';
import {
  SANDBOX_UNAVAILABLE_REASON,
  describeSandboxUnavailable,
} from './unavailable.js';
import {
  composeWslLandlockWrap,
  createWslLandlockAdapter,
  resetWslLandlockProbeCache,
} from './wsl-landlock.js';

/**
 * @typedef {object} SandboxAdapter
 * @property {'seatbelt'|'landlock'|'wsl-landlock'|'none'} kind
 * @property {string} [unavailableReason]
 * @property {() => Promise<{ ok: boolean, reason?: string, detail?: string }>} probe
 * @property {(spawnTarget: object, policy: import('./policy.js').SandboxPolicy) => object} wrap
 */

/**
 * @typedef {object} SandboxMeta
 * @property {boolean} applied
 * @property {'seatbelt'|'landlock'|'wsl-landlock'|'none'} [kind]
 * @property {string} [reason]
 * @property {string} [detail]
 * @property {string} [profile]
 * @property {'off'|'prefer'|'require'} [mode]
 * @property {boolean} [fallbackUnsandboxed]
 * @property {boolean} [blocked]
 * @property {boolean} [needsEscalation]
 */

/** @type {{ platform: string, result: { ok: boolean, reason?: string, detail?: string } } | null} */
let probeCache = null;

/**
 * @param {string} [platform]
 * @returns {SandboxAdapter}
 */
export function resolveSandbox(platform = process.platform) {
  if (platform === 'darwin') {
    return createSeatbeltAdapter();
  }
  if (platform === 'linux') {
    return createLandlockAdapter();
  }
  if (platform === 'win32') {
    return createWslLandlockAdapter();
  }
  const reason = SANDBOX_UNAVAILABLE_REASON.PLATFORM_UNSUPPORTED;
  return {
    kind: 'none',
    unavailableReason: reason,
    probe: async () => ({
      ok: false,
      reason,
      detail: describeSandboxUnavailable(reason),
    }),
    wrap() {
      throw new Error(describeSandboxUnavailable(reason));
    },
  };
}

/**
 * @param {string} [platform]
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: string }>}
 */
export async function probeSandbox(platform = process.platform) {
  if (probeCache && probeCache.platform === platform) {
    return probeCache.result;
  }
  const adapter = resolveSandbox(platform);
  const result = await adapter.probe();
  probeCache = { platform, result };
  return result;
}

export function resetSandboxProbeCache() {
  probeCache = null;
  resetWslLandlockProbeCache();
}

/**
 * @param {object} params
 * @param {'user'|'agent'} [params.source]
 * @param {boolean} [params.sandbox]
 * @param {'off'|'prefer'|'require'} [params.mode]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {boolean}
 */
export function shouldApplyShellSandbox({
  source = 'agent',
  sandbox,
  mode,
  env = process.env,
} = {}) {
  if (sandbox === false) return false;
  if (source !== 'agent') return false;
  if (sandbox === true) return true;

  const resolvedMode =
    mode != null
      ? normalizeShellSandboxMode(mode, 'off')
      : env.MINNOW_SHELL_SANDBOX === '1'
        ? 'prefer'
        : 'off';
  return modeAttemptsSandbox(resolvedMode);
}

/**
 * @param {{ command: string, args?: string[], shell?: boolean, cwd?: string, env?: NodeJS.ProcessEnv }} spawnTarget
 * @param {import('./policy.js').SandboxPolicy} policy
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {object} [options.wsl]
 * @returns {{ command: string, args: string[], shell: boolean, cwd?: string, env?: NodeJS.ProcessEnv, sandbox: SandboxMeta }}
 */
export function wrapSandbox(spawnTarget, policy, { platform = process.platform, wsl } = {}) {
  const adapter = resolveSandbox(platform);

  if (adapter.kind === 'seatbelt') {
    const wrapped = adapter.wrap(spawnTarget, policy);
    return {
      ...wrapped,
      sandbox: {
        applied: true,
        kind: 'seatbelt',
        profile: policy.profile,
      },
    };
  }

  if (adapter.kind === 'landlock') {
    const helperPath = resolveMinnowSandboxHelper();
    if (!helperPath) {
      const reason = SANDBOX_UNAVAILABLE_REASON.LANDLOCK_HELPER_MISSING;
      return {
        command: spawnTarget.command,
        args: Array.isArray(spawnTarget.args) ? [...spawnTarget.args] : [],
        shell: spawnTarget.shell === true,
        ...(spawnTarget.cwd != null ? { cwd: spawnTarget.cwd } : {}),
        ...(spawnTarget.env != null ? { env: spawnTarget.env } : {}),
        sandbox: {
          applied: false,
          kind: 'landlock',
          reason,
          detail: describeSandboxUnavailable(reason),
        },
      };
    }
    const wrapped = wrapWithLandlock(spawnTarget, policy, { helperPath });
    return {
      ...wrapped,
      sandbox: {
        applied: true,
        kind: 'landlock',
        profile: policy.profile,
      },
    };
  }

  if (adapter.kind === 'wsl-landlock') {
    const composed = composeWslLandlockWrap(spawnTarget, policy, {
      ...(wsl && typeof wsl === 'object' ? wsl : {}),
    });
    if (!composed.ok) {
      return {
        command: spawnTarget.command,
        args: Array.isArray(spawnTarget.args) ? [...spawnTarget.args] : [],
        shell: spawnTarget.shell === true,
        ...(spawnTarget.cwd != null ? { cwd: spawnTarget.cwd } : {}),
        ...(spawnTarget.env != null ? { env: spawnTarget.env } : {}),
        sandbox: {
          applied: false,
          kind: 'wsl-landlock',
          reason: composed.reason,
          detail: composed.detail,
        },
      };
    }
    return {
      ...composed.spawn,
      sandbox: {
        applied: true,
        kind: 'wsl-landlock',
        profile: policy.profile,
      },
    };
  }

  const reason =
    adapter.unavailableReason ?? SANDBOX_UNAVAILABLE_REASON.PLATFORM_UNSUPPORTED;
  return {
    command: spawnTarget.command,
    args: Array.isArray(spawnTarget.args) ? [...spawnTarget.args] : [],
    shell: spawnTarget.shell === true,
    ...(spawnTarget.cwd != null ? { cwd: spawnTarget.cwd } : {}),
    ...(spawnTarget.env != null ? { env: spawnTarget.env } : {}),
    sandbox: {
      applied: false,
      kind: adapter.kind,
      reason,
      detail: describeSandboxUnavailable(reason),
    },
  };
}

/**
 * @param {object} spawnTarget
 * @param {object} params
 * @param {'user'|'agent'} [params.source]
 * @param {boolean} [params.sandbox]
 * @param {'off'|'prefer'|'require'} [params.mode]
 * @param {boolean} [params.allowUnsandboxed]
 * @param {string} params.cwd
 * @param {string} [params.workspaceRoot]
 * @param {string} [params.worktreeRoot]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {string} [params.platform]
 * @param {'native'|'wsl'|'git-bash'} [params.runtime]
 * @returns {ReturnType<typeof wrapSandbox> | (typeof spawnTarget & { sandbox?: SandboxMeta })}
 */
export function applyAgentShellSandbox(spawnTarget, params) {
  const mode = normalizeShellSandboxMode(params.mode, 'off');
  const allowUnsandboxed = params.allowUnsandboxed === true;

  if (!shouldApplyShellSandbox(params)) {
    return {
      ...spawnTarget,
      sandbox: {
        applied: false,
        reason: SANDBOX_UNAVAILABLE_REASON.DISABLED,
        detail:
          params.source !== 'agent'
            ? describeSandboxUnavailable(SANDBOX_UNAVAILABLE_REASON.USER_PTY)
            : describeSandboxUnavailable(SANDBOX_UNAVAILABLE_REASON.DISABLED),
        mode,
      },
    };
  }

  // Git Bash is native Windows; rewriting into WSL+Landlock would discard the profile.
  if (params.runtime === 'git-bash') {
    return {
      ...spawnTarget,
      sandbox: {
        applied: false,
        reason: SANDBOX_UNAVAILABLE_REASON.NATIVE_WIN_SHELL,
        detail: describeSandboxUnavailable(SANDBOX_UNAVAILABLE_REASON.NATIVE_WIN_SHELL),
        mode,
        ...(mode === 'require' ? { blocked: true } : {}),
      },
    };
  }

  const policy = buildWorkspacePolicy({
    workspaceRoot: params.workspaceRoot,
    cwd: params.cwd,
    worktreeRoot: params.worktreeRoot,
    platform: params.platform,
  });

  const wrapped = wrapSandbox(spawnTarget, policy, { platform: params.platform });

  if (wrapped.sandbox.applied) {
    return {
      ...wrapped,
      sandbox: {
        ...wrapped.sandbox,
        mode,
      },
    };
  }

  if (mode === 'require') {
    return {
      command: spawnTarget.command,
      args: Array.isArray(spawnTarget.args) ? [...spawnTarget.args] : [],
      shell: spawnTarget.shell === true,
      ...(spawnTarget.cwd != null ? { cwd: spawnTarget.cwd } : {}),
      ...(spawnTarget.env != null ? { env: spawnTarget.env } : {}),
      sandbox: {
        applied: false,
        kind: wrapped.sandbox.kind,
        reason: wrapped.sandbox.reason,
        detail: wrapped.sandbox.detail,
        mode,
        blocked: true,
      },
    };
  }

  if (mode === 'prefer' && !allowUnsandboxed) {
    return {
      command: spawnTarget.command,
      args: Array.isArray(spawnTarget.args) ? [...spawnTarget.args] : [],
      shell: spawnTarget.shell === true,
      ...(spawnTarget.cwd != null ? { cwd: spawnTarget.cwd } : {}),
      ...(spawnTarget.env != null ? { env: spawnTarget.env } : {}),
      sandbox: {
        applied: false,
        kind: wrapped.sandbox.kind,
        reason: wrapped.sandbox.reason,
        detail: wrapped.sandbox.detail,
        mode,
        needsEscalation: true,
      },
    };
  }

  return {
    command: spawnTarget.command,
    args: Array.isArray(spawnTarget.args) ? [...spawnTarget.args] : [],
    shell: spawnTarget.shell === true,
    ...(spawnTarget.cwd != null ? { cwd: spawnTarget.cwd } : {}),
    ...(spawnTarget.env != null ? { env: spawnTarget.env } : {}),
    sandbox: {
      applied: false,
      kind: wrapped.sandbox.kind,
      reason: wrapped.sandbox.reason,
      detail: wrapped.sandbox.detail,
      mode,
      ...(mode === 'prefer' ? { fallbackUnsandboxed: true } : {}),
    },
  };
}

export {
  buildPolicy,
  buildWorkspacePolicy,
  CREDENTIAL_DENY_ENTRIES,
} from './policy.js';
export {
  SANDBOX_UNAVAILABLE_REASON,
  describeSandboxUnavailable,
} from './unavailable.js';
export { renderSeatbeltProfile, wrapWithSeatbelt, SANDBOX_EXEC_PATH } from './seatbelt.js';
export {
  buildLandlockArgv,
  buildLandlockPathLists,
  buildHomeReadAllowlist,
  landlockDeviceWriteAllowlist,
  probeLandlock,
  resolveMinnowSandboxHelper,
  wrapWithLandlock,
  LANDLOCK_EXIT_ABI_UNAVAILABLE,
  LANDLOCK_EXIT_APPLY_FAILED,
  LANDLOCK_HELPER_MAX_PATHS,
  LANDLOCK_MAX_SCOPED_WRITE_GRANTS,
} from './landlock.js';
export {
  composeWslLandlockWrap,
  createWslLandlockAdapter,
  ensureWslLandlockHelper,
  ensureWslOneShotSpawn,
  extractWslInnerSpawn,
  hostHelperPathToWsl,
  installHelperIntoWsl,
  isWslExeSpawn,
  isWslLandlockWrapped,
  isWslMountPath,
  mapPolicyPathToWsl,
  planWslHelperProvision,
  probeInstalledWslHelper,
  probeWslLandlock,
  probeWslPresent,
  resolveWslLandlockHelper,
  resetWslLandlockProbeCache,
  splitWslArgv,
  wslInstalledHelperPath,
  WSL_HELPER_INSTALL_REL,
  wrapWithWslLandlock,
} from './wsl-landlock.js';
export {
  normalizeShellSandboxMode,
  resolveEffectiveShellSandboxMode,
  clampShellSandboxModeForPlatform,
  modeAttemptsSandbox,
  formatRequireSandboxError,
  formatPreferEscalationError,
  SHELL_SANDBOX_MODES,
} from './mode.js';
export {
  formatSandboxTrailer,
  appendSandboxTrailer,
  parseSandboxTrailer,
} from './signals.js';
