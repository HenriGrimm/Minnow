/** Production effects for the PR Reviewer automation (gh + git + reviewer runs). */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runGh } from '../git/gh-cli.js';
import { runProcess } from '../process-runner.js';
import { githubRepositoryFromRemote } from './github-watch-runtime.js';
import { pollPrReview } from './pr-review.js';
import { setLiveRunHeadline } from './live-runs.js';
import { recordActivity } from './activity.js';

/**
 * @param {{ job: any; runId: string; runReviewer: (input: { role: string; roleLabel: string; prompt: string; workspacePath: string }) => Promise<any>; isCancelled?: () => boolean; gh?: typeof runGh; processRun?: typeof runProcess }} input
 */
export async function runPrReview({ job, runId, runReviewer, isCancelled, gh = runGh, processRun = runProcess }) {
  const config = job.preset.config;
  const repository = config.repository;
  const cwd = job.workspacePath;
  const checked = async (result) => {
    const value = await result;
    if (value.code !== 0 || value.timedOut || value.accumulationTruncated) {
      throw new Error((value.stderr || 'Command failed or returned incomplete output').trim());
    }
    return value.stdout.trim();
  };
  const git = (args, options = {}) => checked(processRun('git', args, { cwd, timeout: 180_000, ...options }));
  const github = (args) => checked(gh(args, { cwd, timeout: 60_000, env: { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } }));
  const json = async (args) => JSON.parse(await github(args));
  const withBodyFile = async (body, work) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pr-review-'));
    const file = path.join(folder, 'body.md');
    try { await fs.writeFile(file, body); return await work(file); }
    finally { await fs.rm(folder, { recursive: true, force: true }); }
  };

  // The checkout must belong to the reviewed repository before anything touches GitHub.
  for (const args of [['remote', 'get-url', 'origin'], ['remote', 'get-url', '--push', 'origin']]) {
    if (githubRepositoryFromRemote(await git(args)) !== repository) {
      throw new Error('The checkout origin fetch and push URLs must match the reviewed GitHub repository.');
    }
  }

  return pollPrReview(job, runId, {
    isCancelled,
    headline: (patch) => setLiveRunHeadline(runId, patch),
    activity: ({ text, tone, ref }) => recordActivity({ jobId: job.id, label: job.label, runId, text, tone, ref }),
    listPulls: async () => {
      const rows = await json(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100',
        '--json', 'number,title,url,author,isDraft,headRefOid,createdAt,baseRefName,headRefName']);
      return rows.map((row) => ({
        number: row.number, title: row.title, url: row.url, author: row.author?.login ?? '', isDraft: Boolean(row.isDraft),
        headSha: row.headRefOid, createdAt: row.createdAt, baseRefName: row.baseRefName, headRefName: row.headRefName,
      }));
    },
    listComments: async (number) => {
      const pages = await json(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`]);
      return pages.flat().map((c) => ({ id: c.id, body: c.body ?? '', author: c.user?.login ?? '', createdAt: c.created_at }));
    },
    comment: (number, body) => withBodyFile(body, async (file) => {
      const created = await json(['api', '-X', 'POST', `repos/${repository}/issues/${number}/comments`, '-F', `body=@${file}`]);
      return created.id;
    }),
    deleteComment: (id) => github(['api', '-X', 'DELETE', `repos/${repository}/issues/comments/${id}`]),
    prepareWorktree: async (pull) => {
      const ref = `refs/minnow/pr-review/${pull.number}`;
      await git(['fetch', 'origin', `+pull/${pull.number}/head:${ref}`, `+refs/heads/${pull.baseRefName}:refs/minnow/pr-review/base-${pull.number}`]);
      const head = await git(['rev-parse', '--verify', ref]);
      if (head !== pull.headSha) throw new Error(`PR #${pull.number} moved while preparing the review. It will be picked up again.`);
      const workspacePath = path.join(cwd, '.worktrees', `pr-review-${pull.number}`);
      try {
        await fs.access(path.join(workspacePath, '.git'));
        await git(['-C', workspacePath, 'checkout', '--detach', '--force', head]);
      } catch {
        await git(['worktree', 'add', '--detach', '--force', workspacePath, head]);
      }
      return { workspacePath, baseRef: `refs/minnow/pr-review/base-${pull.number}` };
    },
    cleanupWorktree: async (workspacePath) => {
      await git(['worktree', 'remove', '--force', workspacePath]).catch(() => {});
    },
    runReviewer,
    merge: async (number, { auto }) => {
      await github(['pr', 'merge', String(number), '--repo', repository, '--squash', ...(auto ? ['--auto'] : [])]);
    },
    review: (number, event, body) => withBodyFile(body, (file) =>
      github(['pr', 'review', String(number), '--repo', repository, event === 'approve' ? '--approve' : '--request-changes', '--body-file', file])),
  });
}

/**
 * The repository a checkout points at, for setup forms.
 * @param {string} workspacePath
 */
export async function detectGithubRepository(workspacePath, { processRun = runProcess, gh = runGh } = {}) {
  const result = { repository: null, pushMatches: false, ghReady: false, error: null };
  if (!String(workspacePath ?? '').trim()) return { ...result, error: 'Choose a local checkout.' };
  const fetchUrl = await processRun('git', ['remote', 'get-url', 'origin'], { cwd: workspacePath, timeout: 15_000 });
  if (fetchUrl.code !== 0) return { ...result, error: 'This folder has no git origin.' };
  result.repository = githubRepositoryFromRemote(fetchUrl.stdout);
  if (!result.repository) return { ...result, error: 'The origin is not a GitHub.com repository.' };
  const pushUrl = await processRun('git', ['remote', 'get-url', '--push', 'origin'], { cwd: workspacePath, timeout: 15_000 });
  result.pushMatches = pushUrl.code === 0 && githubRepositoryFromRemote(pushUrl.stdout) === result.repository;
  const auth = await gh(['auth', 'status', '--hostname', 'github.com'], { cwd: workspacePath, timeout: 15_000, env: { GH_PROMPT_DISABLED: '1' } }).catch(() => ({ code: 1 }));
  result.ghReady = auth.code === 0;
  if (!result.ghReady) result.error = 'Sign in to the GitHub CLI with gh auth login.';
  return result;
}
