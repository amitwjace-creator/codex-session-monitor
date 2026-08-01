const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const {
  allTerminalTasks,
  latestTerminalTask,
  parseAllSessions
} = require("./lib/session-parser");
const { BackendAlarm, normalizeAlarmMode } = require("./lib/backend-alarm");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3786", 10);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, ".data");
const STORE_FILE = path.join(DATA_DIR, "monitor-data.json");
const RUNTIME_DIR = path.join(__dirname, ".runtime");
const ALARM_STOP_FILE = path.join(RUNTIME_DIR, "alarm-stop");
const DEFAULT_ALARM_MODE = normalizeAlarmMode(process.env.ALARM_MODE || "urgent");
const BACKEND_ALARM_ENABLED = !/^(0|false|off|no)$/i.test(process.env.BACKEND_ALARM || "on");

const parseCache = new Map();
const sseClients = new Set();
let monitorStartedAtMs = Date.now();
let initialized = false;
let knownTerminalKeys = new Set();
let activeAlert = null;
let lastSnapshot = null;
let processSnapshot = {
  checkedAt: null,
  hasCodex: false,
  codexCount: 0,
  processes: [],
  error: null
};

ensureDir(DATA_DIR);
ensureDir(RUNTIME_DIR);
const backendAlarm = new BackendAlarm({ stopFile: ALARM_STOP_FILE, runtimeDir: RUNTIME_DIR });
let store = loadStore();
for (const entry of store.completions) {
  if (entry.key) knownTerminalKeys.add(entry.key);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      version: 1,
      completions: Array.isArray(parsed.completions) ? parsed.completions : [],
      dismissedKeys: Array.isArray(parsed.dismissedKeys) ? parsed.dismissedKeys : []
    };
  } catch {
    return { version: 1, completions: [], dismissedKeys: [] };
  }
}

function saveStore() {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function recordCompletion(task, session, synthetic = false, alarmMode = DEFAULT_ALARM_MODE) {
  if (!task || !task.key) return null;
  let entry = store.completions.find((item) => item.key === task.key);
  if (!entry) {
    entry = {
      key: task.key,
      status: task.status,
      sessionId: task.sessionId || session?.sessionId || null,
      sessionName: session?.name || task.sessionId || "Synthetic alert",
      file: task.file || session?.file || null,
      cwd: session?.cwd || null,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      terminalType: task.terminalType,
      alarmMode,
      synthetic,
      createdAt: new Date().toISOString(),
      dismissedAt: null
    };
    store.completions.unshift(entry);
    store.completions = store.completions.slice(0, 500);
    saveStore();
  }
  return entry;
}

function triggerAlert(task, session, synthetic = false, alarmMode = DEFAULT_ALARM_MODE) {
  const entry = recordCompletion(task, session, synthetic, alarmMode);
  if (!entry) return;
  activeAlert = {
    ...entry,
    active: true,
    triggeredAt: new Date().toISOString()
  };
  if (BACKEND_ALARM_ENABLED) backendAlarm.start(entry.status, entry.alarmMode);
}

function dismissAlert() {
  backendAlarm.stop();
  if (!activeAlert) return null;
  const dismissedAt = new Date().toISOString();
  const key = activeAlert.key;
  activeAlert = { ...activeAlert, active: false, dismissedAt };
  if (!store.dismissedKeys.includes(key)) {
    store.dismissedKeys.push(key);
    store.dismissedKeys = store.dismissedKeys.slice(-500);
  }
  const entry = store.completions.find((item) => item.key === key);
  if (entry) entry.dismissedAt = dismissedAt;
  saveStore();
  refreshMonitor();
  return activeAlert;
}

function refreshProcesses() {
  if (process.platform === "win32") {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) {
        processSnapshot = { ...processSnapshot, checkedAt: new Date().toISOString(), error: error.message };
        return;
      }
      const processes = parseTasklistCsv(stdout)
        .filter((row) => /^(codex|codex-code-mode-host|chatgpt)\.exe$/i.test(row.imageName))
        .map((row) => ({ pid: row.pid, name: row.imageName }));
      const codexCount = processes.filter((item) => /^codex/i.test(item.name)).length;
      processSnapshot = {
        checkedAt: new Date().toISOString(),
        hasCodex: codexCount > 0,
        codexCount,
        processes,
        error: null
      };
    });
    return;
  }

  execFile("ps", ["-axo", "pid=,comm="], { timeout: 5000 }, (error, stdout) => {
    if (error) {
      processSnapshot = { ...processSnapshot, checkedAt: new Date().toISOString(), error: error.message };
      return;
    }
    const processes = stdout.split(/\r?\n/)
      .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map((match) => ({ pid: match[1], name: path.basename(match[2]) }))
      .filter((item) => /^codex/i.test(item.name));
    processSnapshot = {
      checkedAt: new Date().toISOString(),
      hasCodex: processes.length > 0,
      codexCount: processes.length,
      processes,
      error: null
    };
  });
}

function parseTasklistCsv(stdout) {
  return stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = [];
      let current = "";
      let inQuotes = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
          cells.push(current);
          current = "";
        } else {
          current += char;
        }
      }
      cells.push(current);
      return { imageName: cells[0], pid: cells[1] };
    });
}

function refreshMonitor() {
  const sessions = parseAllSessions({
    sessionsDir: SESSIONS_DIR,
    sessionIndexFile: SESSION_INDEX,
    parseCache
  });
  if (!initialized) {
    for (const task of allTerminalTasks(sessions)) knownTerminalKeys.add(task.key);
    initialized = true;
  } else {
    const newTerminals = allTerminalTasks(sessions)
      .filter((task) => !knownTerminalKeys.has(task.key))
      .filter((task) => task.completedAtMs >= monitorStartedAtMs - 5000)
      .sort((a, b) => a.completedAtMs - b.completedAtMs);

    for (const task of newTerminals) {
      const session = sessions.find((item) => item.sessionId === task.sessionId || item.file === task.file);
      knownTerminalKeys.add(task.key);
      triggerAlert(task, session, false);
    }
  }

  lastSnapshot = buildSnapshot(sessions);
  broadcastStatus(lastSnapshot);
  return lastSnapshot;
}

function buildSnapshot(sessions) {
  const activeSession = sessions[0] || null;
  const activeTask = activeSession?.openTask || null;
  const latestTerminal = latestTerminalTask(sessions);
  const now = Date.now();
  let state = "idle";
  let run = null;

  if (activeAlert?.active) {
    state = activeAlert.status === "error" ? "error" : "finished";
    run = activeAlert;
  } else if (activeTask) {
    state = "running";
    run = {
      status: "running",
      startedAt: activeTask.startedAt,
      durationMs: Math.max(0, now - activeTask.startedAtMs),
      sessionId: activeSession.sessionId,
      sessionName: activeSession.name
    };
  } else if (activeSession && processSnapshot.hasCodex) {
    state = "waiting_for_input";
  }

  const stats = buildStats(sessions, activeSession);
  return {
    state,
    generatedAt: new Date().toISOString(),
    monitorStartedAt: new Date(monitorStartedAtMs).toISOString(),
    integration: {
      mode: "codex-session-jsonl-plus-process-polling",
      codexHome: CODEX_HOME,
      sessionsDir: SESSIONS_DIR,
      note: "Codex CLI does not expose a documented live status API here; this monitor parses local JSONL rollout files and uses process polling as a secondary signal."
    },
    alarm: {
      backendEnabled: BACKEND_ALARM_ENABLED,
      backend: BACKEND_ALARM_ENABLED ? backendAlarm.backendName : "disabled",
      defaultMode: DEFAULT_ALARM_MODE,
      modes: ["urgent", "gentle", "silent"]
    },
    process: processSnapshot,
    activeSession: activeSession ? summarizeSession(activeSession) : null,
    run,
    latestTerminal,
    alert: activeAlert,
    usage: summarizeUsage(activeSession?.tokenEvent || null),
    stats,
    completions: store.completions.slice(0, 40)
  };
}

function summarizeSession(session) {
  return {
    id: session.sessionId,
    name: session.name,
    file: session.file,
    cwd: session.cwd,
    source: session.source,
    originator: session.originator,
    cliVersion: session.cliVersion,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    lastPayloadType: session.lastPayloadType,
    taskCount: session.taskStarts.length,
    completedTaskCount: session.tasks.length,
    hasOpenTask: Boolean(session.openTask),
    parseErrors: session.parseErrors
  };
}

function summarizeUsage(tokenEvent) {
  if (!tokenEvent) return { available: false };
  const info = tokenEvent.info || {};
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  const totalTokens = numberOrNull(total.total_tokens);
  const contextWindow = numberOrNull(info.model_context_window);
  const rateLimits = tokenEvent.rateLimits || {};
  const primary = rateLimits.primary || {};
  const planUsedPercent = numberOrNull(primary.used_percent);
  const resetSeconds = numberOrNull(primary.resets_at);

  return {
    available: true,
    updatedAt: tokenEvent.at,
    totalTokens,
    inputTokens: numberOrNull(total.input_tokens),
    cachedInputTokens: numberOrNull(total.cached_input_tokens),
    outputTokens: numberOrNull(total.output_tokens),
    reasoningOutputTokens: numberOrNull(total.reasoning_output_tokens),
    lastTotalTokens: numberOrNull(last.total_tokens),
    contextWindow,
    contextUsedPercent: totalTokens !== null && contextWindow ? (totalTokens / contextWindow) * 100 : null,
    planType: rateLimits.plan_type || null,
    limitId: rateLimits.limit_id || null,
    limitName: rateLimits.limit_name || null,
    planUsedPercent,
    planRemainingPercent: planUsedPercent === null ? null : Math.max(0, 100 - planUsedPercent),
    resetAt: resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null,
    windowMinutes: numberOrNull(primary.window_minutes),
    credits: rateLimits.credits || null,
    rateLimitReachedType: rateLimits.rate_limit_reached_type || null,
    spendControlReached: rateLimits.spend_control_reached || null
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildStats(sessions, activeSession) {
  const now = new Date();
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeekDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  startWeekDate.setDate(startWeekDate.getDate() - startWeekDate.getDay());
  const startWeek = startWeekDate.getTime();
  const starts = sessions.flatMap((session) => session.taskStarts);
  const completed = sessions.flatMap((session) => session.tasks)
    .filter((task) => task.durationMs !== null && task.status !== "running");
  const durations = completed.map((task) => task.durationMs).filter((value) => Number.isFinite(value));
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const errors = completed.filter((task) => task.status === "error");
  const finished = completed.filter((task) => task.status === "finished");
  const lastActivityMs = sessions.reduce((latest, session) => Math.max(latest, session.lastActivityMs || 0), 0);
  const latestCompleted = completed.reduce((latest, task) => Math.max(latest, task.completedAtMs || 0), 0);

  return {
    tasksToday: starts.filter((task) => task.startedAtMs >= startDay).length,
    tasksThisWeek: starts.filter((task) => task.startedAtMs >= startWeek).length,
    tasksThisSession: activeSession ? activeSession.taskStarts.length : 0,
    completedTasks: completed.length,
    finishedTasks: finished.length,
    errorTasks: errors.length,
    averageTaskDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    medianTaskDurationMs: median(sortedDurations),
    fastestTaskDurationMs: sortedDurations.length ? sortedDurations[0] : null,
    slowestTaskDurationMs: sortedDurations.length ? sortedDurations[sortedDurations.length - 1] : null,
    lastCompletedAt: latestCompleted ? new Date(latestCompleted).toISOString() : null,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    timeSinceLastActivityMs: lastActivityMs ? Math.max(0, Date.now() - lastActivityMs) : null
  };
}

function median(sortedValues) {
  if (!sortedValues.length) return null;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2) return sortedValues[middle];
  return Math.round((sortedValues[middle - 1] + sortedValues[middle]) / 2);
}

function createSyntheticAlert(status = "finished", alarmMode = DEFAULT_ALARM_MODE) {
  const now = Date.now();
  const task = {
    key: `synthetic:${status}:${now}`,
    sessionId: "synthetic",
    file: null,
    status: status === "error" ? "error" : "finished",
    terminalType: "test_alert",
    startedAt: new Date(now - 125000).toISOString(),
    startedAtMs: now - 125000,
    completedAt: new Date(now).toISOString(),
    completedAtMs: now,
    durationMs: 125000
  };
  triggerAlert(task, { sessionId: "synthetic", name: "Test alert", cwd: null, file: null }, true, normalizeAlarmMode(alarmMode));
  refreshMonitor();
}

function broadcastStatus(snapshot) {
  const payload = `event: status\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveStatic(req, res) {
  const requestedPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const fullPath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(fullPath),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, lastSnapshot || refreshMonitor());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    sseClients.add(res);
    res.write(`event: status\ndata: ${JSON.stringify(lastSnapshot || refreshMonitor())}\n\n`);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dismiss") {
    const alert = dismissAlert();
    sendJson(res, 200, { ok: true, alert });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test-alert") {
    createSyntheticAlert(
      url.searchParams.get("status") === "error" ? "error" : "finished",
      url.searchParams.get("mode") || DEFAULT_ALARM_MODE
    );
    sendJson(res, 200, { ok: true, alert: activeAlert });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, codexHome: CODEX_HOME, sessionsDir: SESSIONS_DIR });
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

refreshProcesses();
refreshMonitor();
setInterval(refreshProcesses, 5000);
setInterval(refreshMonitor, 1000);

server.listen(PORT, HOST, () => {
  console.log(`Codex Session Monitor running at http://${HOST}:${PORT}`);
  console.log(`Watching ${SESSIONS_DIR}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    backendAlarm.stop();
    server.close(() => process.exit(0));
  });
}

process.on("exit", () => backendAlarm.stop());
