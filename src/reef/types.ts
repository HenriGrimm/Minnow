export type ReefRunState = 'queued' | 'scaffolding' | 'planning' | 'building' | 'installing' | 'checking' | 'repairing' | 'promoting' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
export interface ReefRun {
  id: string; prompt: string; state: ReefRunState; progress: number; createdAt: number;
  completedAt?: number; error?: string; log: string; attempt: number; chatIds: string[];
  failedStage?: ReefRunState;
  recovery?: 'resume' | 'reset-phase'; queuedAt?: number;
  startedAt?: number; lastActivityAt?: number; agentLog?: string;
  agentSessions?: ReefAgentSession[];
}
export interface ReefAgentTool {
  id: string; name: string; args: Record<string, unknown>; result?: string; isError?: boolean;
}
export interface ReefAgentRound {
  id: string; text: string; reasoning: string; tools: ReefAgentTool[]; complete?: boolean; notice?: string;
}
export interface ReefAgentSession {
  chatId: string; phase: 'plan' | 'build'; state: 'running' | 'complete' | 'failed';
  rounds: ReefAgentRound[]; error?: string; truncated?: boolean;
  activity?: 'thinking' | 'generating' | 'tools' | 'loading'; currentTool?: string;
}
export interface ReefExport {
  id: string; method: 'source' | 'local' | 'docker' | 'github'; target: 'win32' | 'darwin' | 'linux';
  status: 'queued' | 'building' | 'ready' | 'failed' | 'interrupted';
  releaseId: string; filename?: string; error?: string; log?: string; url?: string;
  arch?: 'x64' | 'arm64';
}
export interface ReefApp {
  version: 1; templateVersion: number; id: string; name: string; description: string;
  providerId?: string; modelId: string; createdAt: number; updatedAt: number; status: ReefRunState;
  release: { id: string; commit: string; createdAt: number } | null;
  runs: ReefRun[]; exports: ReefExport[]; chatIds: string[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  githubRepo?: string;
}
