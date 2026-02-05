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
    const maxConcurrency = Math.max(1, Math.min(5, this.store.getConfig().translationMaxConcurrency));
    if (this.running >= maxConcurrency) return;
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
        const translated = await postJson(job.endpoint, { text: job.text, target_lang: job.targetLang }, cfg.translationTimeoutMs);
        const out = typeof translated?.translated_text === "string" ? translated.translated_text : undefined;
        if (!out) {
          throw new Error("Translation response missing translated_text");
        }
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
          const delay = delayBase * Math.pow(2, attempt);
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

async function postJson(endpoint: string, body: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const url = new URL(endpoint);
  const json = JSON.stringify(body);
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;

  const options: http.RequestOptions = {
    method: "POST",
    hostname: url.hostname,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: url.pathname + url.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      Accept: "application/json"
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
        if (status < 200 || status >= 300) {
          return reject(new Error(`HTTP ${status}: ${text.slice(0, 500)}`));
        }
        const parsed = safeJsonParse<any>(text);
        if (!parsed.ok) return reject(parsed.error);
        resolve(parsed.value);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Translation request timeout"));
    });
    req.write(json);
    req.end();
  });
}
