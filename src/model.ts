export type RawCodexEvent =
  | RawSessionMetaEvent
  | RawTurnContextEvent
  | RawResponseItemEvent
  | RawEventMsgEvent
  | Record<string, unknown>;

export interface RawBaseEvent {
  timestamp?: string;
  type?: string;
  payload?: any;
}

export interface RawSessionMetaEvent extends RawBaseEvent {
  type: "session_meta";
  payload: {
    id?: string;
    timestamp?: string;
    cwd?: string;
    originator?: string;
    cli_version?: string;
    source?: string;
    model_provider?: string;
    base_instructions?: { text?: string };
    [k: string]: unknown;
  };
}

export interface RawTurnContextEvent extends RawBaseEvent {
  type: "turn_context";
  payload: {
    cwd?: string;
    approval_policy?: string;
    sandbox_policy?: unknown;
    model?: string;
    [k: string]: unknown;
  };
}

export interface RawResponseItemEvent extends RawBaseEvent {
  type: "response_item";
  payload: {
    type: string;
    [k: string]: unknown;
  };
}

export interface RawEventMsgEvent extends RawBaseEvent {
  type: "event_msg";
  payload: {
    type: string;
    [k: string]: unknown;
  };
}

export type ShadowEventKind =
  | "REASONING"
  | "USER_MSG"
  | "AGENT_MSG"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "META"
  | "ERROR";

export type ShadowSeverity = "info" | "warn" | "error";

export interface ShadowRawRef {
  filePath: string;
  byteOffset?: number;
  lineNo?: number;
  seq?: number;
}

export interface ShadowEvent {
  id: string;
  sessionKey: string;
  sessionId?: string;
  ts?: string;
  seq: number;
  kind: ShadowEventKind;
  source: string;
  title: string;
  details: Record<string, unknown>;
  tags: string[];
  severity: ShadowSeverity;
  rawRef: ShadowRawRef;
  relatedCallId?: string;
}

export interface SessionInfo {
  sessionKey: string;
  sessionId?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  rolloutFiles: string[];
}

export interface FileParseState {
  filePath: string;
  byteOffset: number;
  partialBuffer: string;
  seq: number;
  lastSize?: number;
  lastMtimeMs?: number;
}

export interface PersistedFileProgress {
  byteOffset: number;
  lastSize: number;
  lastMtimeMs: number;
}

export interface PersistedStateV1 {
  version: 1;
  fileProgress: Record<string, PersistedFileProgress>;
  translationCache?: Record<string, string>;
}
