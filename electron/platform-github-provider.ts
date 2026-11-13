import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import type { AppUpdater } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';
import type { CancellationToken, CustomPublishOptions } from 'builder-util-runtime';
import type { OutgoingHttpHeaders } from 'node:http';

/** Keep GitHub's channel/notes/download behavior, but tolerate platform-only betas. */
export class PlatformGitHubProvider extends GitHubProvider {
  private readonly appUpdater: AppUpdater;
  private excludedTags = new Set<string>();
  private atom: string | null = null;

  constructor(options: CustomPublishOptions, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    super({ provider: 'github', owner: options.owner, repo: options.repo }, updater, runtime);
    this.appUpdater = updater;
  }

  protected override async httpRequest(url: URL, headers?: OutgoingHttpHeaders | null, token?: CancellationToken): Promise<string | null> {
    if (!url.pathname.endsWith('/releases.atom')) return super.httpRequest(url, headers, token);
    this.atom ??= await super.httpRequest(url, headers, token);
    return this.atom?.replace(/<entry\b[^>]*>[\s\S]*?<\/entry>/g, entry => {
      const tag = /<link\b[^>]*\bhref="[^"<>]*\/tag\/([^"<>]+)"/.exec(entry)?.[1];
      return tag && this.excludedTags.has(tag) ? '' : entry;
    }) ?? null;
  }

  override async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    this.excludedTags.clear();
    this.atom = null;
    for (let attempt = 0; ; attempt++) {
      try { return await super.getLatestVersion(); }
      catch (error) {
        const failure = error as { code?: string; message?: string };
        // Only missing manifests qualify. Never hide network, malformed feed,
        // checksum or signature failures, and never change stable selection.
        const tag = failure.message?.match(/\/releases\/download\/([^/]+)\//)?.[1];
        if (!this.appUpdater.allowPrerelease || failure.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
          || !tag || this.excludedTags.has(tag) || attempt >= 9) throw error;
        this.excludedTags.add(tag);
      }
    }
  }
}
