import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Repository, SyncState } from './types';
import { GitService } from './gitService';

const STATE_KEY = 'agentMgr.repositories';

/**
 * Manages the persisted list of registered repositories and their local clones.
 *
 * Repositories are stored in `ExtensionContext.globalState` so they survive
 * across VS Code sessions. Local clones live under
 * `{globalStorageUri}/repos/{repoId}/`.
 */
export class RepositoryManager {
  private repos: Map<string, Repository>;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the repository list or a repository's metadata changes. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gitService: GitService
  ) {
    const stored = context.globalState.get<Repository[]>(STATE_KEY, []);
    // Ensure every loaded repo has a valid syncStatus
    this.repos = new Map(
      stored.map((r) => [r.id, { ...r, syncStatus: r.syncStatus ?? 'never' }])
    );
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getAll(): Repository[] {
    return Array.from(this.repos.values());
  }

  getById(id: string): Repository | undefined {
    return this.repos.get(id);
  }

  /** Absolute path to the local clone for a given repository. */
  getLocalPath(repoId: string): string {
    return path.join(
      this.context.globalStorageUri.fsPath,
      'repos',
      repoId
    );
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Register a new repository, clone it locally, and persist the record.
   * Throws if the URL is already registered or the clone fails.
   */
  async add(url: string, branch = 'main', token?: string): Promise<Repository> {
    const normalised = normaliseUrl(url);
    for (const repo of this.repos.values()) {
      if (normaliseUrl(repo.url) === normalised) {
        throw new Error(`Repository is already added: ${url}`);
      }
    }

    const id = generateId();
    const name = deriveRepoName(url);
    const repo: Repository = {
      id,
      url,
      name,
      branch,
      addedAt: new Date().toISOString(),
      syncStatus: 'never',
    };

    // Store auth token before cloning so it's available for retry on failure
    if (token) {
      await this.context.secrets.store(secretKey(id), token);
    }

    const localPath = this.getLocalPath(id);
    await this.gitService.clone(url, branch, localPath, token);

    repo.lastSynced = new Date().toISOString();
    repo.syncStatus = 'idle';

    this.repos.set(id, repo);
    await this.persist();
    this._onDidChange.fire();
    return repo;
  }

  /**
   * Unregister a repository, delete its local clone, and remove stored secrets.
   */
  async remove(id: string): Promise<void> {
    if (!this.repos.has(id)) {
      return;
    }

    const localPath = this.getLocalPath(id);
    try {
      await fs.rm(localPath, { recursive: true, force: true });
    } catch {
      // Non-fatal — the directory may already be gone
    }

    await this.context.secrets.delete(secretKey(id));

    this.repos.delete(id);
    await this.persist();
    this._onDidChange.fire();
  }

  /** Store or update a PAT for a repository (held in SecretStorage). */
  async setAuthToken(id: string, token: string): Promise<void> {
    await this.context.secrets.store(secretKey(id), token);
  }

  /** Retrieve the stored PAT for a repository, if any. */
  async getAuthToken(id: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }

  /** Update the sync lifecycle state for a repository and persist. */
  async updateSyncStatus(
    id: string,
    status: SyncState,
    error?: string
  ): Promise<void> {
    const repo = this.repos.get(id);
    if (!repo) {
      return;
    }
    repo.syncStatus = status;
    repo.syncError = status === 'error' ? error : undefined;
    if (status === 'idle') {
      repo.lastSynced = new Date().toISOString();
    }
    await this.persist();
    this._onDidChange.fire();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    await this.context.globalState.update(
      STATE_KEY,
      Array.from(this.repos.values())
    );
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normaliseUrl(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
}

function deriveRepoName(url: string): string {
  const withoutGit = url.replace(/\.git$/, '');
  const segments = withoutGit.split(/[/\\]/);
  const name = segments[segments.length - 1] || url;
  return decodeURIComponent(name);
}

function secretKey(repoId: string): string {
  return `agentMgr.repo.${repoId}.token`;
}
