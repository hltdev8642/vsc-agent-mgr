import * as vscode from 'vscode';
import { RepositoryManager } from './repositoryManager';
import { InstallationManager } from './installationManager';
import { FileScanner } from './fileScanner';
import { GitService } from './gitService';
import { AgentFile, SyncResult } from './types';

/**
 * Orchestrates pull → scan → status-reconcile for one or all repositories.
 *
 * After each sync cycle the `onRefresh` callback is invoked so the tree view
 * can repaint with updated statuses.
 */
export class SyncManager {
  /** Tracks repos currently being synced to prevent double-runs. */
  private syncing = new Set<string>();

  constructor(
    private readonly repoManager: RepositoryManager,
    private readonly installManager: InstallationManager,
    private readonly fileScanner: FileScanner,
    private readonly gitService: GitService,
    private readonly onRefresh: () => void
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Sync every registered repository sequentially.
   * Returns an array of per-repo results.
   */
  async syncAll(): Promise<SyncResult[]> {
    const repos = this.repoManager.getAll();
    if (repos.length === 0) {
      return [];
    }

    const results: SyncResult[] = [];
    for (const repo of repos) {
      const result = await this.syncOne(repo.id);
      results.push(result);
    }

    this.onRefresh();
    return results;
  }

  /**
   * Pull the latest commits for a single repo, then re-derive the status of
   * every installed file inside it.
   */
  async syncOne(repoId: string): Promise<SyncResult> {
    const repo = this.repoManager.getById(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }

    const result: SyncResult = {
      repoId,
      repoName: repo.name,
      filesChecked: 0,
      filesUpdated: 0,
      newFiles: 0,
      conflicts: [],
      errors: [],
    };

    if (this.syncing.has(repoId)) {
      return result; // already in progress — skip silently
    }
    this.syncing.add(repoId);

    await this.repoManager.updateSyncStatus(repoId, 'syncing');
    this.onRefresh();

    try {
      const localPath = this.repoManager.getLocalPath(repoId);

      // Ensure the local clone is still valid; re-clone if needed
      const isValid = await this.gitService.isRepository(localPath);
      if (!isValid) {
        const token = await this.repoManager.getAuthToken(repoId);
        await this.gitService.clone(repo.url, repo.branch, localPath, token);
      } else {
        const token = await this.repoManager.getAuthToken(repoId);
        await this.gitService.pull(localPath, repo.url, repo.branch, token);
      }

      // Re-scan the repo to pick up new or removed files
      const files: AgentFile[] = await this.fileScanner.scanRepository(
        repoId,
        localPath
      );
      result.filesChecked = files.length;

      // Determine the status of each file and tally the summary
      for (const file of files) {
        const status = await this.installManager.computeStatus(file);
        const wasInstalled = this.installManager.isInstalled(file.id);

        if (!wasInstalled) {
          result.newFiles++;
        } else if (status === 'outdated') {
          result.filesUpdated++;

          // Auto-update if the user requested "always use remote" strategy
          const strategy = vscode.workspace
            .getConfiguration('agentMgr')
            .get<string>('conflictResolution', 'ask');
          if (strategy === 'useRemote') {
            try {
              await this.installManager.update(file, localPath);
            } catch (err: unknown) {
              result.errors.push(
                `Failed to auto-update ${file.name}: ${toMessage(err)}`
              );
            }
          }
        } else if (status === 'conflicted') {
          result.conflicts.push(file.name);
        }
      }

      await this.repoManager.updateSyncStatus(repoId, 'idle');
    } catch (err: unknown) {
      const msg = toMessage(err);
      result.errors.push(msg);
      // special-case 404-like errors to give a clearer message
      if (msg.includes('Repository not found') || msg.match(/not found/i)) {
        vscode.window.showErrorMessage(
          `Sync failed for "${repo.name}": remote repository could not be found. Please verify the URL or your access permissions.`
        );
      }
      await this.repoManager.updateSyncStatus(repoId, 'error', msg);
    } finally {
      this.syncing.delete(repoId);
    }

    return result;
  }

  /** Whether a specific repository is currently being synced. */
  isSyncing(repoId: string): boolean {
    return this.syncing.has(repoId);
  }
}

function toMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
