# AI Agent Manager

A VS Code extension for managing AI agent configurations, chatmodes, and instruction files across multiple Git repositories. Discover, install, and keep your `.md` prompt files up to date from a central sidebar panel.

---

## Features

### Repository Management
- **Add** any public or private Git repository containing `.md` files
- **Remove** repositories when no longer needed
- **Browse** repositories in the VS Code Activity Bar sidebar

### File Discovery
Automatically detects and categorises `.md` files by filename pattern:

| Pattern | Category |
|---|---|
| `*.agent.md` | Agents |
| `*.chatmode.md` | Chat Modes |
| `*.instructions.md` | Instructions |
| `*.md` (other) | Prompts |

### Installation
- One-click install copies files to the VS Code prompts directory:
  - **Windows:** `%APPDATA%\Code - Insiders\User\prompts`
  - **macOS:** `~/Library/Application Support/Code - Insiders/User/prompts`
  - **Linux:** `~/.config/Code - Insiders/User/prompts`

### Status Indicators
Every file shows a live status badge:

| Icon | Status | Meaning |
|---|---|---|
| ✓ | Installed | Up to date |
| ↑ | Update Available | Remote changed, local untouched |
| ⚠ | Conflict | Both remote and local have changed |
| (none) | Available | Not yet installed |

### Sync & Updates
- **Manual sync** per-repo or for all repos at once
- **Background auto-sync** at a configurable interval (default: 60 min)
- **Startup sync** automatically on VS Code launch

### Conflict Resolution
When both the installed file and the remote file have changed, the extension lets you:
1. **View Diff** — open a side-by-side diff in the editor
2. **Keep Local** — preserve your edited version
3. **Use Remote** — overwrite with the latest remote contents
4. Configure a default strategy via `agentMgr.conflictResolution`

---

## Getting Started

### Prerequisites
- [Git](https://git-scm.com/) must be installed and on your `PATH`
- Node.js 18+ (to build from source)

### Build from Source

```bash
cd vsc-agent-mgr
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

### Package as VSIX

```bash
npm install -g @vscode/vsce
vsce package
```

---

## Usage

### Add a Repository

1. Click the **robot icon** in the Activity Bar to open the AI Agent Manager panel.
2. Click **＋** (Add Repository) in the panel toolbar.
3. Enter the repository URL, branch, and optionally a Personal Access Token for private repos.

### Install a File

Right-click any file with the **↓** icon and choose **Install File**, or click the inline download button.

### Update a File

When the **↑ update available** badge appears, right-click and choose **Update to Latest**.

### Resolve a Conflict

When the **⚠ conflict** badge appears, right-click and choose **Resolve Conflict**. A dialog lets you view the diff, keep your local version, or accept the remote update.

### Command Palette

All major operations are accessible via **Ctrl+Shift+P** (Cmd+Shift+P on macOS):

| Command | Description |
|---|---|
| `Agent Manager: Add Repository` | Register a new repository |
| `Agent Manager: Sync All Repositories` | Pull all repos |
| `Agent Manager: Refresh View` | Reload the sidebar tree |
| `Agent Manager: Open Prompts Folder` | Reveal the prompts directory in Explorer |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `agentMgr.promptsPath` | `""` | Override the prompts directory path |
| `agentMgr.autoSyncOnStartup` | `true` | Sync repos when VS Code starts |
| `agentMgr.autoSyncInterval` | `60` | Minutes between background syncs (0 = off) |
| `agentMgr.conflictResolution` | `"ask"` | `ask` / `keepLocal` / `useRemote` |
| `agentMgr.showNotifications` | `true` | Show info toasts for install/update events |
| `agentMgr.defaultRepositories` | `[]` | URLs added automatically on first launch |
| `agentMgr.scanSubdirectories` | `true` | Recurse into subdirectories |

---

## Private Repository Authentication

Tokens are stored securely in VS Code's built-in **SecretStorage** — they are never written to disk in plain text.

- **GitHub:** Create a [Personal Access Token](https://github.com/settings/tokens) with `read:repo` scope.
- **GitLab:** Use a Project Access Token or a PAT and prefix it with `oauth2:` (e.g. `oauth2:glpat-…`).
- **Azure DevOps / other:** Use your PAT directly.

You can update a stored token at any time by right-clicking a repository and choosing **Set Authentication Token**.

---

## Project Structure

```
src/
├── extension.ts          # Activation, command registration, wiring
├── types.ts              # Shared TypeScript interfaces
├── pathResolver.ts       # Platform-aware prompts directory resolution
├── gitService.ts         # simple-git wrapper (clone, pull)
├── repositoryManager.ts  # Persistance + CRUD for registered repos
├── fileScanner.ts        # Walk repo tree, detect & categorise .md files
├── installationManager.ts# Copy files, track hashes, detect changes
├── syncManager.ts        # Orchestrate pull → scan → status reconcile
└── views/
    ├── treeProvider.ts   # VS Code TreeDataProvider implementation
    └── treeItems.ts      # TreeItem subclasses (repo, category, file)
```

---

## License

MIT
