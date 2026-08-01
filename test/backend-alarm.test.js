const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  getAlarmProfile,
  normalizeAlarmMode,
  writeToneWav
} = require("../lib/backend-alarm");

test("normalizes alarm modes", () => {
  assert.equal(normalizeAlarmMode("gentle"), "gentle");
  assert.equal(normalizeAlarmMode("silent"), "silent");
  assert.equal(normalizeAlarmMode("unknown"), "urgent");
  assert.equal(normalizeAlarmMode(null), "urgent");
});

test("returns distinct profiles for finished and error states", () => {
  const finished = getAlarmProfile("finished", "urgent");
  const error = getAlarmProfile("error", "urgent");
  assert.notDeepEqual(finished.frequencies, error.frequencies);
  assert.equal(getAlarmProfile("finished", "silent").frequencies.length, 0);
});

test("writes a playable wav tone file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-alarm-test-"));
  const file = path.join(dir, "alarm.wav");
  writeToneWav(file, getAlarmProfile("finished", "gentle"));
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(buffer.subarray(8, 12).toString("ascii"), "WAVE");
  assert.ok(buffer.length > 44);
});
