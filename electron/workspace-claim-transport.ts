/**
 * Packaged Electron must not POST workspace claims at the leftover Vite/dev
 * origin. That fetch is what turned a missing asar module into "fetch failed".
 */
export function workspaceClaimHttpBase(options: {
  isDev: boolean;
  inProcessUrl: string | null | undefined;
  devUrl: string;
}): string | null {
  const inProcess = options.inProcessUrl?.trim();
  if (inProcess) return inProcess.replace(/\/$/, '');
  if (options.isDev) return options.devUrl.replace(/\/$/, '');
  return null;
}
