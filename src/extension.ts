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
import { DashboardView } from "./dashboardView";

let store: ShadowCodexStore | undefined;
let dashboard: DashboardView | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = new ShadowCodexStore(context);
  await store.start();

  let timelineProvider: TimelineDocumentProvider;
  const translator = new Translator(store, () => timelineProvider.refreshAll());
  timelineProvider = new TimelineDocumentProvider(store, translator);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TIMELINE_SCHEME, timelineProvider));

  const treeProvider = new SessionsTreeDataProvider(store);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("shadowCodex.sessionsView", treeProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.refreshSessions", async () => {
      await store?.rescanSessions();
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.openSession", async (sessionKey?: string) => {
      if (!store) return;
      const key = sessionKey ?? (await pickSessionKey(store));
      if (!key) return;
      await store.warmSession(key);
      const uri = timelineProvider.openSession(key);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      revealEndIfNeeded(editor);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shadowCodex.openDashboard", async () => {
      if (!store) return;
      dashboard = DashboardView.open(context, store, translator);
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
          dashboard?.refreshConfig();
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
