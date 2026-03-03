import * as vscode from 'vscode';
import { RepositoryManager } from '../repositoryManager';
import { InstallationManager } from '../installationManager';
import { FileScanner } from '../fileScanner';
import { AgentFile, FileCategory, Repository } from '../types';
import { RepositoryItem, CategoryItem, FileItem, categoryLabel } from './treeItems';

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

  /** Current filter string for repo names/URLs. */
  private repoFilter: string = '';

  constructor(
    private readonly repoManager: RepositoryManager,
    private readonly fileScanner: FileScanner,
    private readonly installManager: InstallationManager
  ) {
    // Refresh whenever the repo list changes (add/remove/sync status update)
    repoManager.onDidChange(() => this.refresh());
  }

  /** Set the repository filter and refresh the view. */
  setRepoFilter(filter: string) {
    const trimmed = filter.trim().toLowerCase();
    console.log('[AgentManagerTreeProvider] setRepoFilter', trimmed);
    this.repoFilter = trimmed;
    this.refresh();
  }

  /** Return the current filter string (lowercase). */
  getRepoFilter(): string {
    return this.repoFilter;
  }

  // ── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(element: AnyItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AnyItem): Promise<AnyItem[]> {
    if (!element) {
      // Root level — return all registered repositories, filtered if needed
      let repos = this.repoManager.getAll();
      if (this.repoFilter) {
        const filtered: typeof repos = [];
        for (const r of repos) {
          if (await this.repoMatchesFilter(r)) {
            filtered.push(r);
          }
        }
        repos = filtered;
        console.log('[AgentManagerTreeProvider] filter applied,', repos.length, 'repos match');
      }
      return repos.map((repo) => new RepositoryItem(repo));
    }

    if (element instanceof RepositoryItem) {
      // when a filter is active we may need to trim categories/files
      if (!this.repoFilter) {
        return this.getCategoriesForRepo(element.repo.id);
      }
      return this.getFilteredChildrenForRepo(element.repo.id);
    }

    if (element instanceof CategoryItem) {
      return element.files.map((f) => {
        const alias = this.installManager.getLabelFor(f.id);
        return new FileItem(f, alias);
      });
    }

    return [];
  }

  // simple fuzzy matcher: all pattern chars occur in order within text
  private fuzzyMatch(pattern: string, text: string): boolean {
    pattern = pattern.toLowerCase();
    text = text.toLowerCase();
    let i = 0;
    for (let j = 0; j < text.length && i < pattern.length; j++) {
      if (pattern[i] === text[j]) {
        i++;
      }
    }
    return i === pattern.length;
  }

  // match the filter against anything inside a repo (name, url, category labels, or file names)
  private async repoMatchesFilter(repo: Repository): Promise<boolean> {
    if (
      this.fuzzyMatch(this.repoFilter, repo.name) ||
      this.fuzzyMatch(this.repoFilter, repo.url)
    ) {
      return true;
    }

    const cats = await this.getCategoriesForRepo(repo.id);
    // check category label
    for (const cat of cats) {
      const label = categoryLabel(cat.category);
      if (this.fuzzyMatch(this.repoFilter, label)) {
        return true;
      }
      // check individual files
      for (const f of cat.files) {
        if (
          this.fuzzyMatch(this.repoFilter, f.displayName) ||
          this.fuzzyMatch(this.repoFilter, f.name)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Return the list of categories for a repo, but only include those (and
   * files within them) that match the current filter. Used when a repo node is
   * expanded while a filter string is active.
   */
  private async getFilteredChildrenForRepo(
    repoId: string
  ): Promise<CategoryItem[]> {
    const allCats = await this.getCategoriesForRepo(repoId);
    const result: CategoryItem[] = [];
    for (const cat of allCats) {
      const label = categoryLabel(cat.category);
      if (this.fuzzyMatch(this.repoFilter, label)) {
        result.push(cat);
        continue;
      }
      const matchingFiles = cat.files.filter((f) =>
        this.fuzzyMatch(this.repoFilter, f.displayName) ||
        this.fuzzyMatch(this.repoFilter, f.name)
      );
      if (matchingFiles.length > 0) {
        result.push(new CategoryItem(cat.category, cat.repoId, matchingFiles));
      }
    }
    return result;
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
