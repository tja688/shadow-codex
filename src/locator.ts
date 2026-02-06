import * as fs from "fs/promises";
import * as path from "path";
import fg from "fast-glob";
import { RawCodexEvent, RawSessionMetaEvent, SessionInfo } from "./model";
import { safeJsonParse, toIso } from "./utils";

export interface ScanResult {
  sessions: SessionInfo[];
}

function normalizeAbs(p: string): string {
  return path.normalize(p);
}

export async function scanSessions(codexHome: string, includeArchived: boolean): Promise<ScanResult> {
  const rootStat = await fs.stat(codexHome).catch(() => undefined);
  if (!rootStat || !rootStat.isDirectory()) {
    return { sessions: [] };
  }

  const patterns = ["sessions/**/rollout-*.jsonl"];
  if (includeArchived) patterns.push("archived_sessions/**/rollout-*.jsonl");

  const matched = await fg(patterns, {
    cwd: codexHome,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true
  }).catch(() => []);

  const files = matched.map(normalizeAbs);
  const bySessionDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = path.dirname(file);
    const list = bySessionDir.get(dir) ?? [];
    list.push(file);
    bySessionDir.set(dir, list);
  }

  const sessions: SessionInfo[] = [];
  for (const [sessionDir, rolloutFiles] of bySessionDir.entries()) {
    rolloutFiles.sort((a, b) => a.localeCompare(b));
    const meta = await readFirstSessionMeta(rolloutFiles[0]).catch(() => undefined);

    const stats = await Promise.all(rolloutFiles.map((f) => fs.stat(f).catch(() => undefined)));
    const mtimes = stats.map((s) => s?.mtimeMs ?? 0);
    const maxMtime = mtimes.length ? Math.max(...mtimes) : 0;
    const positive = mtimes.filter((v) => v > 0);
    const minMtime = positive.length ? Math.min(...positive) : 0;

    const createdAt = toIso(meta?.payload?.timestamp) ?? (minMtime ? new Date(minMtime).toISOString() : undefined);
    const updatedAt = maxMtime ? new Date(maxMtime).toISOString() : undefined;

    sessions.push({
      sessionKey: sessionDir,
      sessionId: meta?.payload?.id,
      cwd: meta?.payload?.cwd,
      createdAt,
      updatedAt,
      rolloutFiles
    });
  }

  sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { sessions };
}

export async function readFirstSessionMeta(filePath: string): Promise<RawSessionMetaEvent | undefined> {
  const fh = await fs.open(filePath, "r");
  try {
    const maxBytes = 256 * 1024;
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = safeJsonParse<RawCodexEvent>(trimmed);
      if (!parsed.ok) continue;
      const ev = parsed.value as any;
      if (ev && ev.type === "session_meta") return ev as RawSessionMetaEvent;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}
