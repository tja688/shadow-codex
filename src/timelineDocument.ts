import * as vscode from "vscode";
import { ShadowCodexStore } from "./store";
import { ShadowEvent } from "./model";
import { foldText, splitLines } from "./utils";
import { Translator } from "./translation";

export const TIMELINE_SCHEME = "shadowcodex";

export class TimelineDocumentProvider implements vscode.TextDocumentContentProvider {
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private openSessionByUri = new Map<string, string>();
  private lastRefreshByUri = new Map<string, number>();
  private pendingRefreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: ShadowCodexStore,
    private readonly translator: Translator
  ) {
    this.store.onDidChangeSessionEvents((sessionKey) => {
      for (const [uri, key] of this.openSessionByUri.entries()) {
        if (key === sessionKey) this.scheduleRefresh(uri);
      }
    });
  }

  refreshAll(): void {
    for (const uri of this.openSessionByUri.keys()) {
      this.scheduleRefresh(uri);
    }
  }

  refreshSession(sessionKey: string): void {
    for (const [uri, key] of this.openSessionByUri.entries()) {
      if (key === sessionKey) this.scheduleRefresh(uri);
    }
  }

  openSession(sessionKey: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: TIMELINE_SCHEME,
      path: "/timeline",
      query: encodeURIComponent(sessionKey)
    });
    this.openSessionByUri.set(uri.toString(), sessionKey);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const sessionKey = decodeURIComponent(uri.query || "");
    const cfg = this.store.getConfig();
    const events = this.store.getEvents(sessionKey);

    const visible = events.filter((e) => {
      if (e.kind === "AGENT_MSG" && !cfg.showAgentMessage) return false;
      if (e.kind === "META") return false;
      if (cfg.filterOnlyErrors) {
        if (e.severity === "info" && e.kind !== "ERROR") return false;
      }
      if (cfg.filterOnlyMcp) {
        if (!e.tags.includes("mcp")) return false;
      }
      if (cfg.filterOnlyShell) {
        if (!(e.tags.includes("shell") || e.tags.includes("tool") && e.tags.includes("shell"))) return false;
      }
      return true;
    });

    const lines: string[] = [];
    lines.push(`Shadow Codex Timeline`);
    lines.push(`Session: ${sessionKey}`);
    lines.push(`Events: ${visible.length}`);
    const tStatus = this.translator.getStatus();
    if (tStatus.enabled) {
      const parts = [`翻译: 启用`, `pending=${tStatus.pending}`];
      if (tStatus.running > 0) parts.push(`running=${tStatus.running}`);
      if (tStatus.lastError) parts.push(`last_error=${tStatus.lastError}`);
      if (tStatus.lastErrorAt) parts.push(`last_error_at=${tStatus.lastErrorAt}`);
      lines.push(parts.join(" | "));
    } else {
      lines.push(`翻译: 禁用`);
    }
    lines.push("");

    const renderItems = this.buildRenderItems(visible);
    for (const item of renderItems) {
      lines.push("────────────────────────────────────────");
      if (item.kind === "single") {
        lines.push(
          ...this.formatEvent(
            item.event,
            cfg.foldThresholdChars,
            cfg.foldThresholdLines,
            cfg.forceFoldCodeBlocks,
            cfg.translationEnabled,
            cfg.translationShowOriginalCollapsed
          )
        );
        lines.push("");
        continue;
      }

      lines.push(
        ...this.formatCallBlock(
          item.call,
          item.result,
          cfg.foldThresholdChars,
          cfg.foldThresholdLines,
          cfg.forceFoldCodeBlocks,
          cfg.translationEnabled,
          cfg.translationShowOriginalCollapsed
        )
      );
      lines.push("");
    }
    return lines.join("\n");
  }

  private buildRenderItems(events: ShadowEvent[]): Array<{ kind: "single"; event: ShadowEvent } | { kind: "callBlock"; call: ShadowEvent; result?: ShadowEvent }> {
    const resultsByCallId = new Map<string, ShadowEvent>();
    for (const e of events) {
      if (e.kind === "TOOL_RESULT" && e.relatedCallId) resultsByCallId.set(e.relatedCallId, e);
    }

    const consumed = new Set<string>();
    const out: Array<{ kind: "single"; event: ShadowEvent } | { kind: "callBlock"; call: ShadowEvent; result?: ShadowEvent }> = [];

    for (const e of events) {
      if (consumed.has(e.id)) continue;
      if (e.kind === "TOOL_CALL" && e.relatedCallId) {
        const result = resultsByCallId.get(e.relatedCallId);
        if (result) consumed.add(result.id);
        out.push({ kind: "callBlock", call: e, result });
        continue;
      }
      out.push({ kind: "single", event: e });
    }
    return out;
  }

  private formatCallBlock(
    call: ShadowEvent,
    result: ShadowEvent | undefined,
    maxChars: number,
    maxLines: number,
    forceFoldCodeBlocks: boolean,
    translationEnabled: boolean,
    showOriginalCollapsed: boolean
  ): string[] {
    const out: string[] = [];
    out.push(...this.formatEvent(call, maxChars, maxLines, forceFoldCodeBlocks, translationEnabled, showOriginalCollapsed));
    if (result) {
      out.push("Result:");
      const formatted = this.formatEvent(result, maxChars, maxLines, forceFoldCodeBlocks, translationEnabled, showOriginalCollapsed);
      out.push(...formatted.map((l) => `  ${l}`));
    }
    return out;
  }

  private formatEvent(
    e: ShadowEvent,
    maxChars: number,
    maxLines: number,
    forceFoldCodeBlocks: boolean,
    translationEnabled: boolean,
    showOriginalCollapsed: boolean
  ): string[] {
    const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
    const tags = e.tags.length ? ` [${e.tags.join(",")}]` : "";
    const header = `${ts} ${e.kind}${tags} - ${e.title}`;
    const out: string[] = [header];
    if (e.severity !== "info") out.push(`Severity: ${e.severity}`);
    if (e.relatedCallId) out.push(`CallId: ${e.relatedCallId}`);

    if (e.kind === "REASONING" || e.kind === "USER_MSG" || e.kind === "AGENT_MSG") {
      const text = String((e.details as any)?.text ?? "");
      const folded = foldText(text, { maxChars, maxLines, forceFoldCodeBlocks });

      const tr = translationEnabled ? this.translator.translateOrEnqueue(e, text) : { text, state: "skipped" as const };
      if (tr.state !== "skipped") {
        out.push("译文:");
        out.push(...splitLines(tr.text).map((l) => `  ${l}`));
        out.push("原文:");
        if (showOriginalCollapsed) {
          const first = splitLines(folded.preview)[0] ?? "";
          out.push(`  ${first}`);
          out.push("  [original collapsed]");
          return out;
        }
      }

      out.push("内容:");
      out.push(...splitLines(folded.preview).map((l) => `  ${l}`));
      if (folded.folded) {
        out.push(`  [folded: ${folded.omittedLines} lines, ${folded.omittedChars} chars omitted]`);
      }
      return out;
    }

    if (e.kind === "TOOL_CALL") {
      const tool = (e.details as any)?.tool;
      if (tool) {
        if (tool.name) out.push(`工具: ${tool.name}`);
        if (tool.argsRaw) {
          const folded = foldText(String(tool.argsRaw), { maxChars, maxLines, forceFoldCodeBlocks });
          out.push("参数:");
          out.push(...splitLines(folded.preview).map((l) => `  ${l}`));
          if (folded.folded) out.push(`  [folded: ${folded.omittedLines} lines, ${folded.omittedChars} chars omitted]`);
        } else if (tool.args != null) {
          const raw = JSON.stringify(tool.args, null, 2);
          const folded = foldText(raw, { maxChars, maxLines, forceFoldCodeBlocks });
          out.push("参数:");
          out.push(...splitLines(folded.preview).map((l) => `  ${l}`));
          if (folded.folded) out.push(`  [folded: ${folded.omittedLines} lines, ${folded.omittedChars} chars omitted]`);
        }
      }
      const shell = (e.details as any)?.shell;
      if (shell?.command) out.push(`命令: ${shell.command}`);
      const mcp = (e.details as any)?.mcp;
      if (mcp?.server || mcp?.method) {
        out.push(`MCP: ${mcp.server ?? "?"}.${mcp.method ?? "?"}`);
      }
      if (mcp && Array.isArray(mcp.actions) && mcp.actions.length > 0) {
        out.push("动作:");
        for (const a of mcp.actions) out.push(`  - ${a}`);
        if (typeof mcp.actionsTruncated === "number" && mcp.actionsTruncated > 0) {
          out.push(`  [${mcp.actionsTruncated} more omitted]`);
        }
      }
      return out;
    }

    if (e.kind === "TOOL_RESULT") {
      const tool = (e.details as any)?.tool;
      if (tool?.name) out.push(`工具: ${tool.name}`);
      const output = tool?.outputRaw ?? tool?.output ?? "";
      const summary = summarizeToolOutput(tool?.name ?? "", output);
      for (const line of summary.summaryLines) out.push(line);

      const text = summary.rawText;
      const folded = foldText(text, { maxChars, maxLines, forceFoldCodeBlocks });

      const tr =
        translationEnabled && summary.translateOk ? this.translator.translateOrEnqueue(e, summary.translateText) : { text: text, state: "skipped" as const };
      if (tr.state !== "skipped") {
        out.push("译文:");
        out.push(...splitLines(tr.text).map((l) => `  ${l}`));
        out.push("原文:");
        if (showOriginalCollapsed) {
          const first = splitLines(folded.preview)[0] ?? "";
          out.push(`  ${first}`);
          out.push("  [original collapsed]");
          return out;
        }
      }

      out.push("输出:");
      out.push(...splitLines(folded.preview).map((l) => `  ${l}`));
      if (folded.folded) {
        out.push(`  [folded: ${folded.omittedLines} lines, ${folded.omittedChars} chars omitted]`);
      }
      return out;
    }

    if (e.kind === "ERROR") {
      const raw = JSON.stringify(e.details ?? {}, null, 2);
      const folded = foldText(raw, { maxChars, maxLines, forceFoldCodeBlocks });
      out.push("详情:");
      out.push(...splitLines(folded.preview).map((l) => `  ${l}`));
      if (folded.folded) out.push(`  [folded: ${folded.omittedLines} lines, ${folded.omittedChars} chars omitted]`);
      return out;
    }

    return out;
  }

  private scheduleRefresh(uri: string): void {
    const now = Date.now();
    const minInterval = Math.max(200, this.store.getConfig().uiRefreshIntervalMs);
    const last = this.lastRefreshByUri.get(uri) ?? 0;
    const elapsed = now - last;

    if (elapsed >= minInterval) {
      this.lastRefreshByUri.set(uri, now);
      this.onDidChangeEmitter.fire(vscode.Uri.parse(uri));
      return;
    }

    if (this.pendingRefreshTimers.has(uri)) return;
    const delay = minInterval - elapsed;
    const timer = setTimeout(() => {
      this.pendingRefreshTimers.delete(uri);
      this.lastRefreshByUri.set(uri, Date.now());
      this.onDidChangeEmitter.fire(vscode.Uri.parse(uri));
    }, delay);
    this.pendingRefreshTimers.set(uri, timer);
  }
}

function summarizeToolOutput(
  toolName: string,
  output: unknown
): { summaryLines: string[]; rawText: string; translateOk: boolean; translateText: string } {
  const summaryLines: string[] = [];
  let rawText = "";
  let translateOk = false;
  let translateText = "";

  const asText = typeof output === "string" ? output : "";
  if (toolName === "shell_command" && asText) {
    const exitMatch = asText.match(/Exit code:\s*(\d+)/i);
    if (exitMatch) summaryLines.push(`Exit: ${exitMatch[1]}`);
    const wallMatch = asText.match(/Wall time:\s*([^\r\n]+)/i);
    if (wallMatch) summaryLines.push(`Wall: ${wallMatch[1].trim()}`);
    const outMatch = asText.match(/Output:\s*([\s\S]*)/i);
    rawText = outMatch ? outMatch[1].trim() : asText.trim();
    translateOk = true;
    translateText = rawText;
    return { summaryLines, rawText, translateOk, translateText };
  }

  let obj: any = undefined;
  if (typeof output === "string") {
    try {
      obj = JSON.parse(output);
    } catch {
      obj = undefined;
    }
  } else if (output && typeof output === "object") {
    obj = output;
  }

  if (obj && typeof obj === "object") {
    if (obj.status != null) summaryLines.push(`Status: ${String(obj.status)}`);
    if (obj.success != null) summaryLines.push(`Success: ${String(obj.success)}`);
    if (obj.error != null) summaryLines.push(`Error: ${String(obj.error)}`);
    if (obj.error_message != null) summaryLines.push(`Error: ${String(obj.error_message)}`);
    if (obj.message != null) summaryLines.push(`Message: ${String(obj.message)}`);
    if (obj.exit_code != null) summaryLines.push(`Exit: ${String(obj.exit_code)}`);
    if (obj.duration != null) summaryLines.push(`Duration: ${String(obj.duration)}`);

    rawText = JSON.stringify(obj, null, 2);
    translateOk = typeof obj.message === "string" || typeof obj.error === "string" || typeof obj.error_message === "string";
    translateText = String(obj.message ?? obj.error ?? obj.error_message ?? "");
    return { summaryLines, rawText, translateOk, translateText };
  }

  rawText = typeof output === "string" ? output : JSON.stringify(output ?? "", null, 2);
  translateOk = typeof output === "string";
  translateText = rawText;
  return { summaryLines, rawText, translateOk, translateText };
}
