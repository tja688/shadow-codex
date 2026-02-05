const vscode = acquireVsCodeApi();

const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("status-text");
const resumeBtn = document.getElementById("resume");
const btnFollow = document.getElementById("btn-follow");
const btnTranslate = document.getElementById("btn-translate");
const btnClear = document.getElementById("btn-clear");
const btnDebug = document.getElementById("btn-debug");
const btnDebugClear = document.getElementById("btn-debug-clear");
const filterMcp = document.getElementById("filter-mcp");
const filterShell = document.getElementById("filter-shell");
const filterError = document.getElementById("filter-error");
const filterReasoning = document.getElementById("filter-reasoning");
const debugPanel = document.getElementById("debug-panel");
const debugMeta = document.getElementById("debug-meta");
const debugWatcher = document.getElementById("debug-watcher");
const debugParser = document.getElementById("debug-parser");
const debugSessions = document.getElementById("debug-sessions");
const debugTranslation = document.getElementById("debug-translation");
const debugLogEl = document.getElementById("debug-log");

const translationMap = new Map();
const itemQueue = [];
let maxItems = 2000;
let totalCount = 0;
let debugLog = [];
let debugSnapshot = null;
let debugTranslationStatus = null;
const maxDebugLog = 200;

const state = {
  follow: true,
  translationEnabled: false,
  debugOpen: false,
  filters: {
    onlyMcp: false,
    onlyShell: false,
    onlyError: false,
    showReasoning: true
  }
};

function setButtonActive(btn, active) {
  if (active) btn.classList.add("active");
  else btn.classList.remove("active");
}

function updateUIState() {
  setButtonActive(btnFollow, state.follow);
  setButtonActive(btnTranslate, state.translationEnabled);
  setButtonActive(btnDebug, state.debugOpen);
  setButtonActive(filterMcp, state.filters.onlyMcp);
  setButtonActive(filterShell, state.filters.onlyShell);
  setButtonActive(filterError, state.filters.onlyError);
  setButtonActive(filterReasoning, state.filters.showReasoning);
  if (debugPanel) debugPanel.classList.toggle("hidden", !state.debugOpen);
}

function updateStatusText() {
  statusEl.textContent = `Events: ${totalCount}`;
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function shouldPauseFollow() {
  const doc = document.documentElement;
  const remaining = doc.scrollHeight - doc.scrollTop - doc.clientHeight;
  return remaining > 120;
}

function onScroll() {
  if (!state.follow) return;
  if (shouldPauseFollow()) {
    state.follow = false;
    updateUIState();
    resumeBtn.classList.remove("hidden");
    vscode.postMessage({ type: "uiAction", action: "toggleFollow", value: false });
  }
}

window.addEventListener("scroll", onScroll);

resumeBtn.addEventListener("click", () => {
  state.follow = true;
  updateUIState();
  resumeBtn.classList.add("hidden");
  vscode.postMessage({ type: "uiAction", action: "toggleFollow", value: true });
  scrollToBottom();
});

btnFollow.addEventListener("click", () => {
  state.follow = !state.follow;
  updateUIState();
  resumeBtn.classList.toggle("hidden", state.follow);
  vscode.postMessage({ type: "uiAction", action: "toggleFollow", value: state.follow });
  if (state.follow) scrollToBottom();
});

btnTranslate.addEventListener("click", () => {
  state.translationEnabled = !state.translationEnabled;
  updateUIState();
  vscode.postMessage({ type: "uiAction", action: "toggleTranslation", value: state.translationEnabled });
});

btnClear.addEventListener("click", () => {
  feedEl.innerHTML = "";
  translationMap.clear();
  itemQueue.length = 0;
  totalCount = 0;
  updateStatusText();
  vscode.postMessage({ type: "uiAction", action: "clearFeed" });
});

btnDebug.addEventListener("click", () => {
  state.debugOpen = !state.debugOpen;
  updateUIState();
});

btnDebugClear.addEventListener("click", () => {
  debugLog = [];
  renderDebugLog();
});

filterMcp.addEventListener("click", () => toggleFilter("onlyMcp"));
filterShell.addEventListener("click", () => toggleFilter("onlyShell"));
filterError.addEventListener("click", () => toggleFilter("onlyError"));
filterReasoning.addEventListener("click", () => toggleFilter("showReasoning"));

function toggleFilter(key) {
  state.filters[key] = !state.filters[key];
  updateUIState();
  applyFilters();
  vscode.postMessage({ type: "uiAction", action: "updateFilters", value: state.filters });
}

function applyFilters() {
  for (const el of itemQueue) {
    const data = el.__item;
    el.classList.toggle("hidden", !passesFilters(data));
  }
}

function passesFilters(item) {
  if (!state.filters.showReasoning && item.kind === "REASONING") return false;
  const onlyActive = state.filters.onlyMcp || state.filters.onlyShell || state.filters.onlyError;
  if (!onlyActive) return true;

  const matchMcp = state.filters.onlyMcp && item.tags.some((t) => t === "mcp" || t.startsWith("mcp:"));
  const matchShell = state.filters.onlyShell && item.tags.includes("shell");
  const matchError = state.filters.onlyError && (item.severity !== "info" || item.kind === "ERROR");
  return matchMcp || matchShell || matchError;
}

function appendItems(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  for (const item of items) {
    const card = renderItem(item);
    card.__item = item;
    card.classList.toggle("hidden", !passesFilters(item));
    feedEl.appendChild(card);
    itemQueue.push(card);
    totalCount += 1;
    if (item.translationKey) {
      translationMap.set(item.translationKey, card);
    }
  }
  trimFeed();
  updateStatusText();
  if (state.follow) scrollToBottom();
}

function trimFeed() {
  while (itemQueue.length > maxItems) {
    const old = itemQueue.shift();
    if (!old) break;
    const item = old.__item;
    if (item && item.translationKey) translationMap.delete(item.translationKey);
    old.remove();
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString();
}

function renderLines(el, lines) {
  if (!el) return;
  el.innerHTML = "";
  lines.forEach((line) => {
    const div = document.createElement("div");
    div.className = "debug-line";
    div.textContent = line;
    el.appendChild(div);
  });
}

function formatPathList(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return "Paths: —";
  if (paths.length === 1) return `Paths: ${paths[0]}`;
  return `Paths: ${paths.length} roots`;
}

function updateDebugPanel(snapshot, translation) {
  if (snapshot) debugSnapshot = snapshot;
  if (translation) debugTranslationStatus = translation;

  if (!debugSnapshot) return;

  const metaText = `Last: ${formatTime(debugSnapshot.ts)} · Pending: ${debugSnapshot.pendingFiles ?? 0}`;
  if (debugMeta) debugMeta.textContent = metaText;

  const watcherLines = [
    `Active: ${debugSnapshot.watcherActive ? "yes" : "no"}`,
    formatPathList(debugSnapshot.watcherPaths),
    debugSnapshot.lastWatcherEvent
      ? `Last event: ${debugSnapshot.lastWatcherEvent.type} · ${formatTime(debugSnapshot.lastWatcherEvent.ts)}`
      : "Last event: —"
  ];
  if (debugSnapshot.lastWatcherEvent?.filePath) watcherLines.push(`File: ${debugSnapshot.lastWatcherEvent.filePath}`);
  renderLines(debugWatcher, watcherLines);

  const poll = debugSnapshot.lastPoll;
  const parserLines = [
    poll ? `Last file: ${poll.filePath}` : "Last file: —",
    poll ? `Bytes read: ${poll.bytesRead}` : "Bytes read: —",
    poll ? `Parsed: ${poll.parsed} · Extracted: ${poll.extracted}` : "Parsed: —",
    poll ? `Parse errors: ${poll.parseErrors}` : "Parse errors: —",
    poll ? `Truncated: ${poll.truncated ? "yes" : "no"} · ${formatTime(poll.ts)}` : "Truncated: —"
  ];
  renderLines(debugParser, parserLines);

  const sessionLines = [
    `Sessions: ${debugSnapshot.sessionCount ?? 0}`,
    debugSnapshot.lastRescanAt ? `Rescan: ${formatTime(debugSnapshot.lastRescanAt)}` : "Rescan: —",
    `Appended: ${debugSnapshot.totalAppended ?? 0}`,
    debugSnapshot.lastAppendAt ? `Last append: ${debugSnapshot.lastAppendCount ?? 0} · ${formatTime(debugSnapshot.lastAppendAt)}` : "Last append: —"
  ];
  if (debugSnapshot.lastError) {
    sessionLines.push(`Last error: ${debugSnapshot.lastError}`);
  }
  renderLines(debugSessions, sessionLines);

  const tr = debugTranslationStatus;
  const translationLines = [
    tr ? `Enabled: ${tr.enabled ? "yes" : "no"}` : "Enabled: —",
    tr ? `Pending: ${tr.pending} · Running: ${tr.running}` : "Pending: —",
    tr?.lastSuccessAt ? `Last ok: ${formatTime(tr.lastSuccessAt)}` : "Last ok: —",
    tr?.lastErrorAt ? `Last error: ${formatTime(tr.lastErrorAt)} · ${tr.lastError ?? ""}` : "Last error: —"
  ];
  renderLines(debugTranslation, translationLines);
}

function appendDebugLog(evt) {
  if (!evt) return;
  debugLog.push(evt);
  if (debugLog.length > maxDebugLog) debugLog.shift();
  renderDebugLog();
}

function renderDebugLog() {
  if (!debugLogEl) return;
  debugLogEl.innerHTML = "";
  debugLog.forEach((evt) => {
    const row = document.createElement("div");
    row.className = "debug-log-row";
    row.dataset.level = evt.level || "info";
    const details = evt.data ? JSON.stringify(evt.data).slice(0, 240) : "";
    row.textContent = `[${formatTime(evt.ts)}] ${evt.source}: ${evt.message}${details ? " · " + details : ""}`;
    debugLogEl.appendChild(row);
  });
}

function handleDebugPayload(payload, withEvent) {
  if (!payload || typeof payload !== "object") return;
  updateDebugPanel(payload.snapshot, payload.translation);
  if (withEvent && payload.event) appendDebugLog(payload.event);
}

function renderItem(item) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.kind = item.kind;
  card.dataset.severity = item.severity;

  const header = document.createElement("div");
  header.className = "card-header";

  const kind = document.createElement("div");
  kind.className = "kind";
  kind.textContent = item.kind;
  header.appendChild(kind);

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatTime(item.ts || item.arrivedAt);
  header.appendChild(time);

  if (item.sessionId || item.cwd) {
    const badgeWrap = document.createElement("div");
    badgeWrap.className = "badges";
    if (item.sessionId) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = item.sessionId.slice(0, 12);
      badgeWrap.appendChild(badge);
    }
    if (item.cwd) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = item.cwd;
      badgeWrap.appendChild(badge);
    }
    header.appendChild(badgeWrap);
  }

  card.appendChild(header);

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = item.title || "Untitled";
  card.appendChild(title);

  if (item.summary) {
    const summary = document.createElement("div");
    summary.className = "card-summary";
    summary.textContent = item.summary;
    card.appendChild(summary);
  }

  if (Array.isArray(item.tags) && item.tags.length) {
    const tagList = document.createElement("div");
    tagList.className = "taglist";
    item.tags.slice(0, 8).forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "tag";
      if (tag === "mcp" || tag.startsWith("mcp:")) chip.classList.add("mcp");
      if (tag === "shell") chip.classList.add("shell");
      if (tag === "skill" || tag.startsWith("skill")) chip.classList.add("skill");
      if (tag === "error") chip.classList.add("error");
      if (tag === "reasoning") chip.classList.add("reasoning");
      chip.textContent = tag;
      tagList.appendChild(chip);
    });
    card.appendChild(tagList);
  }

  if (item.translationState && item.translatedText) {
    const tr = document.createElement("div");
    tr.className = "translation";
    if (item.translationState === "pending") tr.classList.add("pending");
    tr.textContent = item.translatedText;
    tr.dataset.translationKey = item.translationKey || "";
    card.appendChild(tr);
  }

  if (item.detailsPreview && item.detailsPreview.text) {
    const details = document.createElement("details");
    details.className = "details";
    const summary = document.createElement("summary");
    summary.textContent = item.detailsPreview.label;
    details.appendChild(summary);

    const pre = document.createElement("pre");
    pre.textContent = item.detailsPreview.text;
    details.appendChild(pre);

    if (item.detailsPreview.folded) {
      const note = document.createElement("div");
      note.className = "folded-note";
      note.textContent = `folded: ${item.detailsPreview.omittedLines} lines, ${item.detailsPreview.omittedChars} chars omitted`;
      details.appendChild(note);
    }

    card.appendChild(details);
  }

  return card;
}

function handleTranslationUpdate(payload) {
  if (!payload || !payload.key) return;
  const card = translationMap.get(payload.key);
  if (!card) return;
  const target = card.querySelector(`[data-translation-key="${payload.key}"]`);
  if (!target) return;
  target.textContent = payload.text;
  target.classList.remove("pending");
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    maxItems = msg.payload?.maxItems ?? maxItems;
    state.translationEnabled = Boolean(msg.payload?.translationEnabled);
    if (msg.payload?.state) {
      state.follow = msg.payload.state.follow !== false;
      state.filters = {
        onlyMcp: Boolean(msg.payload.state.filters?.onlyMcp),
        onlyShell: Boolean(msg.payload.state.filters?.onlyShell),
        onlyError: Boolean(msg.payload.state.filters?.onlyError),
        showReasoning: msg.payload.state.filters?.showReasoning !== false
      };
    }
    updateUIState();
    applyFilters();
    return;
  }
  if (msg.type === "append") {
    appendItems(msg.payload);
    return;
  }
  if (msg.type === "translationUpdate") {
    handleTranslationUpdate(msg.payload);
    return;
  }
  if (msg.type === "debug") {
    handleDebugPayload(msg.payload, true);
    return;
  }
  if (msg.type === "debugStatus") {
    handleDebugPayload(msg.payload, false);
  }
});

updateUIState();
updateStatusText();
