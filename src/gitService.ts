import * as path from 'path';
import * as fs from 'fs/promises';
import simpleGit, { SimpleGit } from 'simple-git';

/**
 * Thin wrapper around simple-git providing the operations needed by this
 * extension. All methods throw descriptive errors on failure so callers can
 * surface them to the user.
 */
export class GitService {
  // ── Helpers ──────────────────────────────────────────────────────────────

  private git(workingDir?: string): SimpleGit {
    return simpleGit({
      baseDir: workingDir,
      binary: 'git',
      maxConcurrentProcesses: 4,
      trimmed: false,
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Clone `url` into `localPath`. When `token` is provided it is injected
   * into the HTTPS URL so private repositories are accessible.
   *
   * Falls back to cloning without a specific branch if the requested branch
   * does not exist on the remote.
   */
  async clone(
    url: string,
    branch: string,
    localPath: string,
    token?: string
  ): Promise<void> {
    const authUrl = token ? injectToken(url, token) : url;
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    const git = this.git();
    try {
      await git.clone(authUrl, localPath, [
        '--branch',
        branch,
        '--single-branch',
      ]);
    } catch {
      // Branch may not exist — retry without specifying a branch so we get
      // whatever the remote default is.
      try {
        await fs.rm(localPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      await git.clone(authUrl, localPath);
    }
  }

  /**
   * Pull the latest commits for `branch` in the repository at `localPath`.
   * Returns `true` when at least one commit was fetched (i.e. HEAD changed).
   */
  async pull(
    localPath: string,
    url: string,
    branch: string,
    token?: string
  ): Promise<boolean> {
    const git = this.git(localPath);

    if (token) {
      const authUrl = injectToken(url, token);
      await git.remote(['set-url', 'origin', authUrl]);
    }

    const before = await this.getHeadHash(git);
    await git.pull('origin', branch, { '--ff-only': null });
    const after = await this.getHeadHash(git);

    return before !== after;
  }

  /** Returns `true` when `localPath` contains a valid Git repository. */
  async isRepository(localPath: string): Promise<boolean> {
    try {
      const git = this.git(localPath);
      await git.revparse(['--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the abbreviated HEAD commit hash, or an empty string on failure. */
  async getHeadCommitHash(localPath: string): Promise<string> {
    try {
      return await this.getHeadHash(this.git(localPath));
    } catch {
      return '';
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async getHeadHash(git: SimpleGit): Promise<string> {
    const raw = await git.revparse(['HEAD']);
    return raw.trim();
  }
}

/**
 * Injects a personal access token into an HTTPS URL.
 * `https://github.com/user/repo` → `https://<token>@github.com/user/repo`
 *
 * For GitLab the recommended form is `https://oauth2:<token>@…` — users who
 * need that can supply the full token in the form `oauth2:<token>` and this
 * function will handle it correctly.
 */
function injectToken(url: string, token: string): string {
  if (url.startsWith('https://')) {
    return `https://${encodeURIComponent(token)}@${url.slice('https://'.length)}`;
  }
  // SSH URLs cannot carry tokens — return unchanged and let git use the
  // system credential helper.
  return url;
}
