export interface GitHubLoginFlow {
  state: 'pending' | 'complete' | 'failed' | 'cancelled';
  code: string;
  error: string;
  verificationUrl: string;
}

export interface GitHubAccount {
  ok: boolean;
  installed?: boolean;
  authenticated?: boolean;
  login?: string;
  managed?: boolean;
  error?: string;
  flow: GitHubLoginFlow | null;
}

export async function githubAuthRequest(action: 'Status' | 'Start' | 'Poll' | 'Cancel'): Promise<GitHubAccount> {
  const response = await fetch('/api/git', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: `githubAuth${action}` }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error('Could not reach Minnow’s server. Check again.');
  const result = await response.json() as GitHubAccount;
  if (!result.ok) throw new Error(result.error || 'Could not complete GitHub sign-in.');
  return result;
}
