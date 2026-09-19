const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MS_PER_DAY,
  parseRetentionDays,
  isEntryExpired,
  pruneCompletions
} = require("../lib/completion-store");

test("parseRetentionDays parses valid positive numbers and numeric strings", () => {
  assert.equal(parseRetentionDays(7), 7);
  assert.equal(parseRetentionDays("7"), 7);
  assert.equal(parseRetentionDays("14"), 14);
  assert.equal(parseRetentionDays("30.5"), 30.5);
  assert.equal(parseRetentionDays("  3  "), 3);
  assert.equal(parseRetentionDays(0.5), 0.5);
});

test("parseRetentionDays returns null for disabled or unlimited configurations", () => {
  assert.equal(parseRetentionDays(undefined), null);
  assert.equal(parseRetentionDays(null), null);
  assert.equal(parseRetentionDays(""), null);
  assert.equal(parseRetentionDays("   "), null);
  assert.equal(parseRetentionDays(0), null);
  assert.equal(parseRetentionDays("0"), null);
  assert.equal(parseRetentionDays("off"), null);
  assert.equal(parseRetentionDays("OFF"), null);
  assert.equal(parseRetentionDays("none"), null);
  assert.equal(parseRetentionDays("unlimited"), null);
  assert.equal(parseRetentionDays("UNLIMITED"), null);
  assert.equal(parseRetentionDays("disabled"), null);
});

test("parseRetentionDays returns null for invalid values", () => {
  assert.equal(parseRetentionDays(-5), null);
  assert.equal(parseRetentionDays("-5"), null);
  assert.equal(parseRetentionDays("invalid"), null);
  assert.equal(parseRetentionDays("abc"), null);
  assert.equal(parseRetentionDays(Number.NaN), null);
  assert.equal(parseRetentionDays(Number.POSITIVE_INFINITY), null);
  assert.equal(parseRetentionDays(Number.NEGATIVE_INFINITY), null);
  assert.equal(parseRetentionDays({}), null);
  assert.equal(parseRetentionDays([]), null);
  assert.equal(parseRetentionDays(true), null);
  assert.equal(parseRetentionDays(false), null);
});

test("isEntryExpired accurately identifies expired vs active entries", () => {
  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * MS_PER_DAY).toISOString();
  const tenDaysAgo = new Date(now - 10 * MS_PER_DAY).toISOString();

  // Retention = 7 days
  assert.equal(isEntryExpired({ completedAt: threeDaysAgo }, 7, now), false);
  assert.equal(isEntryExpired({ completedAt: tenDaysAgo }, 7, now), true);

  // Checks fallback timestamp fields
  assert.equal(isEntryExpired({ createdAt: tenDaysAgo }, 7, now), true);
  assert.equal(isEntryExpired({ startedAt: tenDaysAgo }, 7, now), true);
  assert.equal(isEntryExpired({ completedAt: threeDaysAgo, createdAt: tenDaysAgo }, 7, now), false);

  // Millisecond timestamp support
  assert.equal(isEntryExpired({ completedAt: now - 10 * MS_PER_DAY }, 7, now), true);
  assert.equal(isEntryExpired({ completedAt: now - 2 * MS_PER_DAY }, 7, now), false);

  // Missing or malformed timestamp is kept safely (not expired)
  assert.equal(isEntryExpired({}, 7, now), false);
  assert.equal(isEntryExpired(null, 7, now), false);
  assert.equal(isEntryExpired({ completedAt: "not-a-valid-date" }, 7, now), false);

  // When retention is disabled/null, never expired
  assert.equal(isEntryExpired({ completedAt: tenDaysAgo }, null, now), false);
  assert.equal(isEntryExpired({ completedAt: tenDaysAgo }, undefined, now), false);
  assert.equal(isEntryExpired({ completedAt: tenDaysAgo }, 0, now), false);
  assert.equal(isEntryExpired({ completedAt: tenDaysAgo }, -1, now), false);
});

test("pruneCompletions removes expired entries while preserving active ones", () => {
  const now = Date.now();
  const recent = { key: "k1", completedAt: new Date(now - 1 * MS_PER_DAY).toISOString() };
  const border = { key: "k2", completedAt: new Date(now - 6 * MS_PER_DAY).toISOString() };
  const old = { key: "k3", completedAt: new Date(now - 10 * MS_PER_DAY).toISOString() };
  const ancient = { key: "k4", completedAt: new Date(now - 30 * MS_PER_DAY).toISOString() };

  const entries = [recent, border, old, ancient];

  // 7-day retention keeps recent and border
  const pruned = pruneCompletions(entries, 7, now);
  assert.equal(pruned.length, 2);
  assert.deepEqual(pruned.map((e) => e.key), ["k1", "k2"]);

  // Unlimited/disabled retention keeps all entries
  assert.equal(pruneCompletions(entries, null, now).length, 4);
  assert.equal(pruneCompletions(entries, undefined, now).length, 4);
});

test("pruneCompletions enforces maxEntries cap", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    key: `item-${i}`,
    completedAt: new Date().toISOString()
  }));

  const capped = pruneCompletions(items, null, Date.now(), 5);
  assert.equal(capped.length, 5);
  assert.equal(capped[0].key, "item-0");
  assert.equal(capped[4].key, "item-4");
});

test("pruneCompletions safely handles non-array input", () => {
  assert.deepEqual(pruneCompletions(null, 7), []);
  assert.deepEqual(pruneCompletions(undefined, 7), []);
  assert.deepEqual(pruneCompletions("invalid", 7), []);
});
