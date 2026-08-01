const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  extractSessionId,
  parseAllSessions,
  parseSessionFile
} = require("../lib/session-parser");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

test("extracts the session id from rollout filenames", () => {
  const file = `rollout-2026-08-02T00-00-00-${SESSION_ID}.jsonl`;
  assert.equal(extractSessionId(file), SESSION_ID);
});

test("parses completed tasks, token usage, and session metadata", () => {
  const dir = makeTempDir();
  const file = writeSessionFile(dir, SESSION_ID, [
    event("session_meta", null, "2026-08-02T00:00:00.000Z", {
      session_id: SESSION_ID,
      cwd: "/workspace/project",
      source: "vscode",
      originator: "codex_vscode",
      cli_version: "0.146.0"
    }),
    event("event_msg", "task_started", "2026-08-02T00:01:00.000Z"),
    event("event_msg", "token_count", "2026-08-02T00:02:00.000Z", {
      info: {
        total_token_usage: { total_tokens: 1200 },
        last_token_usage: { total_tokens: 400 },
        model_context_window: 258400
      },
      rate_limits: {
        plan_type: "plus",
        primary: { used_percent: 12.5, resets_at: 1786211506 }
      }
    }),
    event("event_msg", "task_complete", "2026-08-02T00:04:00.000Z")
  ]);

  const parsed = parseSessionFile(file);
  assert.equal(parsed.sessionId, SESSION_ID);
  assert.equal(parsed.cwd, "/workspace/project");
  assert.equal(parsed.taskStarts.length, 1);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].status, "finished");
  assert.equal(parsed.tasks[0].durationMs, 180000);
  assert.equal(parsed.tokenEvent.info.total_token_usage.total_tokens, 1200);
  assert.equal(parsed.tokenEvent.rateLimits.primary.used_percent, 12.5);
  assert.equal(parsed.openTask, null);
});

test("keeps open tasks running when the file is only partially written", () => {
  const dir = makeTempDir();
  const file = writeSessionFile(dir, SESSION_ID, [
    event("session_meta", null, "2026-08-02T00:00:00.000Z", { session_id: SESSION_ID }),
    event("event_msg", "task_started", "2026-08-02T00:01:00.000Z"),
    "{not complete json"
  ]);

  const parsed = parseSessionFile(file);
  assert.equal(parsed.parseErrors, 1);
  assert.equal(parsed.tasks.length, 0);
  assert.equal(parsed.openTask.startedAt, "2026-08-02T00:01:00.000Z");
});

test("treats terminal error events as errored tasks", () => {
  const dir = makeTempDir();
  const file = writeSessionFile(dir, SESSION_ID, [
    event("session_meta", null, "2026-08-02T00:00:00.000Z", { session_id: SESSION_ID }),
    event("event_msg", "task_started", "2026-08-02T00:01:00.000Z"),
    event("event_msg", "turn_aborted", "2026-08-02T00:01:30.000Z")
  ]);

  const parsed = parseSessionFile(file);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].status, "error");
  assert.equal(parsed.tasks[0].terminalType, "turn_aborted");
  assert.equal(parsed.tasks[0].durationMs, 30000);
});

test("closes an open task as interrupted when a new task starts", () => {
  const dir = makeTempDir();
  const file = writeSessionFile(dir, SESSION_ID, [
    event("session_meta", null, "2026-08-02T00:00:00.000Z", { session_id: SESSION_ID }),
    event("event_msg", "task_started", "2026-08-02T00:01:00.000Z"),
    event("event_msg", "task_started", "2026-08-02T00:02:00.000Z"),
    event("event_msg", "task_complete", "2026-08-02T00:05:00.000Z")
  ]);

  const parsed = parseSessionFile(file);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].status, "error");
  assert.equal(parsed.tasks[0].terminalType, "interrupted_by_new_task");
  assert.equal(parsed.tasks[1].status, "finished");
  assert.equal(parsed.tasks[1].durationMs, 180000);
});

test("loads session names from the session index and sorts by activity", () => {
  const root = makeTempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "08", "02");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const firstId = "aaaaaaaa-1111-2222-3333-444444444444";
  const secondId = "bbbbbbbb-1111-2222-3333-444444444444";
  writeSessionFile(sessionsDir, firstId, [
    event("session_meta", null, "2026-08-02T00:00:00.000Z", { session_id: firstId }),
    event("event_msg", "task_started", "2026-08-02T00:01:00.000Z")
  ]);
  writeSessionFile(sessionsDir, secondId, [
    event("session_meta", null, "2026-08-02T00:00:00.000Z", { session_id: secondId }),
    event("event_msg", "task_started", "2026-08-02T00:03:00.000Z")
  ]);
  const indexFile = path.join(root, "session_index.jsonl");
  fs.writeFileSync(indexFile, [
    JSON.stringify({ id: firstId, thread_name: "First session" }),
    JSON.stringify({ id: secondId, thread_name: "Second session" })
  ].join("\n"));

  const sessions = parseAllSessions({
    sessionsDir: path.join(root, "sessions"),
    sessionIndexFile: indexFile,
    parseCache: new Map()
  });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].name, "Second session");
  assert.equal(sessions[1].name, "First session");
});

function event(type, payloadType, timestamp, payload = {}) {
  return JSON.stringify({
    timestamp,
    type,
    payload: payloadType ? { type: payloadType, ...payload } : payload
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-test-"));
}

function writeSessionFile(dir, sessionId, lines) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-02T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
