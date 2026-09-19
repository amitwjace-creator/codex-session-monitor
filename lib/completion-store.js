const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseRetentionDays(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^(0|off|none|unlimited|disabled)$/i.test(trimmed)) {
      return null;
    }
    const num = Number(trimmed);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
    return null;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
    return null;
  }

  return null;
}

function isEntryExpired(entry, retentionDays, nowMs = Date.now()) {
  if (
    retentionDays === null ||
    retentionDays === undefined ||
    retentionDays <= 0 ||
    !Number.isFinite(retentionDays)
  ) {
    return false;
  }

  if (!entry || typeof entry !== "object") {
    return false;
  }

  const dateVal = entry.completedAt || entry.createdAt || entry.startedAt;
  if (!dateVal) {
    return false;
  }

  const timeMs = typeof dateVal === "number" ? dateVal : new Date(dateVal).getTime();
  if (!Number.isFinite(timeMs)) {
    return false;
  }

  const cutoffMs = nowMs - retentionDays * MS_PER_DAY;
  return timeMs < cutoffMs;
}

function pruneCompletions(completions, retentionDays, nowMs = Date.now(), maxEntries = 500) {
  if (!Array.isArray(completions)) {
    return [];
  }

  let filtered = completions;
  if (
    retentionDays !== null &&
    retentionDays !== undefined &&
    retentionDays > 0 &&
    Number.isFinite(retentionDays)
  ) {
    filtered = completions.filter((entry) => !isEntryExpired(entry, retentionDays, nowMs));
  }

  if (typeof maxEntries === "number" && maxEntries > 0) {
    return filtered.slice(0, maxEntries);
  }

  return filtered;
}

module.exports = {
  MS_PER_DAY,
  parseRetentionDays,
  isEntryExpired,
  pruneCompletions
};
