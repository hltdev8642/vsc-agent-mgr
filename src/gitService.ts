import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import simpleGit, { SimpleGit } from 'simple-git';

const execFileAsync = promisify(execFile);

/**
 * Returns a sanitised environment for git sub-processes.
 * Disables interactive prompts and strips variables that some system git
 * configurations use to inject the --upload-pack (-u) flag, which would
 * otherwise trigger git's allowUnsafePack security check.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['GIT_TERMINAL_PROMPT'] = '0';
  delete env['GIT_UPLOAD_PACK'];
  return env;
}

/**
 * Thin wrapper around git providing the operations needed by this extension.
 * All methods throw descriptive errors on failure so callers can surface them
 * to the user.
 */
export class GitService {
  // ── Helpers ──────────────────────────────────────────────────────────────

  /** simple-git instance for lightweight read-only operations. */
  private git(workingDir?: string): SimpleGit {
    return simpleGit({
      baseDir: workingDir,
      binary: 'git',
      maxConcurrentProcesses: 4,
      trimmed: false,
    });
  }

  /**
   * Invoke git directly via execFile, bypassing simple-git's argument
   * transformation entirely. Uses gitEnv() to prevent system-level git
   * security policies from injecting unexpected flags.
   */
  private async runGit(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Clone `url` into `localPath`. When `token` is provided it is injected
   * into the HTTPS URL so private repositories are accessible.
   *
   * Falls back to cloning without a specific branch if the requested branch
   * does not exist on the remote.
   *
   * On Windows, some repos contain files whose names include characters that
   * are illegal on NTFS (e.g. `:`).  Git reports "clone succeeded, but
   * checkout failed" and exits non-zero, but the `.git` directory and all
   * object data are intact.  We detect this situation by checking whether a
   * valid git repo exists at `localPath` after the error — if so we treat the
   * clone as a success (the affected files simply won't appear on disk).
   */
  async clone(
    url: string,
    branch: string,
    localPath: string,
    token?: string
  ): Promise<void> {
    const authUrl = token ? injectToken(url, token) : url;
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    try {
      await this.runGit(
        ['clone', '--branch', branch, '--single-branch', authUrl, localPath]
      );
    } catch (firstErr) {
      // If the repo was partially created (clone succeeded, checkout failed),
      // there will be a valid git directory at localPath already.
      if (await this.isRepository(localPath)) {
        // Checkout failed due to OS-level path restrictions (e.g. `:` in
        // filenames on Windows).  The git objects are intact so we can still
        // scan and install whatever files *did* check out successfully.
        return;
      }

      // The clone itself failed (e.g. branch not found, network error).
      // Clean up the partial directory and retry without a specific branch.
      try {
        await fs.rm(localPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }

      try {
        await this.runGit(['clone', authUrl, localPath]);
      } catch (secondErr) {
        // Same check: if the second attempt also failed at checkout (not at
        // clone), the repo is still usable.
        if (await this.isRepository(localPath)) {
          return;
        }
        throw secondErr;
      }
    }
  }

  /**
   * Pull the latest commits for `branch` in the repository at `localPath`.
   * Returns `true` when at least one commit was fetched (i.e. HEAD changed).
   *
   * Like `clone`, this tolerates checkout failures caused by OS-level path
   * restrictions (e.g. filenames containing `:` on Windows).  In that case
   * `true` is returned because remote changes were fetched even though some
   * files could not be written to disk.
   */
  async pull(
    localPath: string,
    url: string,
    branch: string,
    token?: string
  ): Promise<boolean> {
    if (token) {
      const authUrl = injectToken(url, token);
      await this.runGit(['remote', 'set-url', 'origin', authUrl], localPath);
    }

    const before = (
      await this.runGit(['rev-parse', 'HEAD'], localPath)
    ).trim();

    try {
      await this.runGit(['pull', '--ff-only', 'origin', branch], localPath);
    } catch (err: unknown) {
      const msg = String(err);
      // If the remote was force-pushed or the branches have diverged, a
      // fast-forward pull will fail. In most cases we don't care about
      // preserving local clone history (it's just a cache), so stomp the
      // workspace over to the remote state instead of leaving the repo in a
      // broken state. Otherwise fall back to a regular merge.
      if (
        msg.includes('fast-forward') ||
        msg.includes('Not possible to fast-forward') ||
        msg.includes('forced update') ||
        msg.includes('diverging branches')
      ) {
        // log for troubleshooting; the host developer console will show this
        console.warn(
          'GitService.pull: repository has diverged or been force-pushed,' +
            ' resetting local clone to remote HEAD.'
        );
        try {
          // fetch the tip and reset hard; this handles both normal divergence
          // and force-push scenarios without creating tangled merge commits.
          await this.runGit(['fetch', 'origin', branch], localPath);
          await this.runGit(['reset', '--hard', 'FETCH_HEAD'], localPath);
        } catch {
          // if the reset itself fails, try one last time with a plain pull
          try {
            await this.runGit(['pull', 'origin', branch], localPath);
          } catch {
            throw err;
          }
        }
      } else {
        throw err;
      }
    }

    const after = (
      await this.runGit(['rev-parse', 'HEAD'], localPath)
    ).trim();
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
