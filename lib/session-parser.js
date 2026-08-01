const fs = require("node:fs");
const path = require("node:path");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function discoverSessionFiles(sessionsDir) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({ file: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Ignore files that are rotating while we inspect them.
        }
      }
    }
  }
  walk(sessionsDir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((item) => item.file);
}

function extractSessionId(file) {
  const matches = path.basename(file).match(UUID_RE);
  return matches && matches.length ? matches[matches.length - 1].toLowerCase() : null;
}

function readSessionIndex(sessionIndexFile) {
  const index = new Map();
  try {
    const lines = fs.readFileSync(sessionIndexFile, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.id) index.set(String(row.id).toLowerCase(), row);
      } catch {
        // Ignore partial index lines.
      }
    }
  } catch {
    // The index is helpful, not required.
  }
  return index;
}

function parseSessionFile(file, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const parseCache = options.parseCache || null;
  const cached = parseCache?.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.parsed;
  }

  const parsed = createEmptySession(file, stat.mtimeMs);

  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return parsed;
  }

  parseSessionLines(text.split(/\r?\n/), parsed, { now: options.now });

  if (parseCache) {
    parseCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
  }
  return parsed;
}

function createEmptySession(file, mtimeMs) {
  return {
    file,
    fileName: path.basename(file),
    sessionId: extractSessionId(file),
    name: null,
    cwd: null,
    source: null,
    originator: null,
    cliVersion: null,
    createdAt: null,
    updatedAt: new Date(mtimeMs).toISOString(),
    lastActivityAt: null,
    lastActivityMs: mtimeMs,
    lastPayloadType: null,
    taskStarts: [],
    tasks: [],
    openTask: null,
    tokenEvent: null,
    parseErrors: 0
  };
}

function parseSessionLines(lines, parsed, options = {}) {
  let openTask = null;
  const now = typeof options.now === "function" ? options.now : Date.now;

  function closeTask(status, event, lineNumber, terminalType) {
    const completedAtMs = event.timestampMs || now();
    const startedAtMs = openTask ? openTask.startedAtMs : completedAtMs;
    const sessionId = parsed.sessionId || "unknown-session";
    const task = {
      key: `${sessionId}:${openTask ? openTask.startLine : "unknown"}:${startedAtMs}:${completedAtMs}:${status}`,
      sessionId: parsed.sessionId,
      file: parsed.file,
      status,
      terminalType,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      completedAt: new Date(completedAtMs).toISOString(),
      completedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      startLine: openTask ? openTask.startLine : null,
      completedLine: lineNumber
    };
    parsed.tasks.push(task);
    openTask = null;
    return task;
  }

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parsed.parseErrors += 1;
      return;
    }

    const timestampMs = Date.parse(event.timestamp);
    if (Number.isFinite(timestampMs)) {
      event.timestampMs = timestampMs;
      parsed.lastActivityAt = new Date(timestampMs).toISOString();
      parsed.lastActivityMs = timestampMs;
    }

    const payload = event.payload || {};
    const payloadType = payload.type || null;
    if (payloadType) parsed.lastPayloadType = payloadType;

    if (event.type === "session_meta") {
      parsed.sessionId = (payload.session_id || payload.id || parsed.sessionId || "").toLowerCase();
      parsed.cwd = payload.cwd || parsed.cwd;
      parsed.source = payload.source || parsed.source;
      parsed.originator = payload.originator || parsed.originator;
      parsed.cliVersion = payload.cli_version || parsed.cliVersion;
      parsed.createdAt = payload.timestamp || event.timestamp || parsed.createdAt;
    }

    if (event.type !== "event_msg") return;

    if (payloadType === "token_count") {
      parsed.tokenEvent = {
        at: parsed.lastActivityAt,
        info: payload.info || null,
        rateLimits: payload.rate_limits || null
      };
      return;
    }

    if (payloadType === "task_started") {
      if (openTask) {
        closeTask("error", event, index + 1, "interrupted_by_new_task");
      }
      const startedAtMs = event.timestampMs || now();
      openTask = {
        sessionId: parsed.sessionId,
        file: parsed.file,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        startLine: index + 1
      };
      parsed.taskStarts.push(openTask);
      return;
    }

    if (payloadType === "task_complete") {
      closeTask("finished", event, index + 1, payloadType);
      return;
    }

    if (isTerminalErrorPayload(payloadType)) {
      closeTask("error", event, index + 1, payloadType || "error");
    }
  });

  parsed.openTask = openTask;
  if (!parsed.createdAt && parsed.taskStarts.length) {
    parsed.createdAt = parsed.taskStarts[0].startedAt;
  }
  return parsed;
}

function isTerminalErrorPayload(payloadType) {
  if (!payloadType) return false;
  return [
    "turn_aborted",
    "task_failed",
    "stream_error",
    "fatal_error",
    "model_error",
    "api_error"
  ].includes(payloadType) || /^.*_error$/.test(payloadType);
}

function parseAllSessions({ sessionsDir, sessionIndexFile, parseCache }) {
  const index = readSessionIndex(sessionIndexFile);
  const parsed = discoverSessionFiles(sessionsDir)
    .map((file) => parseSessionFile(file, { parseCache }))
    .filter(Boolean);

  for (const session of parsed) {
    const indexRow = session.sessionId ? index.get(session.sessionId) : null;
    session.name = indexRow?.thread_name || session.name || session.sessionId || session.fileName;
    if (indexRow?.updated_at) session.updatedAt = indexRow.updated_at;
  }

  parsed.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return parsed;
}

function latestTerminalTask(parsedSessions) {
  let latest = null;
  for (const session of parsedSessions) {
    for (const task of session.tasks) {
      if (!latest || task.completedAtMs > latest.completedAtMs) {
        latest = task;
      }
    }
  }
  return latest;
}

function allTerminalTasks(parsedSessions) {
  return parsedSessions.flatMap((session) => session.tasks);
}

module.exports = {
  allTerminalTasks,
  createEmptySession,
  discoverSessionFiles,
  extractSessionId,
  isTerminalErrorPayload,
  latestTerminalTask,
  parseAllSessions,
  parseSessionFile,
  parseSessionLines,
  readSessionIndex
};
