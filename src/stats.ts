import * as vscode from "vscode";
import { ShadowCodexStore } from "./store";
import { ShadowEvent } from "./model";

export interface SessionStats {
  total: number;
  byKind: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  errors: number;
  warns: number;
}

export function computeStats(events: ShadowEvent[]): SessionStats {
  const byKind: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  let errors = 0;
  let warns = 0;

  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.severity === "error") errors += 1;
    if (e.severity === "warn") warns += 1;
    for (const t of e.tags) byTag[t] = (byTag[t] ?? 0) + 1;
  }

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));

  return { total: events.length, byKind, topTags, errors, warns };
}

export async function showSessionStats(store: ShadowCodexStore, sessionKey: string): Promise<void> {
  const events = store.getEvents(sessionKey);
  const stats = computeStats(events);

  const lines: string[] = [];
  lines.push(`Session: ${sessionKey}`);
  lines.push(`Total: ${stats.total}`);
  lines.push(`Errors: ${stats.errors}  Warns: ${stats.warns}`);
  lines.push(`Kinds: ${Object.entries(stats.byKind).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  lines.push(`Top tags: ${stats.topTags.map((t) => `${t.tag}=${t.count}`).join("  ")}`);

  await vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
}

