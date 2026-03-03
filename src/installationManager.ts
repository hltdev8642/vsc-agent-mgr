import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { AgentFile, FileStatus, InstallRecord } from './types';
import { ensurePromptsDirectory, getPromptsDirectory } from './pathResolver';

const STATE_KEY = 'agentMgr.installRecords';

/**
 * Manages the lifecycle of locally installed prompt files.
 *
 * An "install" consists of:
 *  1. Copying the `.md` file from the local repo clone to the prompts
 *     directory.
 *  2. Persisting an `InstallRecord` (hashes + path) so we can later detect
 *     both remote changes *and* local user modifications.
 */
export class InstallationManager {
  private records: Map<string, InstallRecord>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.globalState.get<InstallRecord[]>(STATE_KEY, []);
    this.records = new Map(stored.map((r) => [r.fileId, r]));
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  isInstalled(fileId: string): boolean {
    return this.records.has(fileId);
  }

  getRecord(fileId: string): InstallRecord | undefined {
    return this.records.get(fileId);
  }

  getAllRecords(): InstallRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Derive the current `FileStatus` for a given `AgentFile`.
   *
   * Logic:
   *  - Not in records                        → `available`
   *  - In records but target file gone       → `available` (cleans up record)
   *  - remoteHash changed, local unchanged   → `outdated`
   *  - remoteHash changed, local also changed→ `conflicted`
   *  - nothing changed                       → `installed`
   */
  async computeStatus(file: AgentFile): Promise<FileStatus> {
    const record = this.records.get(file.id);
    if (!record) {
      return 'available';
    }

    // Verify the installed file still exists
    try {
      await fs.access(record.targetPath);
    } catch {
      // File was deleted by the user — remove stale record
      this.records.delete(file.id);
      await this.persist();
      return 'available';
    }

    const currentHash = await hashFile(record.targetPath);
    const localModified = currentHash !== record.installedHash;
    const remoteChanged = file.remoteHash !== record.sourceHash;

    if (remoteChanged && localModified) {
      return 'conflicted';
    }
    if (remoteChanged) {
      return 'outdated';
    }
    return 'installed';
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Copy `file` from its position in the local repo clone to the prompts
   * directory. If a file with the same name already exists there and is *not*
   * tracked by this extension, a `(1)`, `(2)`, … suffix is appended to avoid
   * silently overwriting unrelated user files.
   */
  async install(
    file: AgentFile,
    repoLocalPath: string,
    customName?: string,
    sourceRepo?: string
  ): Promise<void> {
    const sourcePath = path.join(repoLocalPath, file.relativePath);
    const promptsDir = await ensurePromptsDirectory();

    // determine filename: use custom name if given, otherwise original
    const filename = customName ? `${customName}.md` : file.name;
    let targetPath = path.join(promptsDir, filename);

    // If the target exists but is NOT tracked by us, avoid clobbering it
    if (!(await this.isTracked(targetPath))) {
      targetPath = await findFreePath(targetPath);
    }

    await fs.copyFile(sourcePath, targetPath);

    const installedHash = await hashFile(targetPath);

    const record: InstallRecord = {
      fileId: file.id,
      installedAt: new Date().toISOString(),
      sourceHash: file.remoteHash,
      installedHash,
      targetPath,
    };
    if (customName) {
      record.customName = customName;
    }
    if (sourceRepo) {
      record.sourceRepo = sourceRepo;
    }

    this.records.set(file.id, record);
    await this.persist();
  }

  /**
   * Overwrite the installed file with the current remote version.
   * The caller is responsible for confirming this is safe (no conflicts).
   */
  async update(file: AgentFile, repoLocalPath: string): Promise<void> {
    const record = this.records.get(file.id);
    if (!record) {
      // Not yet installed — delegate to install
      await this.install(file, repoLocalPath);
      return;
    }

    const sourcePath = path.join(repoLocalPath, file.relativePath);
    await fs.copyFile(sourcePath, record.targetPath);

    const installedHash = await hashFile(record.targetPath);

    record.installedAt = new Date().toISOString();
    record.sourceHash = file.remoteHash;
    record.installedHash = installedHash;
    // preserve customName and sourceRepo automatically

    await this.persist();
  }

  /**
   * Remove the installed file from disk and delete the install record.
   */
  async uninstall(fileId: string): Promise<void> {
    const record = this.records.get(fileId);
    if (!record) {
      return;
    }

    try {
      await fs.unlink(record.targetPath);
    } catch {
      // File may already be gone — that's fine
    }

    this.records.delete(fileId);
    await this.persist();
  }

  /**
   * Return the installed file's absolute path, or `undefined` if not installed.
   */
  getInstalledPath(fileId: string): string | undefined {
    return this.records.get(fileId)?.targetPath;
  }

  /**
   * Return the display label for an installed record (custom name if any).
   */
  getLabelFor(fileId: string): string | undefined {
    const r = this.records.get(fileId);
    if (!r) return undefined;
    if (r.customName) return r.customName;
    // derive from target path
    return path.basename(r.targetPath, '.md');
  }

  /**
   * Locate a record by its display label (custom or derived).
   */
  findByLabel(label: string): InstallRecord | undefined {
    for (const r of this.records.values()) {
      const lbl = r.customName
        ? r.customName
        : path.basename(r.targetPath, '.md');
      if (lbl.toLowerCase() === label.toLowerCase()) {
        return r;
      }
    }
    return undefined;
  }

  /**
   * Returns the path that would be used if `file` were installed right now.
   */
  getTargetPath(file: AgentFile): string {
    const record = this.records.get(file.id);
    if (record) {
      return record.targetPath;
    }
    return path.join(getPromptsDirectory(), file.name);
  }

  /**
   * Mark a conflict as "resolved — keep local".
   * Updates the stored `sourceHash` to match the current remote hash so the
   * file is no longer reported as conflicted, without touching its content.
   */
  async dismissConflict(fileId: string, newRemoteHash: string): Promise<void> {
    const record = this.records.get(fileId);
    if (!record) {
      return;
    }
    record.sourceHash = newRemoteHash;
    await this.persist();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    await this.context.globalState.update(
      STATE_KEY,
      Array.from(this.records.values())
    );
  }

  private async isTracked(targetPath: string): Promise<boolean> {
    for (const record of this.records.values()) {
      if (record.targetPath === targetPath) {
        return true;
      }
    }
    return false;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function hashFile(filePath: string): Promise<string> {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Given a desired target path, find the first path that doesn't already exist
 * by appending ` (1)`, ` (2)`, … before the extension.
 */
async function findFreePath(targetPath: string): Promise<string> {
  try {
    await fs.access(targetPath);
  } catch {
    return targetPath; // doesn't exist — use as-is
  }

  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, targetPath.length - ext.length);

  for (let i = 1; i < 100; i++) {
    const candidate = `${base} (${i})${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return targetPath; // give up and overwrite
}
