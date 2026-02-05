import * as path from "path";
import * as vscode from "vscode";
import { ShadowCodexStore } from "./store";
import { Translator } from "./translation";
import { buildFeedItems } from "./feed";
import { readConfig } from "./config";

interface DashboardFilters {
  onlyMcp: boolean;
  onlyShell: boolean;
  onlyError: boolean;
  showReasoning: boolean;
}

interface DashboardState {
  follow: boolean;
  filters: DashboardFilters;
}

const STATE_KEY = "shadowCodex.dashboard.state";

export class DashboardView implements vscode.Disposable {
  private static current: DashboardView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private state: DashboardState;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ShadowCodexStore,
    private readonly translator: Translator
  ) {
    this.state = loadState(context);
    this.createPanel();
    this.attachListeners();
  }

  static open(context: vscode.ExtensionContext, store: ShadowCodexStore, translator: Translator): DashboardView {
    if (DashboardView.current?.panel) {
      DashboardView.current.panel.reveal(vscode.ViewColumn.Active);
      DashboardView.current.postInit();
      return DashboardView.current;
    }
    DashboardView.current = new DashboardView(context, store, translator);
    return DashboardView.current;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    if (DashboardView.current === this) DashboardView.current = undefined;
  }

  refreshConfig(): void {
    this.postInit();
  }

  private attachListeners(): void {
    const storeSub = this.store.onDidAppendEvents((events) => {
      const items = buildFeedItems(events, this.store, this.translator);
      if (items.length === 0) return;
      this.postMessage({ type: "append", payload: items });
    });
    this.disposables.push(storeSub);

    const trSub = this.translator.onDidTranslate((evt) => {
      this.postMessage({ type: "translationUpdate", payload: evt });
    });
    this.disposables.push(trSub);
  }

  private createPanel(): void {
    const panel = vscode.window.createWebviewPanel(
      "shadowCodex.dashboard",
      "Shadow Codex",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
      }
    );
    this.panel = panel;

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);

    panel.webview.html = this.getHtml(panel.webview);
    this.postInit();
  }

  private postInit(): void {
    const cfg = readConfig();
    const payload = {
      maxItems: cfg.dashboardMaxItems,
      translationEnabled: cfg.translationEnabled,
      state: this.state
    };
    this.postMessage({ type: "init", payload });
  }

  private postMessage(message: unknown): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage(message);
  }

  private onMessage(message: any): void {
    if (!message || typeof message !== "object") return;
    if (message.type !== "uiAction") return;

    const action = message.action;
    if (action === "clearFeed") return;

    if (action === "toggleFollow") {
      const value = Boolean(message.value);
      this.state.follow = value;
      saveState(this.context, this.state);
      return;
    }

    if (action === "toggleTranslation") {
      const value = Boolean(message.value);
      const cfg = vscode.workspace.getConfiguration("shadowCodex.translation");
      void cfg.update("enabled", value, vscode.ConfigurationTarget.Global);
      return;
    }

    if (action === "updateFilters") {
      const next = message.value;
      if (next && typeof next === "object") {
        this.state.filters = {
          onlyMcp: Boolean(next.onlyMcp),
          onlyShell: Boolean(next.onlyShell),
          onlyError: Boolean(next.onlyError),
          showReasoning: next.showReasoning !== false
        };
        saveState(this.context, this.state);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "dashboard.css")));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "dashboard.js")));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} https://fonts.googleapis.com`,
      `font-src https://fonts.gstatic.com`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Shadow Codex</title>
  </head>
  <body>
    <div id="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-dot"></div>
          <div class="brand-title">Shadow Codex</div>
          <div class="brand-sub">Unified Live Feed</div>
        </div>
        <div class="controls">
          <button id="btn-follow" class="btn toggle">Follow</button>
          <button id="btn-translate" class="btn toggle">Translation</button>
          <button id="btn-clear" class="btn ghost">Clear</button>
        </div>
      </header>
      <section class="filterbar">
        <button id="filter-mcp" class="chip">MCP</button>
        <button id="filter-shell" class="chip">Shell</button>
        <button id="filter-error" class="chip">Errors</button>
        <button id="filter-reasoning" class="chip">Reasoning</button>
        <div class="status" id="status-text">Waiting for events…</div>
      </section>
      <main id="feed" class="feed"></main>
      <div id="resume" class="resume hidden">Resume Follow</div>
    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
  }
}

function loadState(context: vscode.ExtensionContext): DashboardState {
  const raw = context.globalState.get<DashboardState>(STATE_KEY);
  if (raw && raw.filters) return raw;
  return {
    follow: true,
    filters: {
      onlyMcp: false,
      onlyShell: false,
      onlyError: false,
      showReasoning: true
    }
  };
}

function saveState(context: vscode.ExtensionContext, state: DashboardState): void {
  void context.globalState.update(STATE_KEY, state);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

