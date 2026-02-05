import * as vscode from "vscode";
import { SessionInfo } from "./model";
import { ShadowCodexStore } from "./store";

type Node = CwdGroupNode | SessionNode;

class CwdGroupNode {
  readonly kind = "cwd";
  constructor(
    public readonly cwd: string,
    public readonly sessions: SessionInfo[]
  ) {}
}

class SessionNode {
  readonly kind = "session";
  constructor(public readonly session: SessionInfo) {}
}

export class SessionsTreeDataProvider implements vscode.TreeDataProvider<Node> {
  private onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly store: ShadowCodexStore) {
    this.store.onDidChangeSessions(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === "cwd") {
      const item = new vscode.TreeItem(element.cwd, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "shadowCodex.cwdGroup";
      return item;
    }

    const s = element.session;
    const label = s.sessionId ? s.sessionId.slice(0, 12) : "session";
    const desc = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = desc;
    item.tooltip = `${s.sessionId ?? ""}\n${s.cwd ?? ""}\n${s.sessionKey}`;
    item.command = {
      command: "shadowCodex.openSession",
      title: "Open Session",
      arguments: [s.sessionKey]
    };
    item.contextValue = "shadowCodex.session";
    return item;
  }

  getChildren(element?: Node): Thenable<Node[]> {
    if (!element) {
      return Promise.resolve(this.buildGroups());
    }
    if (element.kind === "cwd") {
      return Promise.resolve(element.sessions.map((s) => new SessionNode(s)));
    }
    return Promise.resolve([]);
  }

  private buildGroups(): Node[] {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of this.store.getSessions()) {
      const cwd = s.cwd?.trim() || "(unknown cwd)";
      const list = groups.get(cwd) ?? [];
      list.push(s);
      groups.set(cwd, list);
    }

    const cwdKeys = Array.from(groups.keys()).sort((a, b) => {
      const aSessions = groups.get(a) ?? [];
      const bSessions = groups.get(b) ?? [];
      const aLatest = aSessions.reduce((acc, s) => (!acc || (s.updatedAt && s.updatedAt > acc) ? s.updatedAt : acc), undefined as string | undefined) ?? "";
      const bLatest = bSessions.reduce((acc, s) => (!acc || (s.updatedAt && s.updatedAt > acc) ? s.updatedAt : acc), undefined as string | undefined) ?? "";
      if (aLatest !== bLatest) return bLatest.localeCompare(aLatest);
      return a.localeCompare(b);
    });

    return cwdKeys.map((cwd) => {
      const sessions = groups.get(cwd) ?? [];
      sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      return new CwdGroupNode(cwd, sessions);
    });
  }
}
