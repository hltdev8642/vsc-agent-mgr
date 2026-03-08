import * as vscode from 'vscode';
import * as path from 'path';
import { FileScanner } from '../fileScanner';
import { InstallationManager } from '../installationManager';
import { RepositoryManager } from '../repositoryManager';
import { AgentFile, FileCategory } from '../types';
import { CategoryItem, FileItem } from './treeItems';
import { ensurePromptsDirectory } from '../pathResolver';

// reuse the same category ordering used by the main tree provider
const FILE_CATEGORIES: FileCategory[] = [
  'agent',
  'chatmode',
  'instruction',
  'prompt',
];

type AnyItem = CategoryItem | FileItem;

/**
 * Provides a flat view of the files currently sitting in the "prompts"
 * directory that are not associated with any registered repository.  This
 * helps users find orphaned files and also gives them a couple of handy
 * buttons for dropping or creating new files without leaving the extension.
 *
 * The tree structure is deliberately simple:
 *
 * ```
 * CategoryItem      (agent/chatmode/instruction/prompt)
 *   FileItem        (an MD file in prompts/)
 * ```
 *
 * The list is refreshed automatically when the underlying directory changes
 * (a `FileSystemWatcher` is created by the caller).  Consumers should call
 * `refresh()` after performing operations such as copying or creating files as
 * well.
 */
export class LocalFilesProvider implements vscode.TreeDataProvider<AnyItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<AnyItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached list of orphan files (relative paths) until the next refresh. */
  private orphanCache: AgentFile[] | null = null;

  constructor(
    private readonly repoManager: RepositoryManager,
    private readonly fileScanner: FileScanner,
    private readonly installManager: InstallationManager
  ) {
    // nothing to do here; the watcher is managed by the caller (extension.ts)
  }

  refresh(): void {
    this.orphanCache = null;
    this._onDidChangeTreeData.fire();
  }

  // ── TreeDataProvider ───────────────────────────────────────────────────

  getTreeItem(element: AnyItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AnyItem): Promise<AnyItem[]> {
    if (element) {
      if (element instanceof CategoryItem) {
        return element.files.map((f) => {
          const alias = this.installManager.getLabelFor(f.id);
          return new FileItem(f, alias);
        });
      }
      return [];
    }

    // root: cached orphan list if available
    if (!this.orphanCache) {
      this.orphanCache = await this.computeOrphans();
    }

    // build category items from cache
    const byCategory = new Map<FileCategory, AgentFile[]>();
    for (const cat of FILE_CATEGORIES) {
      byCategory.set(cat, []);
    }
    for (const f of this.orphanCache) {
      byCategory.get(f.category)!.push(f);
    }
    const result: CategoryItem[] = [];
    for (const cat of FILE_CATEGORIES) {
      const catFiles = byCategory.get(cat)!;
      if (catFiles.length > 0) {
        result.push(new CategoryItem(cat, 'local', catFiles));
      }
    }
    return result;
  }

  /** Re-scan prompts folder and compute orphan list. */
  private async computeOrphans(): Promise<AgentFile[]> {
    const promptsDir = await ensurePromptsDirectory();
    let files: AgentFile[];
    try {
      files = await this.fileScanner.scanRepository('local', promptsDir);
    } catch (err) {
      console.error('[LocalFilesProvider] failed to scan prompts:', err);
      files = [];
    }

    // determine which relative paths are already provided by active repos
    // *or* have been installed locally, regardless of their source name.
    const tracked = new Set<string>();

    // 1. paths coming from registered repositories (as before)
    const repos = this.repoManager.getAll();
    for (const repo of repos) {
      const localPath = this.repoManager.getLocalPath(repo.id);
      try {
        const repoFiles = await this.fileScanner.scanRepository(repo.id, localPath);
        for (const f of repoFiles) {
          tracked.add(f.relativePath);
        }
      } catch {
        // ignore scanning errors (repo not yet cloned or unreadable)
      }
    }

    // 2. also exclude any file that we have an install record for
    for (const rec of this.installManager.getAllRecords()) {
      // record.targetPath is absolute; compute path relative to promptsDir
      if (rec.targetPath.startsWith(promptsDir)) {
        const rel = rec.targetPath.slice(promptsDir.length + 1).replace(/\\/g, '/');
        tracked.add(rel);
      }
    }

    const orphans = files.filter((f) => !tracked.has(f.relativePath));
    // sort by relative path for determinism
    orphans.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return orphans;
  }
}
