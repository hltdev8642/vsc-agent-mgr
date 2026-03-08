import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { RepositoryManager } from './repositoryManager';
import { FileScanner } from './fileScanner';
import { InstallationManager } from './installationManager';
import { SyncManager } from './syncManager';
import { AgentManagerTreeProvider } from './views/treeProvider';
import { FilterViewProvider } from './filterView';
import { RepositoryItem, CategoryItem, FileItem } from './views/treeItems';
import { AgentFile, SyncResult } from './types';
import { ensurePromptsDirectory, getPromptsDirectory } from './pathResolver';

// ── Extension lifecycle ───────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  console.log('[extension] activate called');
  // Wire up all services
  const gitService = new GitService();
  const repoManager = new RepositoryManager(context, gitService);
  const fileScanner = new FileScanner();
  const installManager = new InstallationManager(context);

  const treeProvider = new AgentManagerTreeProvider(
    repoManager,
    fileScanner,
    installManager
  );

  const syncManager = new SyncManager(
    repoManager,
    installManager,
    fileScanner,
    gitService,
    () => treeProvider.refresh()
  );

  // Register the sidebar tree view
  const treeView = vscode.window.createTreeView('agentManagerView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // register a tiny filter sub-view that sits above the repo list
  const filterProvider = new FilterViewProvider(treeProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      FilterViewProvider.viewType,
      filterProvider
    )
  );

  // ── Command registrations ─────────────────────────────────────────────────

  context.subscriptions.push(
    treeView,

    vscode.commands.registerCommand('agentMgr.addRepository', () =>
      cmdAddRepository(repoManager, treeProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.removeRepository',
      (item?: RepositoryItem) =>
        cmdRemoveRepository(item, repoManager, installManager, treeProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.syncRepository',
      (item?: RepositoryItem) =>
        cmdSyncRepository(item, repoManager, syncManager)
    ),

    vscode.commands.registerCommand('agentMgr.syncAll', () =>
      cmdSyncAll(syncManager)
    ),

    vscode.commands.registerCommand('agentMgr.refresh', () =>
      treeProvider.refresh()
    ),

    vscode.commands.registerCommand(
      'agentMgr.installFile',
      (item: FileItem) =>
        cmdInstallFile(item, repoManager, installManager, treeProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.previewFile',
      (item: FileItem) => cmdPreviewFile(item, repoManager)
    ),

    vscode.commands.registerCommand(
      'agentMgr.filterRepos',
      () => cmdFilterRepos(treeProvider, filterProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.uninstallFile',
      (item: FileItem) =>
        cmdUninstallFile(item, installManager, treeProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.updateFile',
      (item: FileItem) =>
        cmdUpdateFile(item, repoManager, installManager, treeProvider)
    ),

    vscode.commands.registerCommand('agentMgr.viewDiff', (item: FileItem) =>
      cmdViewDiff(item, repoManager, installManager)
    ),

    vscode.commands.registerCommand(
      'agentMgr.resolveConflict',
      (item: FileItem) =>
        cmdResolveConflict(item, repoManager, installManager, treeProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.installAll',
      (item: CategoryItem) =>
        cmdInstallAll(item, repoManager, installManager, treeProvider)
    ),

    vscode.commands.registerCommand(
      'agentMgr.openInBrowser',
      (item?: RepositoryItem) => cmdOpenInBrowser(item, repoManager)
    ),

    vscode.commands.registerCommand(
      'agentMgr.setAuthToken',
      (item?: RepositoryItem) => cmdSetAuthToken(item, repoManager)
    ),

    vscode.commands.registerCommand('agentMgr.openPromptsFolder', () =>
      cmdOpenPromptsFolder()
    ),

    vscode.commands.registerCommand('agentMgr.openFile', (file: AgentFile) =>
      cmdOpenFile(file, installManager)
    )
  );

  // ── Default repositories (settings-driven) ──────────────────────────────

  /** Add any URLs from `defaultRepositories` that aren't already registered. */
  async function syncDefaultRepositories(): Promise<void> {
    const defaults = vscode.workspace
      .getConfiguration('agentMgr')
      .get<string[]>('defaultRepositories', []);
    const existingUrls = new Set(
      repoManager.getAll().map((r) => normaliseUrl(r.url))
    );
    for (const url of defaults) {
      if (!url.trim()) {
        continue;
      }
      if (existingUrls.has(normaliseUrl(url))) {
        continue; // already registered
      }
      repoManager
        .add(url.trim())
        .then(() => treeProvider.refresh())
        .catch((err: unknown) =>
          vscode.window.showWarningMessage(
            `Could not add default repository "${url}": ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
    }
  }

  // Run once on activation, then whenever the setting changes.
  syncDefaultRepositories();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentMgr.defaultRepositories')) {
        syncDefaultRepositories();
      }
    })
  );

  // ── Auto-sync on startup ──────────────────────────────────────────────────

  if (
    vscode.workspace
      .getConfiguration('agentMgr')
      .get<boolean>('autoSyncOnStartup', true) &&
    repoManager.getAll().length > 0
  ) {
    // Delay slightly so the UI can render first
    setTimeout(() => {
      cmdSyncAll(syncManager);
    }, 2000);
  }

  // ── Periodic auto-sync ────────────────────────────────────────────────────

  const intervalMinutes = vscode.workspace
    .getConfiguration('agentMgr')
    .get<number>('autoSyncInterval', 60);

  if (intervalMinutes > 0) {
    const handle = setInterval(
      () => {
        if (
          vscode.workspace
            .getConfiguration('agentMgr')
            .get<boolean>('autoSyncOnStartup', true)
        ) {
          syncManager.syncAll().catch(() => {
            // background sync errors are surfaced via repo status icons
          });
        }
      },
      intervalMinutes * 60 * 1000
    );
    context.subscriptions.push({ dispose: () => clearInterval(handle) });
  }
}

export function deactivate(): void {
  // nothing to clean up beyond disposables registered above
}

// ── Command implementations ───────────────────────────────────────────────────

/** Prompt for a URL + branch + optional token, then clone and register. */
async function cmdAddRepository(
  repoManager: RepositoryManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: 'Add Repository — Step 1/2',
    prompt: 'Enter the Git repository URL',
    placeHolder: 'https://github.com/owner/repo',
    ignoreFocusOut: true,
    validateInput(value) {
      if (!value?.trim()) {
        return 'URL is required';
      }
      if (!value.startsWith('http') && !value.startsWith('git@')) {
        return 'URL must start with https:// or git@…';
      }
      return undefined;
    },
  });
  if (!url) {
    return;
  }

  const branch = await vscode.window.showInputBox({
    title: 'Add Repository — Step 2/2',
    prompt: 'Branch to track (leave empty for repository default)',
    placeHolder: 'main',
    value: 'main',
    ignoreFocusOut: true,
  });
  if (branch === undefined) {
    return; // user pressed Escape
  }

  const visibility = await vscode.window.showQuickPick(
    ['Public (no token needed)', 'Private (personal access token required)'],
    {
      title: 'Repository Visibility',
      placeHolder: 'Is this a public or private repository?',
      ignoreFocusOut: true,
    }
  );
  if (!visibility) {
    return;
  }

  let token: string | undefined;
  if (visibility.startsWith('Private')) {
    token = await vscode.window.showInputBox({
      title: 'Personal Access Token',
      prompt:
        'Enter your PAT. It will be stored securely in VS Code SecretStorage.',
      password: true,
      ignoreFocusOut: true,
      validateInput(v) {
        return v?.trim() ? undefined : 'Token is required for private repos';
      },
    });
    if (!token) {
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Cloning ${url}…`,
      cancellable: false,
    },
    async () => {
      try {
        const repo = await repoManager.add(
          url.trim(),
          branch?.trim() || 'main',
          token
        );
        treeProvider.refresh();
        notify(`Repository "${repo.name}" added successfully.`);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to add repository: ${toMessage(err)}`
        );
      }
    }
  );
}

/** Ask for confirmation, uninstall tracked files, then remove the repo. */
async function cmdRemoveRepository(
  item: RepositoryItem | undefined,
  repoManager: RepositoryManager,
  installManager: InstallationManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const repo =
    item?.repo ?? (await pickRepository(repoManager, 'Remove Repository'));
  if (!repo) {
    return;
  }

  const response = await vscode.window.showWarningMessage(
    `Remove repository "${repo.name}"? This will delete the local clone. Installed files will NOT be deleted.`,
    { modal: true },
    'Remove'
  );
  if (response !== 'Remove') {
    return;
  }

  await repoManager.remove(repo.id);
  treeProvider.refresh();
  notify(`Repository "${repo.name}" removed.`);
}

/** Pull the latest commits for a single repo. */
async function cmdSyncRepository(
  item: RepositoryItem | undefined,
  repoManager: RepositoryManager,
  syncManager: SyncManager
): Promise<void> {
  const repo =
    item?.repo ?? (await pickRepository(repoManager, 'Sync Repository'));
  if (!repo) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Syncing "${repo.name}"…`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await syncManager.syncOne(repo.id);
        showSyncSummary([result]);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Sync failed for "${repo.name}": ${toMessage(err)}`
        );
      }
    }
  );
}

/** Show the embedded search bar and focus it. */
async function cmdFilterRepos(
  treeProvider: AgentManagerTreeProvider,
  filterView: FilterViewProvider
): Promise<void> {
  // debug notification to verify command execution
  notify('Filter button clicked');
  // reveal the whole view container in case the user is elsewhere
  await vscode.commands.executeCommand('workbench.view.extension.agentManager');
  // focus the filter input and shrink the sidebar split a couple of times so
  // the filter bar occupies minimal height
  filterView.focus();
  setTimeout(() => {
    vscode.commands.executeCommand('workbench.action.decreaseViewSize');
    vscode.commands.executeCommand('workbench.action.decreaseViewSize');
  }, 50);
  // if the filter view never becomes visible (hidden via Views menu), fall
  // back to a plain input box so the user can still type a filter.
  setTimeout(async () => {
    if (!filterView.isVisible()) {
      notify('Filter bar is hidden – falling back to input box');
      const val = await vscode.window.showInputBox({
        prompt: 'Filter repositories (bar is hidden in sidebar)',
      });
      if (val !== undefined) {
        treeProvider.setRepoFilter(val);
      }
    }
  }, 200);
}

/** Pull all registered repos. */
async function cmdSyncAll(syncManager: SyncManager): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Syncing all repositories…',
      cancellable: false,
    },
    async () => {
      try {
        const results = await syncManager.syncAll();
        showSyncSummary(results);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Sync failed: ${toMessage(err)}`);
      }
    }
  );
}

/** Copy a file from the repo clone to the prompts directory. */
async function cmdInstallFile(
  item: FileItem,
  repoManager: RepositoryManager,
  installManager: InstallationManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const { file } = item;
  const localPath = repoManager.getLocalPath(file.repoId);

  // conflict detection: is there already a record with same display label
  const existing = installManager.findByLabel(file.displayName);
  let customName: string | undefined;
  if (existing && existing.fileId !== file.id) {
    // prompt user to rename before proceeding
    customName = await vscode.window.showInputBox({
      title: 'Name conflict',
      prompt: `A mode named "${file.displayName}" is already installed. Please provide a new name to avoid conflict:`,
      value: `${file.displayName} (1)`,
      ignoreFocusOut: true,
      validateInput(v) {
        if (!v?.trim()) return 'Name cannot be empty';
        if (installManager.findByLabel(v.trim())) return 'Another mode already uses that name';
        return undefined;
      },
    });
    if (!customName) {
      // user cancelled rename
      return;
    }
  }

  try {
    await installManager.install(file, localPath, customName, file.repoId);
    treeProvider.refresh();
    const label = customName ?? file.displayName;
    notify(`"${label}" installed.`);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Failed to install "${file.name}": ${toMessage(err)}`
    );
  }
}

/** Preview the raw contents of a repository file in an editor. */
async function cmdPreviewFile(
  item: FileItem,
  repoManager: RepositoryManager
): Promise<void> {
  const { file } = item;
  const localPath = path.join(repoManager.getLocalPath(file.repoId), file.relativePath);
  try {
    const doc = await vscode.workspace.openTextDocument(localPath);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Failed to preview "${file.displayName}": ${toMessage(err)}`
    );
  }
}

/** Remove an installed file from the prompts directory. */
async function cmdUninstallFile(
  item: FileItem,
  installManager: InstallationManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const { file } = item;

  const response = await vscode.window.showWarningMessage(
    `Uninstall "${file.displayName}"? The file will be deleted from your prompts folder.`,
    { modal: true },
    'Uninstall'
  );
  if (response !== 'Uninstall') {
    return;
  }

  try {
    await installManager.uninstall(file.id);
    treeProvider.refresh();
    notify(`"${file.displayName}" uninstalled.`);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Failed to uninstall "${file.name}": ${toMessage(err)}`
    );
  }
}

/** Overwrite the installed file with the latest remote version. */
async function cmdUpdateFile(
  item: FileItem,
  repoManager: RepositoryManager,
  installManager: InstallationManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const { file } = item;
  const localPath = repoManager.getLocalPath(file.repoId);

  try {
    await installManager.update(file, localPath);
    treeProvider.refresh();
    const label = installManager.getLabelFor(file.id) ?? file.displayName;
    notify(`"${label}" updated to latest.`);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Failed to update "${file.name}": ${toMessage(err)}`
    );
  }
}

/**
 * Open a VS Code diff editor comparing the installed version with the latest
 * remote version from the local clone.
 */
async function cmdViewDiff(
  item: FileItem,
  repoManager: RepositoryManager,
  installManager: InstallationManager
): Promise<void> {
  const { file } = item;
  const record = installManager.getRecord(file.id);

  if (!record) {
    vscode.window.showInformationMessage(
      `"${file.displayName}" is not installed — nothing to diff.`
    );
    return;
  }

  const remotePath = path.join(
    repoManager.getLocalPath(file.repoId),
    file.relativePath
  );

  const localUri = vscode.Uri.file(record.targetPath);
  const remoteUri = vscode.Uri.file(remotePath);

  await vscode.commands.executeCommand(
    'vscode.diff',
    localUri,
    remoteUri,
    `${file.displayName}: Local ↔ Remote`
  );
}

/**
 * Handle a conflict: let the user choose keep-local, use-remote, or open diff.
 */
async function cmdResolveConflict(
  item: FileItem,
  repoManager: RepositoryManager,
  installManager: InstallationManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const { file } = item;
  const configStrategy = vscode.workspace
    .getConfiguration('agentMgr')
    .get<string>('conflictResolution', 'ask');

  let useRemote: boolean;

  if (configStrategy === 'useRemote') {
    useRemote = true;
  } else if (configStrategy === 'keepLocal') {
    useRemote = false;
  } else {
    // 'ask' — prompt the user
    const choice = await vscode.window.showWarningMessage(
      `"${file.displayName}" has been modified locally AND updated remotely. How do you want to resolve this conflict?`,
      { modal: true },
      'Keep Local',
      'Use Remote',
      'View Diff'
    );

    if (!choice) {
      return;
    }

    if (choice === 'View Diff') {
      await cmdViewDiff(item, repoManager, installManager);
      // Show a follow-up prompt after the user reviews the diff
      const followUp = await vscode.window.showWarningMessage(
        `After reviewing the diff, how do you want to resolve "${file.displayName}"?`,
        { modal: true },
        'Keep Local',
        'Use Remote'
      );
      if (!followUp) {
        return;
      }
      useRemote = followUp === 'Use Remote';
    } else {
      useRemote = choice === 'Use Remote';
    }
  }

  if (useRemote) {
    const localPath = repoManager.getLocalPath(file.repoId);
    try {
      await installManager.update(file, localPath);
      treeProvider.refresh();
      notify(`"${file.displayName}" updated to remote version.`);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Failed to update "${file.name}": ${toMessage(err)}`
      );
    }
  } else {
    // Keep Local — advance the baseline sourceHash so the conflict is dismissed
    await installManager.dismissConflict(file.id, file.remoteHash);
    treeProvider.refresh();
    notify(`"${file.displayName}" conflict resolved — keeping local version.`);
  }
}

/** Install every available file in a category. */
async function cmdInstallAll(
  item: CategoryItem,
  repoManager: RepositoryManager,
  installManager: InstallationManager,
  treeProvider: AgentManagerTreeProvider
): Promise<void> {
  const available = item.files.filter((f) => f.status === 'available');
  if (available.length === 0) {
    vscode.window.showInformationMessage(
      'All files in this category are already installed.'
    );
    return;
  }

  const localPath = repoManager.getLocalPath(item.repoId);
  let installed = 0;
  const errors: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing ${available.length} file(s)…`,
      cancellable: false,
    },
    async (progress) => {
      for (const file of available) {
        progress.report({ message: file.name });
        try {
          await installManager.install(file, localPath);
          installed++;
        } catch (err: unknown) {
          errors.push(`${file.name}: ${toMessage(err)}`);
        }
      }
    }
  );

  treeProvider.refresh();

  if (errors.length > 0) {
    vscode.window.showWarningMessage(
      `Installed ${installed} file(s). ${errors.length} failed:\n${errors.join('\n')}`
    );
  } else {
    notify(`Installed ${installed} file(s).`);
  }
}

/** Open a repository URL in the default browser. */
async function cmdOpenInBrowser(
  item: RepositoryItem | undefined,
  repoManager: RepositoryManager
): Promise<void> {
  const repo =
    item?.repo ?? (await pickRepository(repoManager, 'Open in Browser'));
  if (!repo) {
    return;
  }
  const url = repo.url.replace(/\.git$/, '');
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Store or update a personal access token for a repository. */
async function cmdSetAuthToken(
  item: RepositoryItem | undefined,
  repoManager: RepositoryManager
): Promise<void> {
  const repo =
    item?.repo ?? (await pickRepository(repoManager, 'Set Auth Token'));
  if (!repo) {
    return;
  }

  const token = await vscode.window.showInputBox({
    title: `Auth Token — ${repo.name}`,
    prompt: 'Enter your Personal Access Token (stored in SecretStorage)',
    password: true,
    ignoreFocusOut: true,
  });
  if (!token) {
    return;
  }

  await repoManager.setAuthToken(repo.id, token);
  notify(`Token saved for "${repo.name}".`);
}

/** Reveal the prompts directory in the OS file explorer. */
async function cmdOpenPromptsFolder(): Promise<void> {
  const dir = getPromptsDirectory();
  try {
    await ensurePromptsDirectory();
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(dir)
    );
  } catch {
    vscode.window.showInformationMessage(`Prompts folder: ${dir}`);
  }
}

/** Open the installed version of a file in the editor. */
async function cmdOpenFile(
  file: AgentFile | undefined,
  installManager: InstallationManager
): Promise<void> {
  if (!file) {
    vscode.window.showInformationMessage('No file selected.');
    return;
  }
  const installedPath = installManager.getInstalledPath(file.id);
  if (!installedPath) {
    const label =
      file.displayName || file.name || file.relativePath || file.id || '<unknown>';
    vscode.window.showInformationMessage(
      `"${label}" is not installed.`
    );
    return;
  }
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(installedPath));
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Could not open "${file.name}": ${toMessage(err)}`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Show a QuickPick to let the user select one of the registered repos. */
async function pickRepository(
  repoManager: RepositoryManager,
  title: string
): Promise<import('./types').Repository | undefined> {
  const repos = repoManager.getAll();
  if (repos.length === 0) {
    vscode.window.showInformationMessage(
      'No repositories registered. Use "Agent Manager: Add Repository" first.'
    );
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }

  const picked = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.name, description: r.url, id: r.id })),
    { title, placeHolder: 'Select a repository', ignoreFocusOut: true }
  );
  return picked ? repoManager.getById(picked.id) : undefined;
}

/** Show a summary notification after one or more syncs. */
function showSyncSummary(results: SyncResult[]): void {
  if (!vscode.workspace.getConfiguration('agentMgr').get<boolean>('showNotifications', true)) {
    return;
  }

  const errors = results.flatMap((r) => r.errors);
  const conflicts = results.flatMap((r) => r.conflicts);
  const updated = results.reduce((n, r) => n + r.filesUpdated, 0);
  const newFiles = results.reduce((n, r) => n + r.newFiles, 0);

  if (errors.length > 0) {
    vscode.window.showWarningMessage(
      `Sync completed with ${errors.length} error(s). Check the repository status icons for details.`
    );
    return;
  }

  const parts: string[] = [];
  if (updated > 0) {
    parts.push(`${updated} update${updated === 1 ? '' : 's'} available`);
  }
  if (newFiles > 0) {
    parts.push(`${newFiles} new file${newFiles === 1 ? '' : 's'}`);
  }
  if (conflicts.length > 0) {
    parts.push(`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`);
  }

  if (parts.length > 0) {
    vscode.window.showInformationMessage(`Sync complete: ${parts.join(', ')}.`);
  }
}

function notify(message: string): void {
  if (
    vscode.workspace
      .getConfiguration('agentMgr')
      .get<boolean>('showNotifications', true)
  ) {
    vscode.window.showInformationMessage(message);
  }
}

function toMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Normalise a repo URL for duplicate-detection (strip .git suffix, trailing slash, lowercase). */
function normaliseUrl(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
}
