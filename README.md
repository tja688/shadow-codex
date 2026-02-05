# 🌑 Shadow Codex

> **Unified High-Density Event Timeline for Codex Sessions**

`Shadow Codex` is a VS Code extension that provides a read-only, near real-time shadow view for Codex sessions. It monitors `rollout-*.jsonl` files to extract reasoning, tool calls, shell commands, and MCP interactions into a high-signal timeline.

---

## 🚀 Key Features

- **Real-time Monitoring**: Follow Codex sessions in near real-time without consuming stdout/stderr.
- **High-Signal Extraction**: Intelligent filtering of reasoning, tool calls, results, and shell commands.
- **Smart Timeline**: Automatic folding of massive output blocks and grouping of call/result pairs.
- **Dashboard View**: A modern, unified Webview dashboard for a live "Matrix-style" feed.
- **Local Translation**: Optional integration with local translation services for reasoning and tool outputs.

---

## 🛠️ Goals
- Follow Codex sessions in near real time without consuming stdout/stderr.
- Extract high-signal events (reasoning, tool calls/results, shell commands, MCP calls).
- Keep the timeline readable by folding large blocks and grouping call/result pairs.
- Optionally translate natural-language content via a local translation service.

## Architecture (Data Flow)
1. Locator scans `CODEX_HOME/sessions/**/rollout-*.jsonl` (and optional `archived_sessions`).
2. Watcher tracks file changes and triggers incremental parsing.
3. Incremental JSONL parser reads only appended bytes and tolerates partial lines.
4. Extractor normalizes raw events into `ShadowEvent` records with tags and severity.
5. Store indexes sessions and events, dedupes, and persists parse offsets.
6. UI renders a unified Webview dashboard (primary) plus a legacy TreeView and virtual document timeline.

## Project Layout
- `src/extension.ts` - Extension activation, commands, and wiring.
- `src/config.ts` - Configuration schema and defaults.
- `src/locator.ts` - Session discovery and metadata (created/updated time).
- `src/parser.ts` - Incremental JSONL parser with partial-line handling.
- `src/extractor.ts` - Event normalization and tagging.
- `src/store.ts` - Session/event index, watcher, and persisted offsets.
- `src/sessionTree.ts` - TreeView grouping and recency sorting.
- `src/timelineDocument.ts` - Timeline rendering and folding logic.
- `src/translation.ts` - Translation queue, retries, and cache.
- `src/search.ts` - Simple search across session events.
- `src/export.ts` - Export session events to JSON/Markdown.
- `src/stats.ts` - Session stats summary.
- `src/model.ts` - Shared types.
- `src/utils.ts` - Hashing, folding, and helpers.

## Extension Entry Point
- Activation happens in `src/extension.ts` via `activate()`.
- The core pipeline is created in this order:
  1. `ShadowCodexStore` (scanner + watcher + parser)
  2. `Translator` (optional translation queue)
  3. `TimelineDocumentProvider` (virtual doc renderer)
  4. `SessionsTreeDataProvider` (TreeView)

## Key Behaviors
- Dashboard shows a single unified live feed of new events only.
- Legacy view (TreeView + timeline document) remains available for session-level inspection.
- Sessions are grouped by `cwd` and sorted by recency within each group.
- Group ordering is also based on the most recent activity across sessions.
- Events are sorted by timestamp, with seq as a tie-breaker.
- Large blocks are folded by char/line thresholds and code-block heuristics.
- Tool results show structured summaries (exit code, wall time, status) plus folded raw output.

## Commands
- `Shadow Codex: Refresh Sessions`
- `Shadow Codex: Open Dashboard`
- `Shadow Codex: Open Session`
- `Shadow Codex: Open Rollout File...`
- `Shadow Codex: Toggle Follow Mode`
- `Shadow Codex: Toggle Translation`
- `Shadow Codex: Toggle Filter (Only MCP)`
- `Shadow Codex: Toggle Filter (Only Shell Commands)`
- `Shadow Codex: Toggle Filter (Only Errors/Warns)`
- `Shadow Codex: Export Session (JSON)`
- `Shadow Codex: Export Session (Markdown)`
- `Shadow Codex: Search in Session`
- `Shadow Codex: Show Session Stats`

## Configuration
All settings are under `shadowCodex.*`:
- `shadowCodex.codexHome`
- `shadowCodex.includeArchivedSessions`
- `shadowCodex.followMode`
- `shadowCodex.uiRefreshIntervalMs`
- `shadowCodex.watcherDebounceMs`
- `shadowCodex.foldThresholdChars`
- `shadowCodex.foldThresholdLines`
- `shadowCodex.forceFoldCodeBlocks`
- `shadowCodex.showAgentMessage`
- `shadowCodex.filter.onlyMcp`
- `shadowCodex.filter.onlyShell`
- `shadowCodex.filter.onlyErrors`
- `shadowCodex.dashboard.maxItems`
- `shadowCodex.translation.enabled`
- `shadowCodex.translation.endpoint`
- `shadowCodex.translation.targetLang`
- `shadowCodex.translation.showOriginalCollapsed`
- `shadowCodex.translation.timeoutMs`
- `shadowCodex.translation.maxConcurrency`
- `shadowCodex.translation.maxQueue`
- `shadowCodex.translation.maxTextLength`
- `shadowCodex.translation.retryCount`
- `shadowCodex.translation.retryDelayMs`
- `shadowCodex.translation.debug`

## Translation Debugging
Translation errors and retries are logged to the output channel:
- Open **View > Output**, then select **Shadow Codex**.
- The timeline header also shows translation status (pending/running/last error).

## Build & Run (Dev)
1. Install dependencies:
   - `npm install`
2. Compile once or watch:
   - `npm run compile`
   - `npm run watch`
3. Press `F5` to launch the Extension Development Host.

## Test Checklist (Manual)
1. Ensure `CODEX_HOME` is set or `shadowCodex.codexHome` is configured.
2. Start the extension (F5) and open the Shadow Codex view.
3. Run Codex to generate a new session and confirm it appears in the TreeView.
4. Open the session and verify the timeline updates as new events are appended.
5. Toggle filters (Only MCP / Only Shell / Only Errors) and verify the view updates.
6. Confirm large outputs are folded and summaries are readable.
7. Trigger a shell command and verify exit code/wall time parsing in the result.
8. If translation is enabled:
   - Verify the "translating..." placeholder appears.
   - Confirm translated text appears once the service responds.
   - Check the **Shadow Codex** output channel for error details if it fails.

## Known Limitations
- Call/result pairing is strongest when `call_id` exists; fallback pairing is minimal.
- Dashboard currently shows only new events (no historical replay).
- Translation only targets natural language and skips code/JSON blocks.
