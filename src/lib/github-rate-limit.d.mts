export function isGithubRateLimitError(message: string | undefined): boolean;
export function githubRetryAt(message: string | undefined, now?: number): number;
