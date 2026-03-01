import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';

/**
 * Returns the absolute path to the VS Code prompts directory for the current
 * platform and VS Code variant (Stable / Insiders).
 *
 * Resolution order:
 *  1. `agentMgr.promptsPath` setting (user override)
 *  2. Platform default derived from `vscode.env.appName`
 */
export function getPromptsDirectory(): string {
  const config = vscode.workspace.getConfiguration('agentMgr');
  const override = config.get<string>('promptsPath', '').trim();
  if (override) {
    return override;
  }

  const appName = vscode.env.appName ?? '';
  const isInsiders = appName.toLowerCase().includes('insiders');
  const codeDirName = isInsiders ? 'Code - Insiders' : 'Code';

  switch (process.platform) {
    case 'win32': {
      const appData =
        process.env['APPDATA'] ??
        path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, codeDirName, 'User', 'prompts');
    }
    case 'darwin':
      return path.join(
        os.homedir(),
        'Library',
        'Application Support',
        codeDirName,
        'User',
        'prompts'
      );
    default: {
      // Linux / other POSIX
      const configBase =
        process.env['XDG_CONFIG_HOME'] ??
        path.join(os.homedir(), '.config');
      return path.join(configBase, codeDirName, 'User', 'prompts');
    }
  }
}

/** Ensures the prompts directory exists, creating it if necessary. */
export async function ensurePromptsDirectory(): Promise<string> {
  const dir = getPromptsDirectory();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
