import { ParsedLineEvent } from "./parser";
import { RawCodexEvent, ShadowEvent, ShadowSeverity } from "./model";
import { coerceString, safeJsonParse, sha1Hex, summarizeOneLine, toIso } from "./utils";

export interface ExtractContext {
  sessionKey: string;
  filePath: string;
}

function baseId(ctx: ExtractContext, seq: number, ts: string | undefined, type: string | undefined): string {
  return sha1Hex(`${ctx.filePath}:${seq}:${ts ?? ""}:${type ?? ""}`);
}

function severityFromText(text: string): ShadowSeverity {
  const lower = text.toLowerCase();
  if (lower.includes("disconnected") || lower.includes("exception") || lower.includes("failed") || lower.includes("error")) return "error";
  if (lower.includes("retry") || lower.includes("warn")) return "warn";
  return "info";
}

function tagifyToolName(name: string): string[] {
  if (name.startsWith("mcp__")) return ["tool", "mcp"];
  if (name === "shell_command") return ["tool", "shell"];
  return ["tool"];
}

function classifyShellCommand(command: string): { tags: string[]; title: string; details: Record<string, unknown> } {
  const lower = command.toLowerCase();
  const tags = ["shell"];

  const isSearch = /\b(rg|ripgrep|grep|findstr)\b/i.test(command);
  const isRead = /\b(get-content|cat|type|head|tail)\b/i.test(command);
  const isSkill = /[\\/]\.agents[\\/](skills)[\\/]/i.test(command);

  if (isSearch) tags.push("search");
  if (isRead) tags.push("file-read");
  if (isRead && isSkill) tags.push("skill", "skill-read");
  if (!isSearch && !isRead) tags.push("exec");

  const title = summarizeOneLine(command, 140);
  return { tags, title, details: { command } };
}

function parseToolArgs(rawArgs: unknown): { parsed: any; raw: string | undefined; parseError?: string } {
  if (typeof rawArgs === "string") {
    const res = safeJsonParse<any>(rawArgs);
    if (res.ok) return { parsed: res.value, raw: rawArgs };
    return { parsed: { _raw: rawArgs }, raw: rawArgs, parseError: res.error.message };
  }
  return { parsed: rawArgs, raw: undefined };
}

function parseToolOutput(rawOutput: unknown): { parsed: any; raw: string | undefined; parseError?: string } {
  if (typeof rawOutput === "string") {
    const res = safeJsonParse<any>(rawOutput);
    if (res.ok) return { parsed: res.value, raw: rawOutput };
    return { parsed: rawOutput, raw: rawOutput, parseError: res.error.message };
  }
  return { parsed: rawOutput, raw: undefined };
}

function isEventMsg(ev: any): ev is { payload: { type: string } } {
  return ev && ev.type === "event_msg" && ev.payload && typeof ev.payload.type === "string";
}

function isResponseItem(ev: any): ev is { payload: { type: string } } {
  return ev && ev.type === "response_item" && ev.payload && typeof ev.payload.type === "string";
}

export function extractShadowEvents(ctx: ExtractContext, item: ParsedLineEvent): ShadowEvent[] {
  const raw: RawCodexEvent = item.raw;
  const type = (raw as any)?.type;
  const ts = toIso((raw as any)?.timestamp);

  if (type === "parse_error") {
    const msg = coerceString((raw as any)?.payload?.message) ?? "JSON parse error";
    return [
      {
        id: baseId(ctx, item.seq, ts, "parse_error"),
        sessionKey: ctx.sessionKey,
        ts,
        seq: item.seq,
        kind: "ERROR",
        source: "parser",
        title: `Parse error: ${summarizeOneLine(msg, 140)}`,
        details: (raw as any)?.payload ?? {},
        tags: ["error", "parse"],
        severity: "error",
        rawRef: { filePath: ctx.filePath, seq: item.seq }
      }
    ];
  }

  if (type === "session_meta") {
    const payload: any = (raw as any)?.payload ?? {};
    const title = `Session started / cwd=${payload.cwd ?? "?"} / model=${payload.model ?? payload.model_provider ?? "?"}`;
    return [
      {
        id: baseId(ctx, item.seq, ts, "session_meta"),
        sessionKey: ctx.sessionKey,
        sessionId: payload.id,
        ts,
        seq: item.seq,
        kind: "META",
        source: "session_meta",
        title,
        details: payload,
        tags: ["meta", "session"],
        severity: "info",
        rawRef: { filePath: ctx.filePath, seq: item.seq }
      }
    ];
  }

  if (type === "turn_context") {
    const payload: any = (raw as any)?.payload ?? {};
    const title = `Turn context / approval=${payload.approval_policy ?? "?"} / cwd=${payload.cwd ?? "?"}`;
    return [
      {
        id: baseId(ctx, item.seq, ts, "turn_context"),
        sessionKey: ctx.sessionKey,
        ts,
        seq: item.seq,
        kind: "META",
        source: "turn_context",
        title,
        details: payload,
        tags: ["meta", "turn"],
        severity: "info",
        rawRef: { filePath: ctx.filePath, seq: item.seq }
      }
    ];
  }

  if (isEventMsg(raw)) {
    const p: any = (raw as any).payload;
    if (p.type === "agent_reasoning") {
      const text = coerceString(p.text) ?? "";
      return [
        {
          id: baseId(ctx, item.seq, ts, "agent_reasoning"),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "REASONING",
          source: "event_msg",
          title: summarizeOneLine(text, 140),
          details: { text },
          tags: ["reasoning"],
          severity: "info",
          rawRef: { filePath: ctx.filePath, seq: item.seq }
        }
      ];
    }

    if (p.type === "user_message") {
      const msg = coerceString(p.message) ?? "";
      return [
        {
          id: baseId(ctx, item.seq, ts, "user_message"),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "USER_MSG",
          source: "event_msg",
          title: summarizeOneLine(msg, 140),
          details: { text: msg },
          tags: ["user"],
          severity: "info",
          rawRef: { filePath: ctx.filePath, seq: item.seq }
        }
      ];
    }

    if (p.type === "agent_message") {
      const msg = coerceString(p.message) ?? "";
      return [
        {
          id: baseId(ctx, item.seq, ts, "agent_message"),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "AGENT_MSG",
          source: "event_msg",
          title: summarizeOneLine(msg, 140),
          details: { text: msg },
          tags: ["agent"],
          severity: "info",
          rawRef: { filePath: ctx.filePath, seq: item.seq }
        }
      ];
    }

    if (p.type === "token_count") {
      return [
        {
          id: baseId(ctx, item.seq, ts, "token_count"),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "META",
          source: "event_msg",
          title: "Token count",
          details: p,
          tags: ["meta", "token"],
          severity: "info",
          rawRef: { filePath: ctx.filePath, seq: item.seq }
        }
      ];
    }
  }

  if (isResponseItem(raw)) {
    const p: any = (raw as any).payload;

    if (p.type === "function_call") {
      const toolName = coerceString(p.name) ?? "unknown_tool";
      const callId = coerceString(p.call_id);
      const argsParsed = parseToolArgs(p.arguments);
      const tags = tagifyToolName(toolName);
      const details: Record<string, unknown> = {
        tool: { name: toolName, args: argsParsed.parsed, argsRaw: argsParsed.raw, parseError: argsParsed.parseError }
      };

      let title = `Tool call: ${toolName}`;
      const derivedTags: string[] = [];

      if (toolName === "shell_command") {
        const cmd = coerceString(argsParsed.parsed?.command) ?? coerceString(argsParsed.parsed?.cmd) ?? argsParsed.raw ?? "";
        const cls = classifyShellCommand(cmd);
        title = cls.title;
        derivedTags.push(...cls.tags);
        details.shell = cls.details;
      } else if (toolName.startsWith("mcp__")) {
        const [, server, method] = toolName.split("__");
        derivedTags.push("mcp", server ? `mcp:${server}` : "mcp:unknown", method ? `mcp:${server}:${method}` : "mcp:unknown-method");
        title = `MCP ${server ?? "?"}.${method ?? "?"}`;
        const mcpDetails: any = { server, method };
        if (method === "batch_execute") {
          const cmds = Array.isArray(argsParsed.parsed?.commands) ? argsParsed.parsed.commands : undefined;
          if (cmds && cmds.length > 0) {
            mcpDetails.actions = cmds.slice(0, 50).map((c: any) => {
              const tool = typeof c?.tool === "string" ? c.tool : "?";
              const action = typeof c?.params?.action === "string" ? c.params.action : undefined;
              const component = typeof c?.params?.component_type === "string" ? c.params.component_type : undefined;
              const target = c?.params?.target != null ? String(c.params.target) : undefined;
              const parts = [tool, action, component, target].filter(Boolean);
              return parts.join(" ");
            });
            if (cmds.length > 50) mcpDetails.actionsTruncated = cmds.length - 50;
          }
        }
        details.mcp = mcpDetails;
      }

      return [
        {
          id: baseId(ctx, item.seq, ts, `tool_call:${toolName}`),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "TOOL_CALL",
          source: "response_item",
          title,
          details,
          tags: [...tags, ...derivedTags],
          severity: "info",
          rawRef: { filePath: ctx.filePath, seq: item.seq },
          relatedCallId: callId
        }
      ];
    }

    if (p.type === "function_call_output") {
      const toolName = coerceString(p.name) ?? "unknown_tool";
      const callId = coerceString(p.call_id);
      const outParsed = parseToolOutput(p.output);
      const tags = ["tool_result", ...tagifyToolName(toolName)];

      const rawText = typeof outParsed.parsed === "string" ? outParsed.parsed : outParsed.raw ?? "";
      const sev = rawText ? severityFromText(rawText) : "info";

      const title =
        sev === "error"
          ? `${toolName} result: error`
          : sev === "warn"
            ? `${toolName} result: warn`
            : `${toolName} result: ok`;

      const details: Record<string, unknown> = {
        tool: { name: toolName, output: outParsed.parsed, outputRaw: outParsed.raw, parseError: outParsed.parseError }
      };

      if (toolName === "shell_command") {
        const outStr = coerceString(outParsed.raw ?? outParsed.parsed) ?? "";
        const m = outStr.match(/Exit code:\s*(\d+)/i);
        if (m) details.shell = { exitCode: Number(m[1]) };
        if (m && Number(m[1]) !== 0) {
          return [
            {
              id: baseId(ctx, item.seq, ts, `tool_result:${toolName}`),
              sessionKey: ctx.sessionKey,
              ts,
              seq: item.seq,
              kind: "TOOL_RESULT",
              source: "response_item",
              title: `shell_command result: exit=${m[1]}`,
              details,
              tags: [...tags, "shell"],
              severity: "error",
              rawRef: { filePath: ctx.filePath, seq: item.seq },
              relatedCallId: callId
            }
          ];
        }
      }

      return [
        {
          id: baseId(ctx, item.seq, ts, `tool_result:${toolName}`),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "TOOL_RESULT",
          source: "response_item",
          title,
          details,
          tags,
          severity: sev,
          rawRef: { filePath: ctx.filePath, seq: item.seq },
          relatedCallId: callId
        }
      ];
    }

    if (p.type === "reasoning") {
      const summaryText = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text ?? "").join("\n") : "";
      if (!summaryText.trim()) return [];
      return [
        {
          id: baseId(ctx, item.seq, ts, "reasoning_summary"),
          sessionKey: ctx.sessionKey,
          ts,
          seq: item.seq,
          kind: "REASONING",
          source: "response_item",
          title: summarizeOneLine(summaryText, 140),
          details: { text: summaryText },
          tags: ["reasoning"],
          severity: "info",
          rawRef: { filePath: ctx.filePath, seq: item.seq }
        }
      ];
    }
  }

  return [];
}
