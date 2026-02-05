import * as crypto from "crypto";

export function sha1Hex(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value == null) return undefined;
  return String(value);
}

export function safeJsonParse<T = unknown>(text: unknown): { ok: true; value: T } | { ok: false; error: Error } {
  if (typeof text !== "string") {
    return { ok: true, value: text as T };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e: any) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export interface FoldResult {
  folded: boolean;
  preview: string;
  omittedChars: number;
  omittedLines: number;
}

export function looksLikeCodeBlock(text: string): boolean {
  if (text.includes("```")) return true;
  const lines = splitLines(text);
  let score = 0;
  for (const line of lines.slice(0, 200)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(using |import |from |class |function |public |private |protected |namespace )/i.test(trimmed)) score += 2;
    if (/[{};]/.test(trimmed)) score += 1;
    if (/=>|<\/?[A-Za-z][^>]*>/.test(trimmed)) score += 1;
    if (/^\s*(Get-Content|rg|grep|findstr|cat|type)\b/i.test(trimmed)) score += 1;
    if (trimmed.length > 160 && /[{};]/.test(trimmed)) score += 1;
    if (score >= 8) return true;
  }
  return false;
}

export function foldText(
  text: string,
  opts: { maxChars: number; maxLines: number; forceFoldCodeBlocks: boolean }
): FoldResult {
  const lines = splitLines(text);
  const shouldForceFold = opts.forceFoldCodeBlocks && looksLikeCodeBlock(text);

  if (!shouldForceFold && text.length <= opts.maxChars && lines.length <= opts.maxLines) {
    return { folded: false, preview: text, omittedChars: 0, omittedLines: 0 };
  }

  const previewLines = lines.slice(0, Math.min(20, lines.length));
  const preview = previewLines.join("\n");
  const omittedLines = Math.max(0, lines.length - previewLines.length);
  const omittedChars = Math.max(0, text.length - preview.length);
  return { folded: true, preview, omittedChars, omittedLines };
}

export function debounce<T extends (...args: any[]) => void>(fn: T, waitMs: number): T {
  let timer: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  }) as T;
}

export function throttle<T extends (...args: any[]) => void>(fn: T, waitMs: number): T {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  let pendingArgs: any[] | undefined;
  return ((...args: any[]) => {
    const now = Date.now();
    const remaining = waitMs - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
      return;
    }
    pendingArgs = args;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      last = Date.now();
      const a = pendingArgs;
      pendingArgs = undefined;
      if (a) fn(...a);
    }, remaining);
  }) as T;
}

export function toIso(ts: unknown): string | undefined {
  if (typeof ts !== "string") return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function summarizeOneLine(text: string, maxLen: number): string {
  const first = splitLines(text).find((l) => l.trim().length > 0) ?? "";
  const trimmed = first.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, Math.max(0, maxLen - 1)) + "…";
}

