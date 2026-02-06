import * as path from "path";
import * as vscode from "vscode";
import { DebugEvent, ShadowCodexStore, StoreDebugSnapshot } from "./store";
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

interface DashboardCommandItem {
  id: string;
  label: string;
  description?: string;
  primary?: boolean;
}

const STATE_KEY = "shadowCodex.dashboard.state";

const DASHBOARD_COMMANDS: DashboardCommandItem[] = [
  {
    id: "shadowCodex.openLatestSession",
    label: "🚀 启动 Shadow Codex (最新会话)",
    description: "立即打开最近活跃的 Web View 时间线视图",
    primary: true
  },
  {
    id: "shadowCodex.openSession",
    label: "🔍 选择会话...",
    description: "从历史记录中选择一个特定会话打开"
  },
  {
    id: "shadowCodex.openRolloutFile",
    label: "📂 打开本地 Rollout 文件",
    description: "加载并查看本地的 rollout JSONL 文件"
  },
  {
    id: "shadowCodex.searchInSession",
    label: "🔍 在会话中搜索",
    description: "在当前活动会话的时间线中快速搜寻"
  },
  {
    id: "shadowCodex.showSessionStats",
    label: "📊 查看会话统计",
    description: "查看当前会话的 Token、耗时等统计信息"
  },
  {
    id: "shadowCodex.refreshSessions",
    label: "🔄 刷新会话列表",
    description: "重新扫描本地存储，寻找新的会话记录"
  },
  {
    id: "shadowCodex.exportSessionMarkdown",
    label: "📝 导出为 Markdown",
    description: "将当前会话导出为易于阅读的文档"
  },
  {
    id: "shadowCodex.exportSessionJson",
    label: "💾 导出为 JSON",
    description: "保存原始数据以供后续分析"
  },
  {
    id: "shadowCodex.toggleFollowMode",
    label: "🎯 切换跟随模式",
    description: "自动跳转到时间线最新事件"
  },
  {
    id: "shadowCodex.toggleTranslation",
    label: "🌐 切换翻译功能",
    description: "开启/关闭 AI 推理过程的本地翻译"
  }
];

class DashboardController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webviewDisposables: vscode.Disposable[] = [];
  private webview: vscode.Webview | undefined;
  private state: DashboardState;
  private debugSnapshot: StoreDebugSnapshot;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ShadowCodexStore,
    private readonly translator: Translator
  ) {
    this.state = loadState(context);
    this.debugSnapshot = store.getDebugSnapshot();
    this.attachListeners();
  }

  dispose(): void {
    this.detachWebview();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  attachWebview(webview: vscode.Webview): void {
    this.webview = webview;
    this.resetWebview();
  }

  detachWebview(): void {
    for (const d of this.webviewDisposables) d.dispose();
    this.webviewDisposables.length = 0;
    this.webview = undefined;
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
      this.postDebugStatus();
    });
    this.disposables.push(trSub);

    const dbgSub = this.store.onDidDebug((evt) => {
      this.debugSnapshot = this.store.getDebugSnapshot();
      this.postDebug(evt);
    });
    this.disposables.push(dbgSub);
  }

  private resetWebview(): void {
    if (!this.webview) return;
    for (const d of this.webviewDisposables) d.dispose();
    this.webviewDisposables.length = 0;

    this.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.webviewDisposables);
    this.webview.html = this.getHtml(this.webview);
    this.postInit();
  }

  private postInit(): void {
    const cfg = readConfig();
    const payload = {
      maxItems: cfg.dashboardMaxItems,
      translationEnabled: cfg.translationEnabled,
      state: this.state,
      commands: DASHBOARD_COMMANDS
    };
    this.postMessage({ type: "init", payload });
    this.postDebugStatus();
  }

  private postMessage(message: unknown): void {
    if (!this.webview) return;
    void this.webview.postMessage(message);
  }

  private postDebug(evt?: DebugEvent): void {
    this.postMessage({
      type: "debug",
      payload: {
        event: evt,
        snapshot: this.debugSnapshot,
        translation: this.translator.getStatus()
      }
    });
  }

  private postDebugStatus(): void {
    this.debugSnapshot = this.store.getDebugSnapshot();
    this.postMessage({
      type: "debugStatus",
      payload: {
        snapshot: this.debugSnapshot,
        translation: this.translator.getStatus()
      }
    });
  }

  private onMessage(message: any): void {
    if (!message || typeof message !== "object") return;

    if (message.type === "runCommand") {
      const commandId = message.command;
      if (typeof commandId !== "string") return;
      if (!DASHBOARD_COMMANDS.some((c) => c.id === commandId)) return;
      void vscode.commands.executeCommand(commandId);
      return;
    }

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
          <button id="btn-debug" class="btn toggle">Debug</button>
          <button id="btn-clear" class="btn ghost">Clear</button>
        </div>
      </header>
      <section class="commandbar">
        <div class="commandbar-title">Quick Actions</div>
        <div id="command-primary" class="command-primary"></div>
        <div id="command-list" class="command-list"></div>
      </section>
      <section class="filterbar">
        <button id="filter-mcp" class="chip">MCP</button>
        <button id="filter-shell" class="chip">Shell</button>
        <button id="filter-error" class="chip">Errors</button>
        <button id="filter-reasoning" class="chip">Reasoning</button>
        <div class="status" id="status-text">Waiting for events…</div>
      </section>
      <section id="debug-panel" class="debug hidden">
        <div class="debug-header">
          <div>
            <div class="debug-title">Debug Panel</div>
            <div class="debug-sub" id="debug-meta">idle</div>
          </div>
          <div class="debug-actions">
            <button id="btn-debug-clear" class="btn ghost small">Clear Log</button>
          </div>
        </div>
        <div class="debug-grid">
          <div class="debug-card">
            <div class="debug-card-title">Watcher</div>
            <div id="debug-watcher" class="debug-lines"></div>
          </div>
          <div class="debug-card">
            <div class="debug-card-title">Parser</div>
            <div id="debug-parser" class="debug-lines"></div>
          </div>
          <div class="debug-card">
            <div class="debug-card-title">Sessions</div>
            <div id="debug-sessions" class="debug-lines"></div>
          </div>
          <div class="debug-card">
            <div class="debug-card-title">Translation</div>
            <div id="debug-translation" class="debug-lines"></div>
          </div>
        </div>
        <div class="debug-log">
          <div class="debug-log-title">Activity</div>
          <div id="debug-log"></div>
        </div>
      </section>
      <main id="feed" class="feed"></main>
      <div class="floating-actions">
        <button id="btn-top" class="float-btn small hidden" title="Back to top">Top</button>
        <button id="resume" class="float-btn resume hidden">Resume Follow</button>
      </div>
    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
  }
}

export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly dashboard: DashboardController;

  constructor(
    private readonly context: vscode.ExtensionContext,
    store: ShadowCodexStore,
    translator: Translator
  ) {
    this.dashboard = new DashboardController(context, store, translator);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    this.dashboard.attachWebview(webviewView.webview);
    webviewView.onDidDispose(
      () => {
        this.dashboard.detachWebview();
      },
      null,
      this.disposables
    );
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) this.dashboard.refreshConfig();
      },
      null,
      this.disposables
    );
  }

  refreshConfig(): void {
    this.dashboard.refreshConfig();
  }

  dispose(): void {
    this.dashboard.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function loadState(context: vscode.ExtensionContext): DashboardState {
  return getDefaultState();
}

function saveState(context: vscode.ExtensionContext, state: DashboardState): void {
  void context.globalState.update(STATE_KEY, state);
}

function getDefaultState(): DashboardState {
  return {
    follow: true,
    filters: {
      onlyMcp: true,
      onlyShell: true,
      onlyError: true,
      showReasoning: true
    }
  };
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
