import * as vscode from 'vscode';
import { Repository, AgentFile, FileCategory, FileStatus } from '../types';

// ── Repository item ───────────────────────────────────────────────────────────

export class RepositoryItem extends vscode.TreeItem {
  constructor(public readonly repo: Repository) {
    super(repo.name, vscode.TreeItemCollapsibleState.Expanded);

    this.contextValue = 'repository';
    this.id = `repo:${repo.id}`;
    this.description = shortenUrl(repo.url);
    this.tooltip = buildRepoTooltip(repo);

    switch (repo.syncStatus) {
      case 'syncing':
        this.iconPath = new vscode.ThemeIcon('sync~spin');
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon(
          'error',
          new vscode.ThemeColor('errorForeground')
        );
        this.description = repo.syncError ?? 'Sync error';
        break;
      case 'never':
        this.iconPath = new vscode.ThemeIcon('git-fetch');
        break;
      default:
        this.iconPath = new vscode.ThemeIcon('repo');
    }
  }
}

// ── Category item ─────────────────────────────────────────────────────────────

export class CategoryItem extends vscode.TreeItem {
  constructor(
    public readonly category: FileCategory,
    public readonly repoId: string,
    public readonly files: AgentFile[]
  ) {
    const label = categoryLabel(category);
    const count = files.length;
    super(
      `${label} (${count})`,
      count === 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
    );

    this.contextValue = 'category';
    this.id = `category:${repoId}:${category}`;
    this.iconPath = new vscode.ThemeIcon(categoryIcon(category));
    this.tooltip = `${count} ${label.toLowerCase()} file${count === 1 ? '' : 's'}`;
  }
}

// ── File item ─────────────────────────────────────────────────────────────────

export class FileItem extends vscode.TreeItem {
  constructor(public readonly file: AgentFile) {
    super(file.displayName, vscode.TreeItemCollapsibleState.None);

    this.contextValue = `file_${file.status}`;
    this.id = `file:${file.id}`;
    this.description = statusDescription(file.status);
    this.tooltip = buildFileTooltip(file);
    this.iconPath = fileIcon(file.status);

    // Allow opening the installed file with a single click
    if (
      file.status === 'installed' ||
      file.status === 'outdated' ||
      file.status === 'conflicted'
    ) {
      this.command = {
        command: 'agentMgr.openFile',
        title: 'Open File',
        arguments: [file],
      };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortenUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/^www\./, '');
}

function buildRepoTooltip(repo: Repository): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`### ${repo.name}\n\n`);
  md.appendMarkdown(`**URL:** ${repo.url}\n\n`);
  md.appendMarkdown(`**Branch:** \`${repo.branch}\`\n\n`);
  md.appendMarkdown(`**Added:** ${formatDate(repo.addedAt)}\n\n`);
  if (repo.lastSynced) {
    md.appendMarkdown(`**Last synced:** ${formatDate(repo.lastSynced)}\n\n`);
  } else {
    md.appendMarkdown(`**Last synced:** Never\n\n`);
  }
  if (repo.syncStatus === 'error' && repo.syncError) {
    md.appendMarkdown(`**Error:** ${repo.syncError}\n\n`);
  }
  return md;
}

function buildFileTooltip(file: AgentFile): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`### ${file.displayName}\n\n`);
  md.appendMarkdown(`**File:** \`${file.name}\`\n\n`);
  md.appendMarkdown(`**Path:** \`${file.relativePath}\`\n\n`);
  md.appendMarkdown(`**Category:** ${categoryLabel(file.category)}\n\n`);
  md.appendMarkdown(`**Status:** ${statusLabel(file.status)}\n\n`);
  return md;
}

function categoryLabel(category: FileCategory): string {
  switch (category) {
    case 'agent':
      return 'Agents';
    case 'chatmode':
      return 'Chat Modes';
    case 'instruction':
      return 'Instructions';
    default:
      return 'Prompts';
  }
}

function categoryIcon(category: FileCategory): string {
  switch (category) {
    case 'agent':
      return 'robot';
    case 'chatmode':
      return 'comment-discussion';
    case 'instruction':
      return 'book';
    default:
      return 'file-text';
  }
}

function statusDescription(status: FileStatus): string {
  switch (status) {
    case 'installed':
      return '✓ installed';
    case 'outdated':
      return '↑ update available';
    case 'conflicted':
      return '⚠ conflict';
    default:
      return '';
  }
}

function statusLabel(status: FileStatus): string {
  switch (status) {
    case 'installed':
      return 'Installed';
    case 'outdated':
      return 'Update Available';
    case 'conflicted':
      return 'Conflict — both local and remote modified';
    default:
      return 'Available';
  }
}

function fileIcon(status: FileStatus): vscode.ThemeIcon {
  switch (status) {
    case 'installed':
      return new vscode.ThemeIcon(
        'check',
        new vscode.ThemeColor('testing.iconPassed')
      );
    case 'outdated':
      return new vscode.ThemeIcon(
        'arrow-up',
        new vscode.ThemeColor('notificationsWarningIcon.foreground')
      );
    case 'conflicted':
      return new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('notificationsWarningIcon.foreground')
      );
    default:
      return new vscode.ThemeIcon('cloud-download');
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
