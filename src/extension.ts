import * as path from "path";
import * as vscode from "vscode";
import { readConfig } from "./config";
import { ShadowCodexStore } from "./store";
import { SessionsTreeDataProvider } from "./sessionTree";
import { TimelineDocumentProvider, TIMELINE_SCHEME } from "./timelineDocument";
import { Translator } from "./translation";
import { exportSessionJson, exportSessionMarkdown } from "./export";
import { searchInSession } from "./search";
import { showSessionStats } from "./stats";
import { DashboardViewProvider } from "./dashboardView";

let store: ShadowCodexStore | undefined;
let dashboardViewProvider: DashboardViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel("Shadow Codex");
  context.subscriptions.push(out);
  out.appendLine(`[activate] ${new Date().toISOString()}`);
  await vscode.commands.executeCommand("setContext", "shadowCodex.sessionsViewVisible", false);

  store = new ShadowCodexStore(context);

  let timelineProvider: TimelineDocumentProvider;
  const translator = new Translator(store, () => timelineProvider.refreshAll());
  timelineProvider = new TimelineDocumentProvider(store, translator);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TIMELINE_SCHEME, timelineProvider));

  const treeProvider = new SessionsTreeDataProvider(store);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("shadowCodex.sessionsView", treeProvider));

  dashboardViewProvider = new DashboardViewProvider(context, store, translator);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("shadowCodex.dashboardView", dashboardViewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  context.subscriptions.push(dashboardViewProvider);

  void store.start().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    out.appendLine(`[activate] store.start failed: ${msg}`);
    void vscode.window.showWarningMessage(`Shadow Codex 启动失败：${msg}（仍会显示 Dashboard，但会话索引可能为空）`);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.refreshSessions", async () => {
      try {
        await store?.rescanSessions();
        treeProvider.refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        out.appendLine(`[cmd] refreshSessions failed: ${msg}`);
        await vscode.window.showErrorMessage(`刷新会话失败：${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.openSession", async (sessionKey?: string) => {
      if (!store) return;
      const key = sessionKey ?? (await pickSessionKey(store));
      if (!key) return;
      await openSessionByKey(key, timelineProvider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.openLatestSession", async () => {
      if (!store) return;
      const latest = store.getLatestSession();
      if (!latest) {
        await vscode.window.showInformationMessage("No sessions found.");
        return;
      }
      await openSessionByKey(latest.sessionKey, timelineProvider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.openDashboard", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.shadowCodex");
      try {
        await vscode.commands.executeCommand("shadowCodex.dashboardView.focus");
      } catch {
        await vscode.commands.executeCommand("workbench.action.openView", "shadowCodex.dashboardView");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.showSessionsView", async () => {
      await vscode.commands.executeCommand("setContext", "shadowCodex.sessionsViewVisible", true);
      try {
        await vscode.commands.executeCommand("shadowCodex.sessionsView.focus");
      } catch {
        await vscode.commands.executeCommand("workbench.action.openView", "shadowCodex.sessionsView");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.openRolloutFile", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Open rollout JSONL",
        filters: { "Codex rollout": ["jsonl"] }
      });
      if (!picked || picked.length === 0) return;
      const filePath = picked[0].fsPath;
      const sessionKey = path.dirname(filePath);
      await store?.warmRolloutFile(filePath);
      const uri = timelineProvider.openSession(sessionKey);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      revealEndIfNeeded(editor);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.toggleFollowMode", async () => {
      const cfg = vscode.workspace.getConfiguration("shadowCodex");
      const cur = cfg.get<boolean>("followMode") ?? true;
      await cfg.update("followMode", !cur, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.toggleTranslation", async () => {
      const cfg = vscode.workspace.getConfiguration("shadowCodex.translation");
      const cur = cfg.get<boolean>("enabled") ?? false;
      await cfg.update("enabled", !cur, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.toggleOnlyMcp", async () => {
      const cfg = vscode.workspace.getConfiguration("shadowCodex.filter");
      const cur = cfg.get<boolean>("onlyMcp") ?? false;
      await cfg.update("onlyMcp", !cur, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.toggleOnlyShell", async () => {
      const cfg = vscode.workspace.getConfiguration("shadowCodex.filter");
      const cur = cfg.get<boolean>("onlyShell") ?? false;
      await cfg.update("onlyShell", !cur, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.toggleOnlyErrors", async () => {
      const cfg = vscode.workspace.getConfiguration("shadowCodex.filter");
      const cur = cfg.get<boolean>("onlyErrors") ?? false;
      await cfg.update("onlyErrors", !cur, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.exportSessionJson", async () => {
      if (!store) return;
      const key = getActiveSessionKey() ?? (await pickSessionKey(store));
      if (!key) return;
      await store.warmSession(key);
      await exportSessionJson(store, key);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.exportSessionMarkdown", async () => {
      if (!store) return;
      const key = getActiveSessionKey() ?? (await pickSessionKey(store));
      if (!key) return;
      await store.warmSession(key);
      await exportSessionMarkdown(store, key);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.searchInSession", async () => {
      if (!store) return;
      await searchInSession(store, timelineProvider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.showSessionStats", async () => {
      if (!store) return;
      const key = getActiveSessionKey() ?? (await pickSessionKey(store));
      if (!key) return;
      await store.warmSession(key);
      await showSessionStats(store, key);
    })
  );

  vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration("shadowCodex")) {
        void (async () => {
          await store?.reloadAfterConfigChange();
          treeProvider.refresh();
          timelineProvider.refreshAll();
          dashboardViewProvider?.refreshConfig();
        })();
      }
    },
    undefined,
    context.subscriptions
  );

  store.onDidChangeSessionEvents(
    () => {
      const cfg = readConfig();
      if (!cfg.followMode) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== TIMELINE_SCHEME) return;
      revealEndIfNeeded(editor);
    },
    undefined,
    context.subscriptions
  );
}

export async function deactivate(): Promise<void> {
  await store?.stop();
  store = undefined;
}

async function pickSessionKey(s: ShadowCodexStore): Promise<string | undefined> {
  const sessions = s.getSessions();
  const picks = sessions.map((sess) => {
    const label = sess.sessionId ? sess.sessionId.slice(0, 12) : path.basename(sess.sessionKey);
    const description = sess.cwd ?? "";
    const detail = sess.updatedAt ? new Date(sess.updatedAt).toLocaleString() : "";
    return { label, description, detail, sessionKey: sess.sessionKey };
  });
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Select a session" });
  return chosen?.sessionKey;
}

function getActiveSessionKey(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== TIMELINE_SCHEME) return undefined;
  return decodeURIComponent(doc.uri.query || "");
}

function revealEndIfNeeded(editor: vscode.TextEditor): void {
  const lastLine = Math.max(0, editor.document.lineCount - 1);
  const last = editor.document.lineAt(lastLine);
  const range = new vscode.Range(last.range.end, last.range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openSessionByKey(key: string, timelineProvider: TimelineDocumentProvider): Promise<void> {
  if (!store) return;
  await store.warmSession(key);
  const uri = timelineProvider.openSession(key);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  revealEndIfNeeded(editor);
}
