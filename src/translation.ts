import * as http from "http";
import * as https from "https";
import * as vscode from "vscode";
import { URL } from "url";
import { ShadowCodexStore } from "./store";
import { ShadowEvent } from "./model";
import { looksLikeCodeBlock, safeJsonParse, sha1Hex } from "./utils";

interface PendingJob {
  key: string;
  endpoint: string;
  targetLang: string;
  text: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

interface HttpJsonResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json?: JsonValue;
}

export class Translator {
  private running = 0;
  private readonly queue: PendingJob[] = [];
  private readonly pendingKeys = new Set<string>();
  private readonly requestRefresh: () => void;
  private readonly output = vscode.window.createOutputChannel("Shadow Codex");
  private readonly onDidTranslateEmitter = new vscode.EventEmitter<{ key: string; text: string }>();
  readonly onDidTranslate = this.onDidTranslateEmitter.event;
  private lastError?: string;
  private lastErrorAt?: string;
  private lastSuccessAt?: string;
  private invalidEndpoint?: string;

  constructor(
    private readonly store: ShadowCodexStore,
    requestRefresh: () => void
  ) {
    this.requestRefresh = requestRefresh;
  }

  translateOrEnqueue(event: ShadowEvent, text: string): { text: string; state: "translated" | "pending" | "skipped" } {
    const cfg = this.store.getConfig();
    if (!cfg.translationEnabled) return { text, state: "skipped" };

    if (!shouldTranslate(text)) return { text, state: "skipped" };

    if (!isValidEndpoint(cfg.translationEndpoint)) {
      if (this.invalidEndpoint !== cfg.translationEndpoint) {
        this.invalidEndpoint = cfg.translationEndpoint;
        this.logDebug(`Invalid translation endpoint: ${cfg.translationEndpoint}`);
        this.lastError = "invalid_endpoint";
        this.lastErrorAt = new Date().toISOString();
      }
      return { text, state: "skipped" };
    }

    const cache = this.store.getTranslationCache();
    const key = this.getCacheKey(event, text);
    const hit = cache[key];
    if (hit) return { text: hit, state: "translated" };

    if (!this.pendingKeys.has(key)) {
      const maxQueue = Math.max(10, cfg.translationMaxQueue);
      if (this.queue.length >= maxQueue) {
        this.logDebug(`Translation queue full (${maxQueue}). Skipping new item.`);
        return { text, state: "skipped" };
      }

      this.pendingKeys.add(key);
      const payloadText = truncateForTranslate(text, cfg.translationMaxTextLength);
      this.queue.push({ key, endpoint: cfg.translationEndpoint, targetLang: cfg.translationTargetLang, text: payloadText });
      this.pump();
    }

    return { text: "(translating...)", state: "pending" };
  }

  getOrEnqueue(event: ShadowEvent, text: string): string {
    return this.translateOrEnqueue(event, text).text;
  }

  getCacheKey(event: ShadowEvent, text: string): string {
    return sha1Hex(`${event.sessionKey}:${event.id}:${text}`);
  }

  private pump(): void {
    if (this.running >= 1) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running += 1;
    this.runJob(job)
      .catch(() => undefined)
      .finally(() => {
        this.running -= 1;
        this.pendingKeys.delete(job.key);
        this.requestRefresh();
        this.pump();
      });
  }

  private async runJob(job: PendingJob): Promise<void> {
    const cfg = this.store.getConfig();
    const retries = Math.max(0, cfg.translationRetryCount);
    const delayBase = Math.max(100, cfg.translationRetryDelayMs);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const out = await translateThroughService(job.endpoint, job.text, job.targetLang, cfg.translationTimeoutMs);
        const cache = this.store.getTranslationCache();
        cache[job.key] = out;
        this.store.schedulePersistSave();
        this.lastSuccessAt = new Date().toISOString();
        this.onDidTranslateEmitter.fire({ key: job.key, text: out });
        return;
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        this.lastErrorAt = new Date().toISOString();
        this.logDebug(`Translation failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`);
        if (attempt < retries) {
          const retryAfterMs = getRetryAfterMsFromError(err);
          const delay = Math.max(retryAfterMs ?? 0, delayBase * Math.pow(2, attempt));
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return;
      }
    }
  }

  getStatus(): { enabled: boolean; pending: number; running: number; lastError?: string; lastErrorAt?: string; lastSuccessAt?: string } {
    const cfg = this.store.getConfig();
    return {
      enabled: cfg.translationEnabled,
      pending: this.queue.length,
      running: this.running,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastSuccessAt: this.lastSuccessAt
    };
  }

  private logDebug(message: string): void {
    const cfg = this.store.getConfig();
    if (!cfg.translationDebug) return;
    this.output.appendLine(`[translation] ${message}`);
  }
}

function shouldTranslate(text: string): boolean {
  if (!text.trim()) return false;
  if (looksLikeCodeBlock(text)) return false;
  const trimmed = text.trim();
  const json = safeJsonParse<any>(trimmed);
  if (json.ok && (trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 10) return false;
  return true;
}

function truncateForTranslate(text: string, maxLen: number): string {
  const max = Math.max(200, maxLen);
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function isValidEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getHeaderFirst(headers: http.IncomingHttpHeaders, key: string): string | undefined {
  const raw = headers[key.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function parseRetryAfterSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  const ms = ts - Date.now();
  if (ms <= 0) return 0;
  return ms / 1000;
}

async function requestJson(
  method: "GET" | "POST",
  endpoint: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<HttpJsonResponse> {
  const url = new URL(endpoint);
  const jsonBody = body ? JSON.stringify(body) : "";
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;

  const options: http.RequestOptions = {
    method,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: url.pathname + url.search,
    headers: {
      Accept: "application/json",
      ...(body
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(jsonBody)
          }
        : {})
    },
    timeout: Math.max(500, timeoutMs)
  };

  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = safeJsonParse<JsonValue>(text);
        const json = parsed.ok ? parsed.value : undefined;
        resolve({ status, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Translation request timeout"));
    });
    if (body) req.write(jsonBody);
    req.end();
  });
}

function getRetryAfterMsFromError(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const maybe = err as { retryAfterMs?: unknown };
  if (typeof maybe.retryAfterMs === "number" && Number.isFinite(maybe.retryAfterMs) && maybe.retryAfterMs >= 0) return maybe.retryAfterMs;
  return undefined;
}

function extractTranslatedText(payload: JsonValue | undefined): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, JsonValue>;
  const v = obj["translated_text"];
  return typeof v === "string" ? v : undefined;
}

function extractAcceptedJobId(payload: JsonValue | undefined): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, JsonValue>;
  if (obj["status"] !== "accepted") return undefined;
  const jobId = obj["job_id"];
  return typeof jobId === "string" ? jobId : undefined;
}

function buildError(status: number, resp: HttpJsonResponse): Error {
  let message = `HTTP ${status}`;
  let retryable = status === 429 || status === 503 || status === 504;
  let retryAfterMs: number | undefined;

  const headerRetryAfter = parseRetryAfterSeconds(getHeaderFirst(resp.headers, "retry-after"));
  if (typeof headerRetryAfter === "number") retryAfterMs = Math.max(0, Math.round(headerRetryAfter * 1000));

  if (resp.json && typeof resp.json === "object" && !Array.isArray(resp.json)) {
    const obj = resp.json as Record<string, JsonValue>;
    const code = typeof obj["error_code"] === "string" ? obj["error_code"] : undefined;
    const msg = typeof obj["message"] === "string" ? obj["message"] : undefined;
    const r = obj["retryable"];
    if (typeof r === "boolean") retryable = r;
    message = [message, code, msg].filter((x): x is string => typeof x === "string" && x.length > 0).join(": ");
  } else if (resp.text) {
    message = `${message}: ${resp.text.slice(0, 500)}`;
  }

  const e = new Error(message) as Error & { retryable?: boolean; retryAfterMs?: number };
  e.retryable = retryable;
  if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
  return e;
}

async function translateThroughService(endpoint: string, text: string, targetLang: string, timeoutMs: number): Promise<string> {
  const startedAt = Date.now();
  const postResp = await requestJson("POST", endpoint, { text, target_lang: targetLang }, timeoutMs);
  if (postResp.status >= 200 && postResp.status < 300) {
    const direct = extractTranslatedText(postResp.json);
    if (typeof direct === "string") return direct;

    const jobId = extractAcceptedJobId(postResp.json);
    if (jobId) {
      const url = new URL(endpoint);
      const base = `${url.protocol}//${url.host}`;
      const resultUrl = new URL(`/jobs/${jobId}/result`, base).toString();
      return await pollJobResult(resultUrl, timeoutMs - (Date.now() - startedAt));
    }
    throw new Error("Translation response missing translated_text");
  }
  throw buildError(postResp.status, postResp);
}

async function pollJobResult(resultEndpoint: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let delayMs = 500;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Translation async job timeout");

    const resp = await requestJson("GET", resultEndpoint, undefined, Math.min(remaining, 15_000));
    if (resp.status === 200) {
      const out = extractTranslatedText(resp.json);
      if (typeof out === "string") return out;
      throw new Error("Translation job result missing translated_text");
    }
    if (resp.status === 202) {
      await new Promise((r) => setTimeout(r, Math.min(delayMs, remaining)));
      delayMs = Math.min(4000, Math.round(delayMs * 1.5));
      continue;
    }
    throw buildError(resp.status, resp);
  }
}
