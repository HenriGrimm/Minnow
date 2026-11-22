/**
 * Packaged Electron must not POST workspace claims at the leftover Vite/dev
 * origin. That fetch is what turned a missing asar module into "fetch failed".
 */
export function workspaceClaimHttpBase(options: {
  isDev: boolean;
  backendUrl: string | null | undefined;
  devUrl: string;
}): string | null {
  const backend = options.backendUrl?.trim();
  if (backend) return backend.replace(/\/$/, '');
  if (options.isDev) return options.devUrl.replace(/\/$/, '');
  return null;
}
