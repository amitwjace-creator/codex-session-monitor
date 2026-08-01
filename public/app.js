const els = {
  integrationLine: document.getElementById("integrationLine"),
  armButton: document.getElementById("armButton"),
  testButton: document.getElementById("testButton"),
  dismissButton: document.getElementById("dismissButton"),
  overlayDismissButton: document.getElementById("overlayDismissButton"),
  alertOverlay: document.getElementById("alertOverlay"),
  alertKicker: document.getElementById("alertKicker"),
  alertTitle: document.getElementById("alertTitle"),
  alertDetails: document.getElementById("alertDetails"),
  stateDot: document.getElementById("stateDot"),
  stateTitle: document.getElementById("stateTitle"),
  runTimer: document.getElementById("runTimer"),
  tokenText: document.getElementById("tokenText"),
  tokenMeter: document.getElementById("tokenMeter"),
  planText: document.getElementById("planText"),
  planMeter: document.getElementById("planMeter"),
  resetText: document.getElementById("resetText"),
  tasksToday: document.getElementById("tasksToday"),
  tasksSession: document.getElementById("tasksSession"),
  tasksWeek: document.getElementById("tasksWeek"),
  avgDuration: document.getElementById("avgDuration"),
  lastActivity: document.getElementById("lastActivity"),
  sessionTitle: document.getElementById("sessionTitle"),
  sessionSource: document.getElementById("sessionSource"),
  sessionCli: document.getElementById("sessionCli"),
  sessionTasks: document.getElementById("sessionTasks"),
  sessionFile: document.getElementById("sessionFile"),
  completionRows: document.getElementById("completionRows")
};

let snapshot = null;
let currentAlertKey = null;
let audioContext = null;
let alarmOscillator = null;
let alarmGain = null;
let alarmTimer = null;
let alertsArmed = false;
let notificationStatus = "default";
let fallbackTimer = null;

const labels = {
  idle: "Idle",
  running: "Running",
  waiting_for_input: "Waiting for input",
  finished: "Finished",
  error: "Error"
};

els.armButton.addEventListener("click", armAlerts);
els.testButton.addEventListener("click", () => {
  fetch("/api/test-alert", { method: "POST" }).catch(() => {});
});
els.dismissButton.addEventListener("click", dismissAlarm);
els.overlayDismissButton.addEventListener("click", dismissAlarm);

document.addEventListener("keydown", (event) => {
  const overlayActive = els.alertOverlay.classList.contains("active");
  if (!overlayActive) return;
  if (["Escape", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    dismissAlarm();
  }
});

function connectEvents() {
  if (!("EventSource" in window)) {
    startPolling();
    return;
  }
  const source = new EventSource("/api/events");
  source.addEventListener("status", (event) => render(JSON.parse(event.data)));
  source.onerror = () => {
    source.close();
    startPolling();
  };
}

function startPolling() {
  if (fallbackTimer) return;
  fetchStatus();
  fallbackTimer = window.setInterval(fetchStatus, 1000);
}

async function fetchStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    render(await response.json());
  } catch {
    els.integrationLine.textContent = "Monitor server unavailable";
  }
}

async function armAlerts() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    alertsArmed = true;
  } catch {
    alertsArmed = false;
  }

  if ("Notification" in window) {
    try {
      notificationStatus = await Notification.requestPermission();
    } catch {
      notificationStatus = Notification.permission;
    }
  }
  updateArmButton();
}

function updateArmButton() {
  const notificationPart = "Notification" in window ? `, notifications ${notificationStatus}` : "";
  els.armButton.textContent = alertsArmed ? `Alerts armed${notificationPart}` : `Arm alerts${notificationPart}`;
  els.armButton.classList.toggle("armed", alertsArmed);
}

async function dismissAlarm() {
  stopBrowserAlarm();
  currentAlertKey = null;
  els.alertOverlay.classList.remove("active", "finished", "error");
  els.alertOverlay.setAttribute("aria-hidden", "true");
  try {
    await fetch("/api/dismiss", { method: "POST" });
  } finally {
    fetchStatus();
  }
}

function render(nextSnapshot) {
  snapshot = nextSnapshot;
  renderStatus();
  renderUsage();
  renderStats();
  renderSession();
  renderCompletions();
  handleAlert();
  updateArmButton();
}

function renderStatus() {
  const state = snapshot?.state || "idle";
  els.integrationLine.textContent = snapshot?.integration?.mode || "codex-session-jsonl-plus-process-polling";
  els.stateTitle.textContent = labels[state] || state;
  els.stateDot.className = `state-dot state-${state}`;
  els.dismissButton.disabled = !(snapshot?.alert?.active);

  if (snapshot?.run?.startedAt) {
    const duration = snapshot.state === "running"
      ? Date.now() - new Date(snapshot.run.startedAt).getTime()
      : snapshot.run.durationMs;
    els.runTimer.textContent = formatDuration(duration);
  } else {
    els.runTimer.textContent = snapshot?.latestTerminal
      ? `Last run ${formatDuration(snapshot.latestTerminal.durationMs)}`
      : "No active run";
  }
}

function renderUsage() {
  const usage = snapshot?.usage;
  if (!usage?.available) {
    els.tokenText.textContent = "Waiting for token event";
    els.tokenMeter.style.width = "0%";
    els.planText.textContent = "Not exposed";
    els.planMeter.style.width = "0%";
    els.resetText.textContent = "Reset unavailable";
    return;
  }

  const tokenPct = clamp(usage.contextUsedPercent || 0, 0, 100);
  const total = usage.totalTokens === null ? "--" : formatNumber(usage.totalTokens);
  const limit = usage.contextWindow === null ? "--" : formatNumber(usage.contextWindow);
  els.tokenText.textContent = `${total} / ${limit}`;
  els.tokenMeter.style.width = `${tokenPct}%`;

  if (usage.planUsedPercent === null) {
    els.planText.textContent = usage.planType ? usage.planType : "Not exposed";
    els.planMeter.style.width = "0%";
  } else {
    els.planText.textContent = `${usage.planUsedPercent.toFixed(1)}% used`;
    els.planMeter.style.width = `${clamp(usage.planUsedPercent, 0, 100)}%`;
  }

  const reset = usage.resetAt ? formatDateTime(usage.resetAt) : "Reset unavailable";
  const remaining = usage.planRemainingPercent === null ? null : `${usage.planRemainingPercent.toFixed(1)}% remaining`;
  els.resetText.textContent = remaining ? `${remaining}. ${reset}` : reset;
}

function renderStats() {
  const stats = snapshot?.stats || {};
  els.tasksToday.textContent = formatNumber(stats.tasksToday || 0);
  els.tasksSession.textContent = formatNumber(stats.tasksThisSession || 0);
  els.tasksWeek.textContent = formatNumber(stats.tasksThisWeek || 0);
  els.avgDuration.textContent = stats.averageTaskDurationMs === null || stats.averageTaskDurationMs === undefined
    ? "--"
    : formatDuration(stats.averageTaskDurationMs);
  els.lastActivity.textContent = stats.timeSinceLastActivityMs === null || stats.timeSinceLastActivityMs === undefined
    ? "--"
    : `${formatDuration(stats.timeSinceLastActivityMs)} ago`;
}

function renderSession() {
  const session = snapshot?.activeSession;
  if (!session) {
    els.sessionTitle.textContent = "No session selected";
    els.sessionSource.textContent = "--";
    els.sessionCli.textContent = "--";
    els.sessionTasks.textContent = "0";
    els.sessionFile.textContent = "--";
    return;
  }
  els.sessionTitle.textContent = session.name || session.id || "Untitled session";
  els.sessionSource.textContent = [session.source, session.originator].filter(Boolean).join(" / ") || "--";
  els.sessionCli.textContent = session.cliVersion || "--";
  els.sessionTasks.textContent = `${session.taskCount || 0} started, ${session.completedTaskCount || 0} terminal`;
  els.sessionFile.textContent = session.file || "--";
}

function renderCompletions() {
  const rows = snapshot?.completions || [];
  if (!rows.length) {
    els.completionRows.innerHTML = `<tr><td colspan="4">No completions logged yet.</td></tr>`;
    return;
  }
  els.completionRows.innerHTML = rows.slice(0, 20).map((row) => `
    <tr>
      <td><span class="status-chip ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(formatDateTime(row.completedAt))}</td>
      <td>${escapeHtml(formatDuration(row.durationMs))}</td>
      <td>${escapeHtml(row.sessionName || row.sessionId || "--")}</td>
    </tr>
  `).join("");
}

function handleAlert() {
  const alert = snapshot?.alert;
  if (!alert?.active) {
    if (currentAlertKey) stopBrowserAlarm();
    currentAlertKey = null;
    els.alertOverlay.classList.remove("active", "finished", "error");
    els.alertOverlay.setAttribute("aria-hidden", "true");
    return;
  }

  els.alertOverlay.classList.add("active", alert.status === "error" ? "error" : "finished");
  els.alertOverlay.classList.toggle("finished", alert.status !== "error");
  els.alertOverlay.setAttribute("aria-hidden", "false");
  els.alertKicker.textContent = alert.status === "error" ? "Codex error" : "Codex finished";
  els.alertTitle.textContent = alert.status === "error" ? "Task hit an error" : "Task complete";
  els.alertDetails.textContent = `${alert.sessionName || "Session"} completed at ${formatDateTime(alert.completedAt)} after ${formatDuration(alert.durationMs)}.`;
  els.dismissButton.disabled = false;

  if (alert.key !== currentAlertKey) {
    currentAlertKey = alert.key;
    startBrowserAlarm(alert.status);
    sendNativeNotification(alert);
    document.title = alert.status === "error" ? "Codex error" : "Codex finished";
  }
}

function startBrowserAlarm(status) {
  if (!alertsArmed || !audioContext) return;
  stopBrowserAlarm();
  const pattern = status === "error" ? [520, 390, 520, 310] : [980, 740, 980, 620];
  let index = 0;
  alarmGain = audioContext.createGain();
  alarmGain.gain.value = 0.0001;
  alarmOscillator = audioContext.createOscillator();
  alarmOscillator.type = "square";
  alarmOscillator.frequency.value = pattern[0];
  alarmOscillator.connect(alarmGain);
  alarmGain.connect(audioContext.destination);
  alarmOscillator.start();
  alarmGain.gain.setTargetAtTime(0.08, audioContext.currentTime, 0.02);
  alarmTimer = window.setInterval(() => {
    if (!alarmOscillator) return;
    index = (index + 1) % pattern.length;
    alarmOscillator.frequency.setTargetAtTime(pattern[index], audioContext.currentTime, 0.015);
  }, 180);
}

function stopBrowserAlarm() {
  if (alarmTimer) window.clearInterval(alarmTimer);
  alarmTimer = null;
  if (alarmGain && audioContext) {
    alarmGain.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.02);
  }
  if (alarmOscillator) {
    const oscillator = alarmOscillator;
    window.setTimeout(() => {
      try {
        oscillator.stop();
        oscillator.disconnect();
      } catch {
        // Best effort.
      }
    }, 80);
  }
  if (alarmGain) {
    window.setTimeout(() => {
      try {
        alarmGain.disconnect();
      } catch {
        // Best effort.
      }
    }, 90);
  }
  alarmOscillator = null;
  alarmGain = null;
  document.title = "Codex Session Monitor";
}

function sendNativeNotification(alert) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return;
  const title = alert.status === "error" ? "Codex task error" : "Codex task finished";
  const notification = new Notification(title, {
    body: `${alert.sessionName || "Codex"}: ${formatDuration(alert.durationMs)}`,
    tag: alert.key,
    requireInteraction: true
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

notificationStatus = "Notification" in window ? Notification.permission : "unavailable";
updateArmButton();
connectEvents();
