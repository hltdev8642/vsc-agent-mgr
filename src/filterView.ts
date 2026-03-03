import * as vscode from 'vscode';

/**
 * Provides a simple HTML input box in the sidebar tree container for
 * filtering repositories. The view sits above the main tree and communicates
 * with the extension via postMessage when the user types.
 */
export class FilterViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentManagerFilter';

  private _view?: vscode.WebviewView;
  private _pendingFocus = false;

  constructor(
    private readonly treeProvider: {
      setRepoFilter(filter: string): void;
      getRepoFilter(): string;
    }
  ) {}

  /**
   * Returns true when the embedded search UI is currently visible in the
   * sidebar. Useful for deciding whether we need to show a fallback input box.
   */
  public isVisible(): boolean {
    return !!(this._view && this._view.visible);
  }

  /**
   * programmatically show/focus the filter input
   */
  focus(): void {
    console.log('[FilterViewProvider] focus() called, viewExists=', !!this._view, ', pending=', this._pendingFocus);
    if (this._view) {
      // ensure the view is visible
      this._view.show?.(true);
      this._view.webview.postMessage({ command: 'doFocus' });
      this._pendingFocus = false;
      console.log('[FilterViewProvider] focused existing view, visible=', this._view.visible);
    } else {
      // view not created yet; remember to focus when it is
      this._pendingFocus = true;
      console.log('[FilterViewProvider] view not ready, queued focus');
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    console.log('[FilterViewProvider] resolveWebviewView called');
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    // send initial filter value so input remains in sync when the view is
    // recreated (e.g. if the user closes & reopens the sidebar)
    webviewView.webview.postMessage({
      command: 'setFilter',
      filter: this.treeProvider.getRepoFilter(),
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'filterChanged' && typeof msg.filter === 'string') {
        this.treeProvider.setRepoFilter(msg.filter);
      }
    });

    // apply focus request made while view was not ready
    if (this._pendingFocus) {
      this.focus();
    }
  }

  private getHtml(): string {
    const escapedPlaceholder = 'Type to filter repos...';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { padding: 4px; }
    input { width: 100%; box-sizing: border-box; }
  </style>
</head>
<body>
  <input type="text" id="filter" placeholder="${escapedPlaceholder}" autofocus />
  <script>
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('filter');
    input.addEventListener('input', () => {
      vscode.postMessage({ command: 'filterChanged', filter: input.value });
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'doFocus') {
        input.focus();
      } else if (msg.command === 'setFilter') {
        input.value = msg.filter || '';
      }
    });
  </script>
</body>
</html>`;
  }
}
