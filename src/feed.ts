import { ShadowCodexStore } from "./store";
import { Translator } from "./translation";
import { ShadowEvent } from "./model";
import { foldText, summarizeOneLine } from "./utils";

export type TranslationState = "translated" | "pending" | "skipped";

export interface FeedPreview {
  label: string;
  text: string;
  folded: boolean;
  omittedLines: number;
  omittedChars: number;
}

export interface FeedItem {
  id: string;
  ts?: string;
  arrivedAt: string;
  kind: string;
  title: string;
  summary?: string;
  detailsPreview?: FeedPreview;
  tags: string[];
  severity: string;
  sessionId?: string;
  cwd?: string;
  translationKey?: string;
  translatedText?: string;
  translationState?: TranslationState;
}

export function buildFeedItems(events: ShadowEvent[], store: ShadowCodexStore, translator: Translator): FeedItem[] {
  const cfg = store.getConfig();
  const out: FeedItem[] = [];

  for (const e of events) {
    if (!isFeedKind(e.kind)) continue;
    const session = store.getSession(e.sessionKey);
    const base: FeedItem = {
      id: e.id,
      ts: e.ts,
      arrivedAt: new Date().toISOString(),
      kind: e.kind,
      title: e.title,
      tags: e.tags,
      severity: e.severity,
      sessionId: e.sessionId ?? session?.sessionId,
      cwd: session?.cwd
    };

    if (e.kind === "REASONING") {
      const text = coerceText((e.details as any)?.text);
      base.summary = summarizeOneLine(text, 200);
      base.detailsPreview = buildPreview("内容", text, cfg);
      const tr = translateIfNeeded(translator, e, text);
      if (tr) {
        base.translationKey = tr.key;
        base.translatedText = tr.text;
        base.translationState = tr.state;
      }
      out.push(base);
      continue;
    }

    if (e.kind === "TOOL_CALL") {
      const tool = (e.details as any)?.tool ?? {};
      const toolName = coerceText(tool?.name);
      const summary = summarizeToolCall(toolName, tool);
      if (summary && summary !== base.title) base.summary = summary;
      const argsText = extractArgsText(tool);
      if (argsText) base.detailsPreview = buildPreview("参数", argsText, cfg);
      out.push(base);
      continue;
    }

    if (e.kind === "TOOL_RESULT") {
      const tool = (e.details as any)?.tool ?? {};
      const toolName = coerceText(tool?.name);
      const output = tool?.outputRaw ?? tool?.output ?? "";
      const summary = summarizeToolResult(toolName, output);
      if (summary.summary) base.summary = summary.summary;
      if (summary.rawText) base.detailsPreview = buildPreview("输出", summary.rawText, cfg);
      if (summary.translateOk && summary.translateText) {
        const tr = translateIfNeeded(translator, e, summary.translateText);
        if (tr) {
          base.translationKey = tr.key;
          base.translatedText = tr.text;
          base.translationState = tr.state;
        }
      }
      out.push(base);
      continue;
    }

    if (e.kind === "ERROR") {
      const raw = JSON.stringify(e.details ?? {}, null, 2);
      base.summary = e.title;
      base.detailsPreview = buildPreview("详情", raw, cfg);
      out.push(base);
      continue;
    }
  }

  return out;
}

function isFeedKind(kind: string): boolean {
  return kind === "TOOL_CALL" || kind === "TOOL_RESULT" || kind === "ERROR" || kind === "REASONING";
}

function buildPreview(label: string, text: string, cfg: { foldThresholdChars: number; foldThresholdLines: number; forceFoldCodeBlocks: boolean }): FeedPreview {
  const folded = foldText(text, {
    maxChars: cfg.foldThresholdChars,
    maxLines: cfg.foldThresholdLines,
    forceFoldCodeBlocks: cfg.forceFoldCodeBlocks
  });
  return {
    label,
    text: folded.preview,
    folded: folded.folded,
    omittedLines: folded.omittedLines,
    omittedChars: folded.omittedChars
  };
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function extractArgsText(tool: any): string {
  if (typeof tool?.argsRaw === "string") return tool.argsRaw;
  if (tool?.args != null) {
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {
      return String(tool.args);
    }
  }
  return "";
}

function summarizeToolCall(toolName: string, tool: any): string {
  if (!toolName) return "";
  if (toolName === "shell_command") {
    const cmd = coerceText(tool?.args?.command ?? tool?.args?.cmd ?? tool?.argsRaw);
    return cmd || `shell_command`;
  }
  if (toolName.startsWith("mcp__")) {
    const [, server, method] = toolName.split("__");
    return `MCP ${server ?? "?"}.${method ?? "?"}`;
  }
  return `Tool ${toolName}`;
}

function summarizeToolResult(
  toolName: string,
  output: unknown
): { summary: string; rawText: string; translateOk: boolean; translateText: string } {
  const summaryLines: string[] = [];
  let rawText = "";
  let translateOk = false;
  let translateText = "";

  const asText = typeof output === "string" ? output : "";
  if (toolName === "shell_command" && asText) {
    const exitMatch = asText.match(/Exit code:\s*(\d+)/i);
    if (exitMatch) summaryLines.push(`Exit ${exitMatch[1]}`);
    const wallMatch = asText.match(/Wall time:\s*([^\r\n]+)/i);
    if (wallMatch) summaryLines.push(`Wall ${wallMatch[1].trim()}`);
    const outMatch = asText.match(/Output:\s*([\s\S]*)/i);
    rawText = outMatch ? outMatch[1].trim() : asText.trim();
    translateOk = true;
    translateText = rawText;
    return { summary: summaryLines.join(" · "), rawText, translateOk, translateText };
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
    if (obj.status != null) summaryLines.push(`Status ${String(obj.status)}`);
    if (obj.success != null) summaryLines.push(`Success ${String(obj.success)}`);
    if (obj.error != null) summaryLines.push(`Error ${String(obj.error)}`);
    if (obj.error_message != null) summaryLines.push(`Error ${String(obj.error_message)}`);
    if (obj.message != null) summaryLines.push(`Message ${String(obj.message)}`);
    if (obj.exit_code != null) summaryLines.push(`Exit ${String(obj.exit_code)}`);
    if (obj.duration != null) summaryLines.push(`Duration ${String(obj.duration)}`);

    rawText = JSON.stringify(obj, null, 2);
    translateOk = typeof obj.message === "string" || typeof obj.error === "string" || typeof obj.error_message === "string";
    translateText = String(obj.message ?? obj.error ?? obj.error_message ?? "");
    return { summary: summaryLines.join(" · "), rawText, translateOk, translateText };
  }

  rawText = typeof output === "string" ? output : JSON.stringify(output ?? "", null, 2);
  translateOk = typeof output === "string";
  translateText = rawText;
  return { summary: summaryLines.join(" · "), rawText, translateOk, translateText };
}

function translateIfNeeded(
  translator: Translator,
  event: ShadowEvent,
  text: string
): { key: string; text: string; state: TranslationState } | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const res = translator.translateOrEnqueue(event, text);
  if (res.state === "skipped") return undefined;
  const key = translator.getCacheKey(event, text);
  return { key, text: res.text, state: res.state };
}
