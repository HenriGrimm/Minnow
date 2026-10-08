export interface ActionInput {
  name: string;
  description: string;
  type: string;
  required: boolean;
  default?: string | number | boolean;
  options: string[];
}
export interface ActionWorkflow {
  id: string | number;
  path: string;
  name: string;
  state?: string;
  error?: string;
  dispatchable?: boolean;
  inputs?: ActionInput[];
  events?: string[];
  jobs?: { id: string; label: string; runner: unknown; supported: boolean }[];
}
export interface ActionCommand {
  id: string;
  label: string;
  command: string;
  cwd: string;
  shellProfile?: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  script?: string;
}
export interface LocalActionRun {
  id: string;
  kind: 'workflow' | 'command';
  label: string;
  cwd: string;
  branch: string;
  sha: string;
  dirty: boolean;
  status: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  cleanupError?: string;
  truncated?: boolean;
}
export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  downloads: number;
  url: string;
}
export interface Release {
  id: number;
  tag: string;
  title: string;
  body: string;
  target: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  url: string;
  createdAt: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
}
export interface ActionResult {
  ok: boolean;
  error?: string;
  note?: string;
  accepted?: boolean;
  hasMore?: boolean;
  repo?: string;
  workflows?: ActionWorkflow[];
  workflow?: ActionWorkflow;
  commands?: ActionCommand[];
  runs?: LocalActionRun[];
  run?: LocalActionRun;
  log?: string;
  nextOffset?: number;
  releases?: Release[];
  release?: Release;
  canWrite?: boolean;
  title?: string;
  body?: string;
  names?: string[];
  options?: { name: string; sha?: string }[];
  act?: { available: boolean; detail: string };
  docker?: { available: boolean; detail: string };
}
export type ActionOperation =
  | 'workflowList'
  | 'workflowView'
  | 'workflowDispatch'
  | 'actionRemoteOptions'
  | 'commandList'
  | 'commandSave'
  | 'actionSecrets'
  | 'localCapabilities'
  | 'localRunStart'
  | 'localRunList'
  | 'localRunView'
  | 'localRunCancel'
  | 'localRunRerun'
  | 'releaseList'
  | 'releaseView'
  | 'releaseCreate'
  | 'releaseEdit'
  | 'releaseDelete'
  | 'releaseNotes'
  | 'releaseAssetUpload'
  | 'releaseAssetDownload'
  | 'releaseAssetDelete';
export async function actionApi(
  op: ActionOperation,
  args: Record<string, unknown> = {},
): Promise<ActionResult> {
  try {
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, op }),
    });
    const data = (await response.json()) as ActionResult;
    return response.ok ? data : { ok: false, error: data.error || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
