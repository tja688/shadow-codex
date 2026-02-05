import * as fs from "fs/promises";
import { FileParseState, RawCodexEvent } from "./model";
import { safeJsonParse } from "./utils";

export interface ParsedLineEvent {
  seq: number;
  raw: RawCodexEvent;
  rawLine: string;
}

export interface PollResult {
  events: ParsedLineEvent[];
  state: FileParseState;
  truncated: boolean;
}

export class IncrementalJsonlParser {
  private readonly maxChunkBytes = 4 * 1024 * 1024;

  async poll(filePath: string, prev: FileParseState): Promise<PollResult> {
    const stat = await fs.stat(filePath);

    let truncated = false;
    let state = { ...prev, lastSize: stat.size, lastMtimeMs: stat.mtimeMs };

    if (stat.size < state.byteOffset) {
      truncated = true;
      state.byteOffset = 0;
      state.partialBuffer = "";
      state.seq = 0;
    }

    const newBytes = stat.size - state.byteOffset;
    if (newBytes <= 0) {
      return { events: [], state, truncated };
    }

    let remaining = newBytes;
    let offset = state.byteOffset;
    let appendedText = "";

    const fh = await fs.open(filePath, "r");
    try {
      while (remaining > 0) {
        const chunkSize = Math.min(this.maxChunkBytes, remaining);
        const buf = Buffer.allocUnsafe(chunkSize);
        const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
        if (bytesRead <= 0) break;
        appendedText += buf.subarray(0, bytesRead).toString("utf8");
        offset += bytesRead;
        remaining -= bytesRead;
      }
    } finally {
      await fh.close();
    }

    state.byteOffset = offset;

    const combined = state.partialBuffer + appendedText;
    const lines = combined.split(/\r?\n/);
    const last = lines[lines.length - 1];
    const hasTrailingNewline = combined.endsWith("\n") || combined.endsWith("\r\n");

    if (!hasTrailingNewline) {
      state.partialBuffer = last ?? "";
      lines.pop();
    } else {
      state.partialBuffer = "";
    }

    const events: ParsedLineEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = safeJsonParse<RawCodexEvent>(trimmed);
      if (!parsed.ok) {
        state.seq += 1;
        events.push({
          seq: state.seq,
          raw: {
            timestamp: new Date().toISOString(),
            type: "parse_error",
            payload: { message: parsed.error.message, line: trimmed.slice(0, 800) }
          } as any,
          rawLine: trimmed
        });
        continue;
      }

      state.seq += 1;
      events.push({ seq: state.seq, raw: parsed.value, rawLine: trimmed });
    }

    return { events, state, truncated };
  }
}

