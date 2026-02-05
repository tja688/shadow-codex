import * as vscode from "vscode";
import { ShadowCodexStore } from "./store";
import { ShadowEvent } from "./model";

export async function exportSessionJson(store: ShadowCodexStore, sessionKey: string): Promise<void> {
  const session = store.getSession(sessionKey);
  const events = store.getEvents(sessionKey);
  const data = { session, events };
  const uri = await vscode.window.showSaveDialog({
    saveLabel: "Export",
    filters: { JSON: ["json"] },
    defaultUri: vscode.Uri.file("shadow-codex-session.json")
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), "utf8"));
}

export async function exportSessionMarkdown(store: ShadowCodexStore, sessionKey: string): Promise<void> {
  const session = store.getSession(sessionKey);
  const events = store.getEvents(sessionKey);
  const md = renderMarkdown(sessionKey, session?.cwd, events);
  const uri = await vscode.window.showSaveDialog({
    saveLabel: "Export",
    filters: { Markdown: ["md"] },
    defaultUri: vscode.Uri.file("shadow-codex-session.md")
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(md, "utf8"));
}

function renderMarkdown(sessionKey: string, cwd: string | undefined, events: ShadowEvent[]): string {
  const lines: string[] = [];
  lines.push(`# Shadow Codex Session`);
  lines.push("");
  lines.push(`- Session: ${sessionKey}`);
  if (cwd) lines.push(`- CWD: ${cwd}`);
  lines.push(`- Exported: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`## Timeline`);
  lines.push("");

  for (const e of events) {
    lines.push(`### ${e.kind} - ${e.title}`);
    if (e.ts) lines.push(`- Time: ${e.ts}`);
    if (e.tags.length) lines.push(`- Tags: ${e.tags.join(", ")}`);
    lines.push("");
    if (e.kind === "REASONING" || e.kind === "USER_MSG" || e.kind === "AGENT_MSG") {
      const t = String((e.details as any)?.text ?? "");
      lines.push("```text");
      lines.push(t);
      lines.push("```");
      lines.push("");
      continue;
    }
    if (e.kind === "TOOL_CALL") {
      const tool = (e.details as any)?.tool;
      lines.push("```json");
      lines.push(JSON.stringify(tool ?? e.details, null, 2));
      lines.push("```");
      lines.push("");
      continue;
    }
    if (e.kind === "TOOL_RESULT") {
      const tool = (e.details as any)?.tool;
      lines.push("```text");
      const out = tool?.outputRaw ?? tool?.output ?? "";
      lines.push(typeof out === "string" ? out : JSON.stringify(out, null, 2));
      lines.push("```");
      lines.push("");
      continue;
    }
    lines.push("```json");
    lines.push(JSON.stringify(e.details ?? {}, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

