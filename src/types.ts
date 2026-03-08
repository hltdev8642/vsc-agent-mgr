/**
 * Core type definitions for the AI Agent Manager extension.
 */

/** Category of an .md file based on its name pattern. */
export type FileCategory = 'agent' | 'chatmode' | 'instruction' | 'prompt';

/** Installation status of a file relative to local install state. */
export type FileStatus = 'available' | 'installed' | 'outdated' | 'conflicted';

/** Lifecycle state of a repository's last sync operation. */
export type SyncState = 'idle' | 'syncing' | 'error' | 'never';

/** A registered Git repository. */
export interface Repository {
  /** Unique opaque identifier. */
  id: string;
  /** Remote URL (e.g. https://github.com/user/repo). */
  url: string;
  /** Human-readable name, derived from URL. */
  name: string;
  /** Git branch to track. */
  branch: string;
  /** ISO-8601 timestamp when the repo was added. */
  addedAt: string;
  /** ISO-8601 timestamp of the last successful sync. */
  lastSynced?: string;
  /** Current sync lifecycle state. */
  syncStatus: SyncState;
  /** Error message from the last failed sync. */
  syncError?: string;
  /** Transient number of installed files that can be updated; recalculated on refresh */
  updateCount?: number;
}

/** Metadata for an .md file discovered inside a repository. */
export interface AgentFile {
  /** Unique ID: `${repoId}:${relativePath}` */
  id: string;
  /** Parent repository ID. */
  repoId: string;
  /** Path relative to the repo root, using forward slashes. */
  relativePath: string;
  /** The filename (basename). */
  name: string;
  /** Human-readable label derived from the filename. */
  displayName: string;
  /** Detected category. */
  category: FileCategory;
  /** Computed SHA-256 hash of the file content in the local clone. */
  remoteHash: string;
  /** Current status — populated by InstallationManager at view-render time. */
  status: FileStatus;
}

/** Persisted record of a locally installed file. */
export interface InstallRecord {
  /** Matches AgentFile.id. */
  fileId: string;
  /** ISO-8601 install timestamp. */
  installedAt: string;
  /**
   * SHA-256 hash of the remote file at install time.
   * Used to detect when the remote changes after installation.
   */
  sourceHash: string;
  /**
   * SHA-256 hash of the file as it was written to disk.
   * Used to detect local user modifications.
   */
  installedHash: string;
  /** Absolute path to the installed file on disk. */
  targetPath: string;
  /**
   * Optional user-provided display name/alias.  Used when the user renames a
   * mode to avoid conflicts with an already-installed one.
   */
  customName?: string;
  /** Identifier of the source repository (repoId or URL) for origin tracking. */
  sourceRepo?: string;
}

/** Summary produced after syncing a repository. */
export interface SyncResult {
  repoId: string;
  repoName: string;
  filesChecked: number;
  filesUpdated: number;
  newFiles: number;
  conflicts: string[];
  errors: string[];
}
