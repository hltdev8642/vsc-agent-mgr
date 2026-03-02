import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { AgentFile, FileCategory } from './types';

// Directories that are never meaningful for prompt files
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.github',
  '.vscode',
  'dist',
  'out',
  'build',
]);

/**
 * Scans a locally-cloned repository for `.md` files and returns metadata for
 * each discovered file. The `status` field on every returned `AgentFile` is
 * set to `'available'` — callers are expected to enrich it from
 * `InstallationManager.computeStatus()` before rendering.
 */
export class FileScanner {
  /**
   * Walk `repoPath` recursively and return one `AgentFile` per `.md` file
   * found, with its repo-relative path and detected category.
   */
  async scanRepository(
    repoId: string,
    repoPath: string
  ): Promise<AgentFile[]> {
    const results: AgentFile[] = [];
    await this.walk(repoPath, repoPath, repoId, results);
    return results;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async walk(
    dir: string,
    repoRoot: string,
    repoId: string,
    out: AgentFile[]
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory unreadable — skip silently
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue; // skip hidden files and directories (e.g. .git, .github)
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await this.walk(fullPath, repoRoot, repoId, out);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const relativePath = path
          .relative(repoRoot, fullPath)
          .split(path.sep)
          .join('/');
        const agentFile = await this.buildAgentFile(
          repoId,
          fullPath,
          relativePath
        );
        out.push(agentFile);
      }
    }
  }

  private async buildAgentFile(
    repoId: string,
    fullPath: string,
    relativePath: string
  ): Promise<AgentFile> {
    const name = path.basename(relativePath);
    return {
      id: `${repoId}:${relativePath}`,
      repoId,
      relativePath,
      name,
      displayName: deriveDisplayName(name),
      category: detectCategory(name),
      remoteHash: await computeHash(fullPath),
      status: 'available',
    };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Infer the human-readable category from the filename.
 *
 * Heuristics (case-insensitive):
 *   *.agent.md            → agent
 *   *.chatmode.md         → chatmode
 *   *.instructions.md     → instruction
 *   anything else         → prompt
 */
function detectCategory(filename: string): FileCategory {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.agent.md')) {
    return 'agent';
  }
  if (lower.endsWith('.chatmode.md')) {
    return 'chatmode';
  }
  if (lower.endsWith('.instructions.md')) {
    return 'instruction';
  }
  return 'prompt';
}

/**
 * Convert a filename like `my-cool.instructions.md` into `My Cool`.
 */
function deriveDisplayName(filename: string): string {
  const withoutExt = filename
    .replace(/\.(agent|chatmode|instructions|prompt)\.md$/i, '')
    .replace(/\.md$/i, '');
  return withoutExt
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function computeHash(filePath: string): Promise<string> {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}
