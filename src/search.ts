import * as vscode from "vscode";
import { ShadowCodexStore } from "./store";
import { TIMELINE_SCHEME, TimelineDocumentProvider } from "./timelineDocument";
import { ShadowEvent } from "./model";

export async function searchInSession(store: ShadowCodexStore, provider: TimelineDocumentProvider, sessionKey?: string): Promise<void> {
  const key = sessionKey ?? getActiveSessionKey() ?? (await pickSessionKey(store));
  if (!key) return;

  await store.warmSession(key);

  const query = await vscode.window.showInputBox({ prompt: "Search query", placeHolder: "keyword or regex (literal match)" });
  if (!query) return;

  const q = query.toLowerCase();
  const cache = store.getTranslationCache();
  const events = store.getEvents(key);
  const results = events
    .map((e) => ({ e, text: buildSearchText(e, cache).toLowerCase() }))
    .filter((x) => x.text.includes(q))
    .slice(0, 200);

  if (results.length === 0) {
    await vscode.window.showInformationMessage("No matches.");
    return;
  }

  const picks = results.map(({ e }) => ({
    label: `${e.kind}: ${e.title}`,
    description: e.ts ? new Date(e.ts).toLocaleTimeString() : "",
    detail: e.tags.join(", "),
    event: e
  }));

  const chosen = await vscode.window.showQuickPick(picks, { matchOnDescription: true, matchOnDetail: true, placeHolder: `Matches: ${results.length}` });
  if (!chosen) return;

  const uri = provider.openSession(key);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  revealEventInDocument(editor, chosen.event);
}

function buildSearchText(e: ShadowEvent, translationCache: Record<string, string>): string {
  let text = `${e.kind} ${e.title} ${JSON.stringify(e.details ?? {})}`;
  for (const [k, v] of Object.entries(translationCache)) {
    if (k.includes(e.id)) text += ` ${v}`;
  }
  return text;
}

function getActiveSessionKey(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== TIMELINE_SCHEME) return undefined;
  return decodeURIComponent(doc.uri.query || "");
}

async function pickSessionKey(store: ShadowCodexStore): Promise<string | undefined> {
  const sessions = store.getSessions();
  const picks = sessions.map((s) => ({
    label: s.cwd?.trim() || "(unknown cwd)",
    description: s.sessionId ? s.sessionId.slice(0, 12) : "",
    detail: s.sessionKey,
    sessionKey: s.sessionKey
  }));
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Select a session" });
  return chosen?.sessionKey;
}

function revealEventInDocument(editor: vscode.TextEditor, event: ShadowEvent): void {
  const headerNeedle = `- ${event.title}`;
  const text = editor.document.getText();
  let idx = text.indexOf(headerNeedle);
  if (idx < 0) idx = text.indexOf(event.title);
  if (idx < 0) return;

  const before = text.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length;
  const char = idx - (before.lastIndexOf("\n") + 1);
  const pos = new vscode.Position(line, Math.max(0, char));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

