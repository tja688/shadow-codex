import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import chokidar, { FSWatcher } from "chokidar";
import { readConfig, ShadowCodexConfig } from "./config";
import { scanSessions } from "./locator";
import { extractShadowEvents } from "./extractor";
import { IncrementalJsonlParser } from "./parser";
import { FileParseState, PersistedStateV1, SessionInfo, ShadowEvent } from "./model";
import { debounce, throttle } from "./utils";

export interface DebugEvent {
  ts: string;
  source: string;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface StoreDebugSnapshot {
  ts: string;
  codexHome: string;
  includeArchivedSessions: boolean;
  watcherDebounceMs: number;
  watcherActive: boolean;
  watcherPaths: string[];
  pendingFiles: number;
  lastWatcherEvent?: { ts: string; type: string; filePath?: string };
  sessionCount: number;
  lastRescanAt?: string;
  lastPoll?: {
    ts: string;
    filePath: string;
    bytesRead: number;
    parsed: number;
    extracted: number;
    truncated: boolean;
    parseErrors: number;
  };
  totalAppended: number;
  lastAppendCount?: number;
  lastAppendAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

const PERSIST_KEY = "shadowCodex.state";

class EventDeduper {
  private readonly max: number;
  private readonly queue: string[] = [];
  private readonly set = new Set<string>();

  constructor(max: number) {
    this.max = max;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.queue.push(id);
    while (this.queue.length > this.max) {
      const old = this.queue.shift();
      if (old) this.set.delete(old);
    }
  }
}

export class ShadowCodexStore {
  private context: vscode.ExtensionContext;
  private cfg: ShadowCodexConfig;
  private parser = new IncrementalJsonlParser();
  private watcher?: FSWatcher;

  private sessions: SessionInfo[] = [];
  private sessionsByKey = new Map<string, SessionInfo>();
  private eventsBySessionKey = new Map<string, ShadowEvent[]>();
  private fileStates = new Map<string, FileParseState>();
  private dedupersBySession = new Map<string, EventDeduper>();

  private pendingFiles = new Set<string>();
  private pendingFlushTimer?: NodeJS.Timeout;
  private flushInProgress = false;

  private persisted: PersistedStateV1;
  private debugSnapshot: StoreDebugSnapshot;

  private onDidChangeSessionsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

  private onDidChangeSessionEventsEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeSessionEvents = this.onDidChangeSessionEventsEmitter.event;

  private onDidAppendEventsEmitter = new vscode.EventEmitter<ShadowEvent[]>();
  readonly onDidAppendEvents = this.onDidAppendEventsEmitter.event;

  private onDidDebugEmitter = new vscode.EventEmitter<DebugEvent>();
  readonly onDidDebug = this.onDidDebugEmitter.event;

  private requestPersistSave = debounce(() => this.savePersisted(), 500);
  private requestEmitSessions = throttle(() => this.onDidChangeSessionsEmitter.fire(), 500);

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.cfg = readConfig();
    this.persisted = this.loadPersisted();
    this.debugSnapshot = this.buildDebugSnapshot();
  }

  refreshConfig(): void {
    this.cfg = readConfig();
    this.updateDebugSnapshot({
      codexHome: this.cfg.codexHome,
      includeArchivedSessions: this.cfg.includeArchivedSessions,
      watcherDebounceMs: this.cfg.watcherDebounceMs
    });
  }

  async reloadAfterConfigChange(): Promise<void> {
    this.refreshConfig();
    await this.rescanSessions();
    await this.startWatcher();
  }

  getConfig(): ShadowCodexConfig {
    return this.cfg;
  }

  getSessions(): SessionInfo[] {
    return this.sessions;
  }

  getEvents(sessionKey: string): ShadowEvent[] {
    return this.eventsBySessionKey.get(sessionKey) ?? [];
  }

  getSession(sessionKey: string): SessionInfo | undefined {
    return this.sessionsByKey.get(sessionKey);
  }

  getDebugSnapshot(): StoreDebugSnapshot {
    return this.debugSnapshot;
  }

  getLatestSession(): SessionInfo | undefined {
    return this.sessions[0];
  }

  async start(): Promise<void> {
    await this.rescanSessions();
    await this.startWatcher();
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
    this.updateDebugSnapshot({ watcherActive: false, watcherPaths: [], pendingFiles: this.pendingFiles.size });
    this.emitDebug("watcher", "Watcher stopped");
  }

  async rescanSessions(): Promise<void> {
    this.refreshConfig();
    const { sessions } = await scanSessions(this.cfg.codexHome, this.cfg.includeArchivedSessions);
    this.sessions = sessions;
    this.sessionsByKey = new Map(sessions.map((s) => [s.sessionKey, s]));
    this.updateDebugSnapshot({ sessionCount: sessions.length, lastRescanAt: new Date().toISOString() });
    this.emitDebug("sessions", `Rescanned sessions (${sessions.length})`, { sessionCount: sessions.length });
    this.requestEmitSessions();
  }

  private resortSessions(): void {
    this.sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  private updateSessionUpdatedAt(sessionKey: string, iso: string | undefined): boolean {
    if (!iso) return false;
    const session = this.sessionsByKey.get(sessionKey);
    if (!session) return false;
    if (!session.updatedAt || iso > session.updatedAt) {
      session.updatedAt = iso;
      this.resortSessions();
      return true;
    }
    return false;
  }

  private getOrCreateFileState(filePath: string): FileParseState {
    const existing = this.fileStates.get(filePath);
    if (existing) return existing;

    const prog = this.persisted.fileProgress[filePath];
    const rewind = 4096;
    const offset = prog ? Math.max(0, prog.byteOffset - rewind) : 0;
    const state: FileParseState = { filePath, byteOffset: offset, partialBuffer: "", seq: 0, lastSize: prog?.lastSize, lastMtimeMs: prog?.lastMtimeMs };
    this.fileStates.set(filePath, state);
    return state;
  }

  private validatePersistedProgress(filePath: string, stat: { size: number; mtimeMs: number }): boolean {
    const prog = this.persisted.fileProgress[filePath];
    if (!prog) return true;
    if (stat.size < prog.byteOffset) return false;
    if (stat.mtimeMs < prog.lastMtimeMs) return false;
    return true;
  }

  private async startWatcher(): Promise<void> {
    await this.watcher?.close();

    const root = this.cfg.codexHome;
    const rootStat = await fs.stat(root).catch(() => undefined);
    if (!rootStat || !rootStat.isDirectory()) {
      this.watcher = undefined;
      this.updateDebugSnapshot({ watcherActive: false, watcherPaths: [], pendingFiles: this.pendingFiles.size });
      this.emitDebug("watcher", `Skip watcher: codexHome not found (${root})`, { codexHome: root }, "warn");
      return;
    }

    const watchPaths = [path.join(root, "sessions", "**", "rollout-*.jsonl")];
    if (this.cfg.includeArchivedSessions) watchPaths.push(path.join(root, "archived_sessions", "**", "rollout-*.jsonl"));

    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });

    this.watcher.on("add", (p) => this.enqueueFileChange("add", path.normalize(p)));
    this.watcher.on("change", (p) => this.enqueueFileChange("change", path.normalize(p)));
    this.watcher.on("error", (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.updateDebugSnapshot({ lastError: msg, lastErrorAt: new Date().toISOString() });
      this.emitDebug("watcher", `Watcher error: ${msg}`, { error: msg }, "error");
    });
    this.updateDebugSnapshot({ watcherActive: true, watcherPaths: watchPaths, pendingFiles: this.pendingFiles.size });
    this.emitDebug("watcher", "Watcher started", { paths: watchPaths });
  }

  private enqueueFileChange(kind: "add" | "change", filePath: string): void {
    if (!/rollout-.*\.jsonl$/i.test(filePath)) return;
    this.pendingFiles.add(filePath);
    const ts = new Date().toISOString();
    this.updateDebugSnapshot({
      pendingFiles: this.pendingFiles.size,
      lastWatcherEvent: { ts, type: kind, filePath }
    });
    this.emitDebug("watcher", `${kind} ${path.basename(filePath)}`, { filePath });
    this.scheduleFlushPendingFiles();
  }

  private scheduleFlushPendingFiles(): void {
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
    const wait = Math.max(50, this.cfg.watcherDebounceMs);
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = undefined;
      void this.flushPendingFiles();
    }, wait);
  }

  private async flushPendingFiles(): Promise<void> {
    if (this.flushInProgress) {
      this.scheduleFlushPendingFiles();
      return;
    }
    this.flushInProgress = true;
    try {
      const files = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      const ts = new Date().toISOString();
      this.updateDebugSnapshot({
        pendingFiles: 0,
        lastWatcherEvent: { ts, type: "flush", filePath: files[0] }
      });
      this.emitDebug("watcher", `Flush ${files.length} file(s)`, { count: files.length });
      for (const filePath of files) {
        await this.onFileChanged(filePath);
      }
    } finally {
      this.flushInProgress = false;
      if (this.pendingFiles.size > 0) {
        this.scheduleFlushPendingFiles();
      }
    }
  }

  private async onFileChanged(filePath: string): Promise<void> {
    if (!/rollout-.*\.jsonl$/i.test(filePath)) return;

    const sessionKey = path.dirname(filePath);
    if (!this.sessionsByKey.has(sessionKey)) {
      await this.rescanSessions();
    }

    await this.pollFileWithRetry(filePath, 0);
    this.onDidChangeSessionEventsEmitter.fire(sessionKey);
  }

  private async pollFileWithRetry(filePath: string, attempt: number): Promise<void> {
    const maxAttempts = 6;
    try {
      const stat = await fs.stat(filePath);
      if (!this.validatePersistedProgress(filePath, { size: stat.size, mtimeMs: stat.mtimeMs })) {
        this.persisted.fileProgress[filePath] = { byteOffset: 0, lastSize: stat.size, lastMtimeMs: stat.mtimeMs };
        this.fileStates.delete(filePath);
      }

      const state = this.getOrCreateFileState(filePath);
      const prevOffset = state.byteOffset;
      const res = await this.parser.poll(filePath, state);
      this.fileStates.set(filePath, res.state);

      const sessionKey = path.dirname(filePath);
      const deduper = this.getOrCreateDeduper(sessionKey);
      const out: ShadowEvent[] = [];
      for (const e of res.events) {
        const extracted = extractShadowEvents({ sessionKey, filePath }, e);
        for (const se of extracted) {
          if (deduper.has(se.id)) continue;
          deduper.add(se.id);
          out.push(se);
        }
      }

      const parsedCount = res.events.length;
      const parseErrors = res.events.filter((e) => (e.raw as any)?.type === "parse_error").length;
      const bytesRead = Math.max(0, res.state.byteOffset - prevOffset);
      this.updateDebugSnapshot({
        lastPoll: {
          ts: new Date().toISOString(),
          filePath,
          bytesRead,
          parsed: parsedCount,
          extracted: out.length,
          truncated: res.truncated,
          parseErrors
        }
      });
      if (parsedCount > 0 || res.truncated || parseErrors > 0) {
        this.emitDebug("parser", `Parsed ${parsedCount}, extracted ${out.length}`, {
          filePath,
          bytesRead,
          parsed: parsedCount,
          extracted: out.length,
          truncated: res.truncated,
          parseErrors
        });
      }

      if (out.length > 0) {
        const list = this.eventsBySessionKey.get(sessionKey) ?? [];
        list.push(...out);
        list.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "") || a.seq - b.seq);
        this.eventsBySessionKey.set(sessionKey, list);
        this.onDidAppendEventsEmitter.fire(out);
        const total = this.debugSnapshot.totalAppended + out.length;
        this.updateDebugSnapshot({ totalAppended: total, lastAppendCount: out.length, lastAppendAt: new Date().toISOString() });
        this.emitDebug("events", `Appended ${out.length} event(s)`, { sessionKey, count: out.length, total });
      }

      const newestEventTs = out.reduce<string | undefined>((acc, e) => (!acc || (e.ts && e.ts > acc) ? e.ts : acc), undefined);
      const fileMtimeIso = new Date(stat.mtimeMs).toISOString();
      const updatedChanged = this.updateSessionUpdatedAt(sessionKey, newestEventTs ?? fileMtimeIso);

      this.persisted.fileProgress[filePath] = {
        byteOffset: res.state.byteOffset,
        lastSize: res.state.lastSize ?? stat.size,
        lastMtimeMs: res.state.lastMtimeMs ?? stat.mtimeMs
      };
      this.requestPersistSave();
      if (updatedChanged) this.requestEmitSessions();
    } catch (e: any) {
      if (attempt >= maxAttempts) {
        const msg = e instanceof Error ? e.message : String(e);
        this.updateDebugSnapshot({ lastError: msg, lastErrorAt: new Date().toISOString() });
        this.emitDebug("parser", `Poll failed after ${maxAttempts} attempts`, { filePath, error: msg }, "error");
        return;
      }
      const delayMs = Math.min(5000, 200 * Math.pow(2, attempt));
      await new Promise((r) => setTimeout(r, delayMs));
      return this.pollFileWithRetry(filePath, attempt + 1);
    }
  }

  async warmSession(sessionKey: string): Promise<void> {
    const session = this.sessionsByKey.get(sessionKey);
    if (!session) return;
    for (const f of session.rolloutFiles) {
      await this.pollFileWithRetry(f, 0);
    }
    this.onDidChangeSessionEventsEmitter.fire(sessionKey);
  }

  async warmRolloutFile(filePath: string): Promise<void> {
    const sessionKey = path.dirname(filePath);
    if (!this.sessionsByKey.has(sessionKey)) {
      const stat = await fs.stat(filePath).catch(() => undefined);
      const updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : undefined;
      const info = { sessionKey, rolloutFiles: [filePath], updatedAt };
      this.sessions.push(info);
      this.sessionsByKey.set(sessionKey, info);
      this.resortSessions();
      this.requestEmitSessions();
    }
    await this.pollFileWithRetry(filePath, 0);
    this.onDidChangeSessionEventsEmitter.fire(sessionKey);
  }

  clearSession(sessionKey: string): void {
    this.eventsBySessionKey.delete(sessionKey);
    this.dedupersBySession.delete(sessionKey);
  }

  getTranslationCache(): Record<string, string> {
    this.persisted.translationCache ??= {};
    return this.persisted.translationCache;
  }

  schedulePersistSave(): void {
    this.requestPersistSave();
  }

  private buildDebugSnapshot(): StoreDebugSnapshot {
    const ts = new Date().toISOString();
    return {
      ts,
      codexHome: this.cfg.codexHome,
      includeArchivedSessions: this.cfg.includeArchivedSessions,
      watcherDebounceMs: this.cfg.watcherDebounceMs,
      watcherActive: false,
      watcherPaths: [],
      pendingFiles: 0,
      sessionCount: this.sessions.length,
      totalAppended: 0
    };
  }

  private updateDebugSnapshot(patch: Partial<StoreDebugSnapshot>): void {
    this.debugSnapshot = { ...this.debugSnapshot, ...patch, ts: new Date().toISOString() };
  }

  private emitDebug(source: string, message: string, data?: Record<string, unknown>, level: "info" | "warn" | "error" = "info"): void {
    const ts = new Date().toISOString();
    this.onDidDebugEmitter.fire({ ts, source, level, message, data });
  }

  private getOrCreateDeduper(sessionKey: string): EventDeduper {
    const existing = this.dedupersBySession.get(sessionKey);
    if (existing) return existing;
    const d = new EventDeduper(50_000);
    this.dedupersBySession.set(sessionKey, d);
    return d;
  }

  private loadPersisted(): PersistedStateV1 {
    const raw = this.context.globalState.get<PersistedStateV1>(PERSIST_KEY);
    if (raw && raw.version === 1 && raw.fileProgress) return raw;
    return { version: 1, fileProgress: {} };
  }

  private async savePersisted(): Promise<void> {
    await this.context.globalState.update(PERSIST_KEY, this.persisted);
  }
}
