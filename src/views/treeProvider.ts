import * as vscode from 'vscode';
import { RepositoryManager } from '../repositoryManager';
import { InstallationManager } from '../installationManager';
import { FileScanner } from '../fileScanner';
import { AgentFile, FileCategory } from '../types';
import { RepositoryItem, CategoryItem, FileItem } from './treeItems';

type RootItem = RepositoryItem;
type ChildItem = CategoryItem | FileItem;
type AnyItem = RootItem | ChildItem;

const FILE_CATEGORIES: FileCategory[] = [
  'agent',
  'chatmode',
  'instruction',
  'prompt',
];

/**
 * Provides data for the "AI Agent Manager" sidebar tree view.
 *
 * Tree structure:
 * ```
 * RepositoryItem          (repo)
 *   CategoryItem          (agent | chatmode | instruction | prompt)
 *     FileItem            (individual .md file)
 * ```
 *
 * File statuses are computed lazily when a category node is expanded,
 * and results are cached until `refresh()` is called.
 */
export class AgentManagerTreeProvider
  implements vscode.TreeDataProvider<AnyItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<AnyItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache of scanned + status-enriched files per repo. Cleared on refresh. */
  private fileCache = new Map<string, AgentFile[]>();

  constructor(
    private readonly repoManager: RepositoryManager,
    private readonly fileScanner: FileScanner,
    private readonly installManager: InstallationManager
  ) {
    // Refresh whenever the repo list changes (add/remove/sync status update)
    repoManager.onDidChange(() => this.refresh());
  }

  // ── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(element: AnyItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AnyItem): Promise<AnyItem[]> {
    if (!element) {
      // Root level — return all registered repositories
      return this.repoManager
        .getAll()
        .map((repo) => new RepositoryItem(repo));
    }

    if (element instanceof RepositoryItem) {
      return this.getCategoriesForRepo(element.repo.id);
    }

    if (element instanceof CategoryItem) {
      return element.files.map((f) => new FileItem(f));
    }

    return [];
  }

  // ── Public ────────────────────────────────────────────────────────────────

  refresh(): void {
    this.fileCache.clear();
    this._onDidChangeTreeData.fire();
  }

  /** Invalidate the cache for a single repository (e.g. after a sync). */
  refreshRepo(repoId: string): void {
    this.fileCache.delete(repoId);
    this._onDidChangeTreeData.fire();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async getCategoriesForRepo(
    repoId: string
  ): Promise<CategoryItem[]> {
    const files = await this.getEnrichedFiles(repoId);

    const byCategory = new Map<FileCategory, AgentFile[]>();
    for (const cat of FILE_CATEGORIES) {
      byCategory.set(cat, []);
    }
    for (const file of files) {
      byCategory.get(file.category)!.push(file);
    }

    const result: CategoryItem[] = [];
    for (const cat of FILE_CATEGORIES) {
      const catFiles = byCategory.get(cat)!;
      if (catFiles.length > 0) {
        result.push(new CategoryItem(cat, repoId, catFiles));
      }
    }

    // If no typed category matched, still show a catch-all for prompt files
    const promptFiles = byCategory.get('prompt')!;
    if (
      promptFiles.length === 0 &&
      files.length > 0 &&
      result.length === 0
    ) {
      result.push(new CategoryItem('prompt', repoId, files));
    }

    return result;
  }

  /**
   * Returns cached (or freshly scanned + enriched) files for a repo.
   * Falls back to an empty array when the local clone does not exist yet.
   */
  private async getEnrichedFiles(repoId: string): Promise<AgentFile[]> {
    const cached = this.fileCache.get(repoId);
    if (cached) {
      return cached;
    }

    const localPath = this.repoManager.getLocalPath(repoId);
    let files: AgentFile[];

    try {
      files = await this.fileScanner.scanRepository(repoId, localPath);
    } catch (err) {
      // Local clone doesn't exist yet or is unreadable — return empty list.
      // This is expected right after addRepository before the first sync.
      console.error(`[AgentMgr] Failed to scan ${localPath}:`, err);
      files = [];
    }

    // Enrich each file with its real installation status
    const enriched = await Promise.all(
      files.map(async (f) => {
        f.status = await this.installManager.computeStatus(f);
        return f;
      })
    );

    this.fileCache.set(repoId, enriched);
    return enriched;
  }
}
