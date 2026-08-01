const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ALARM_MODES = new Set(["urgent", "gentle", "silent"]);

const ALARM_PROFILES = {
  urgent: {
    finished: { frequencies: [980, 740, 980, 620], durationMs: 180, gapMs: 80, cycleGapMs: 260 },
    error: { frequencies: [520, 390, 520, 310], durationMs: 180, gapMs: 80, cycleGapMs: 260 }
  },
  gentle: {
    finished: { frequencies: [660, 880], durationMs: 150, gapMs: 120, cycleGapMs: 700 },
    error: { frequencies: [440, 330], durationMs: 180, gapMs: 120, cycleGapMs: 650 }
  },
  silent: {
    finished: { frequencies: [], durationMs: 0, gapMs: 0, cycleGapMs: 0 },
    error: { frequencies: [], durationMs: 0, gapMs: 0, cycleGapMs: 0 }
  }
};

class BackendAlarm {
  constructor({ stopFile, runtimeDir, platform = process.platform, commandExists = defaultCommandExists }) {
    this.stopFile = stopFile;
    this.runtimeDir = runtimeDir;
    this.platform = platform;
    this.commandExists = commandExists;
    this.process = null;
    this.backendName = "none";
  }

  start(status, mode = "urgent") {
    this.stop();
    const normalizedMode = normalizeAlarmMode(mode);
    if (normalizedMode === "silent") {
      this.backendName = "silent";
      return;
    }

    try {
      if (fs.existsSync(this.stopFile)) fs.unlinkSync(this.stopFile);
      fs.mkdirSync(this.runtimeDir, { recursive: true });
    } catch {
      // Best effort; the visual/browser alarm still works.
    }

    const command = this.buildCommand(status, normalizedMode);
    if (!command) {
      this.backendName = "unavailable";
      return;
    }

    try {
      this.backendName = command.name;
      this.process = spawn(command.file, command.args, command.options || { stdio: "ignore" });
      this.process.on("exit", () => {
        this.process = null;
      });
    } catch {
      this.backendName = "unavailable";
      this.process = null;
    }
  }

  stop() {
    try {
      fs.writeFileSync(this.stopFile, "stop");
    } catch {
      // Best effort.
    }
    if (this.process && !this.process.killed) {
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          try {
            this.process.kill();
          } catch {
            // Best effort.
          }
        }
      }, 350);
    }
  }

  buildCommand(status, mode) {
    const profile = getAlarmProfile(status, mode);
    if (!profile.frequencies.length) return null;
    if (this.platform === "win32") return this.buildWindowsCommand(profile);
    if (this.platform === "darwin") return this.buildMacCommand(status);
    return this.buildLinuxCommand(status, profile);
  }

  buildWindowsCommand(profile) {
    const sequence = [];
    for (const frequency of profile.frequencies) {
      sequence.push(`  [Console]::Beep(${frequency}, ${profile.durationMs})`);
      sequence.push(`  Start-Sleep -Milliseconds ${profile.gapMs}`);
    }
    const script = [
      `$stop = ${psQuote(this.stopFile)}`,
      `while (-not (Test-Path -LiteralPath $stop)) {`,
      ...sequence,
      `  Start-Sleep -Milliseconds ${profile.cycleGapMs}`,
      `}`
    ].join("; ");

    return {
      name: "windows-console-beep",
      file: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      options: { windowsHide: true, stdio: "ignore" }
    };
  }

  buildMacCommand(status) {
    if (!this.commandExists("afplay")) return null;
    const sound = status === "error"
      ? "/System/Library/Sounds/Basso.aiff"
      : "/System/Library/Sounds/Glass.aiff";
    const script = `stop="$1"; sound="$2"; while [ ! -f "$stop" ]; do afplay "$sound"; sleep 0.25; done`;
    return {
      name: "macos-afplay",
      file: "sh",
      args: ["-c", script, "codex-session-monitor-alarm", this.stopFile, sound],
      options: { stdio: "ignore" }
    };
  }

  buildLinuxCommand(status, profile) {
    const wavFile = path.join(this.runtimeDir, `${status === "error" ? "error" : "finished"}-${profile.frequencies.join("-")}.wav`);
    try {
      writeToneWav(wavFile, profile);
    } catch {
      // Keep trying command fallbacks below.
    }

    if (this.commandExists("paplay")) {
      return loopCommand("linux-paplay", "sh", this.stopFile, ["paplay", wavFile]);
    }
    if (this.commandExists("aplay")) {
      return loopCommand("linux-aplay", "sh", this.stopFile, ["aplay", "-q", wavFile]);
    }
    if (this.commandExists("ffplay")) {
      return loopCommand("linux-ffplay", "sh", this.stopFile, ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", wavFile]);
    }
    return null;
  }
}

function loopCommand(name, shell, stopFile, commandParts) {
  const command = commandParts.map(shQuote).join(" ");
  const script = `stop="$1"; while [ ! -f "$stop" ]; do ${command}; sleep 0.25; done`;
  return {
    name,
    file: shell,
    args: ["-c", script, "codex-session-monitor-alarm", stopFile],
    options: { stdio: "ignore" }
  };
}

function normalizeAlarmMode(mode) {
  const normalized = String(mode || "urgent").toLowerCase();
  return ALARM_MODES.has(normalized) ? normalized : "urgent";
}

function getAlarmProfile(status, mode = "urgent") {
  const normalizedMode = normalizeAlarmMode(mode);
  const normalizedStatus = status === "error" ? "error" : "finished";
  return ALARM_PROFILES[normalizedMode][normalizedStatus];
}

function writeToneWav(file, profile) {
  const sampleRate = 44100;
  const samples = [];
  for (const frequency of profile.frequencies) {
    appendTone(samples, frequency, profile.durationMs, sampleRate);
    appendSilence(samples, profile.gapMs, sampleRate);
  }
  appendSilence(samples, profile.cycleGapMs, sampleRate);

  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }
  fs.writeFileSync(file, buffer);
}

function appendTone(samples, frequency, durationMs, sampleRate) {
  const count = Math.floor((durationMs / 1000) * sampleRate);
  for (let index = 0; index < count; index += 1) {
    const envelope = Math.min(1, index / 220, (count - index) / 220);
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.24 * envelope;
    samples.push(Math.round(sample * 32767));
  }
}

function appendSilence(samples, durationMs, sampleRate) {
  const count = Math.floor((durationMs / 1000) * sampleRate);
  for (let index = 0; index < count; index += 1) samples.push(0);
}

function defaultCommandExists(command) {
  if (process.platform === "win32") {
    return spawnSync("where.exe", [command], { stdio: "ignore" }).status === 0;
  }
  const result = spawnSync("sh", ["-c", `command -v ${shQuote(command)}`], { stdio: "ignore" });
  return result.status === 0;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  ALARM_PROFILES,
  BackendAlarm,
  getAlarmProfile,
  normalizeAlarmMode,
  writeToneWav
};
