import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface ShadowCodexConfig {
  codexHome: string;
  includeArchivedSessions: boolean;
  followMode: boolean;
  uiRefreshIntervalMs: number;
  watcherDebounceMs: number;
  foldThresholdChars: number;
  foldThresholdLines: number;
  forceFoldCodeBlocks: boolean;
  showAgentMessage: boolean;
  filterOnlyMcp: boolean;
  filterOnlyShell: boolean;
  filterOnlyErrors: boolean;
  dashboardMaxItems: number;
  translationEnabled: boolean;
  translationEndpoint: string;
  translationTargetLang: string;
  translationShowOriginalCollapsed: boolean;
  translationTimeoutMs: number;
  translationMaxConcurrency: number;
  translationMaxQueue: number;
  translationMaxTextLength: number;
  translationRetryCount: number;
  translationRetryDelayMs: number;
  translationDebug: boolean;
}

export const CONFIG_SECTION = "shadowCodex";

export function getDefaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

export function readConfig(): ShadowCodexConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const envHome = process.env.CODEX_HOME;
  const overrideHome = (cfg.get<string>("codexHome") ?? "").trim();
  const codexHome = overrideHome || (envHome && envHome.trim()) || getDefaultCodexHome();

  return {
    codexHome,
    includeArchivedSessions: cfg.get<boolean>("includeArchivedSessions") ?? false,
    followMode: cfg.get<boolean>("followMode") ?? true,
    uiRefreshIntervalMs: cfg.get<number>("uiRefreshIntervalMs") ?? 1000,
    watcherDebounceMs: cfg.get<number>("watcherDebounceMs") ?? 500,
    foldThresholdChars: cfg.get<number>("foldThresholdChars") ?? 2000,
    foldThresholdLines: cfg.get<number>("foldThresholdLines") ?? 80,
    forceFoldCodeBlocks: cfg.get<boolean>("forceFoldCodeBlocks") ?? true,
    showAgentMessage: cfg.get<boolean>("showAgentMessage") ?? false,
    filterOnlyMcp: cfg.get<boolean>("filter.onlyMcp") ?? false,
    filterOnlyShell: cfg.get<boolean>("filter.onlyShell") ?? false,
    filterOnlyErrors: cfg.get<boolean>("filter.onlyErrors") ?? false,
    dashboardMaxItems: cfg.get<number>("dashboard.maxItems") ?? 2000,
    translationEnabled: cfg.get<boolean>("translation.enabled") ?? false,
    translationEndpoint: cfg.get<string>("translation.endpoint") ?? "http://127.0.0.1:8080/translate",
    translationTargetLang: cfg.get<string>("translation.targetLang") ?? "Simplified Chinese",
    translationShowOriginalCollapsed: cfg.get<boolean>("translation.showOriginalCollapsed") ?? true,
    translationTimeoutMs: cfg.get<number>("translation.timeoutMs") ?? 60_000,
    translationMaxConcurrency: cfg.get<number>("translation.maxConcurrency") ?? 1,
    translationMaxQueue: cfg.get<number>("translation.maxQueue") ?? 200,
    translationMaxTextLength: cfg.get<number>("translation.maxTextLength") ?? 8000,
    translationRetryCount: cfg.get<number>("translation.retryCount") ?? 1,
    translationRetryDelayMs: cfg.get<number>("translation.retryDelayMs") ?? 800,
    translationDebug: cfg.get<boolean>("translation.debug") ?? true
  };
}
