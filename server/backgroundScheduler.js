import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { matchesCronExpression, validateCronExpression } from "../src/utils/batch/cronUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultTasksPath = path.resolve(__dirname, "scheduler.tasks.json");
const defaultLogPath = path.resolve(__dirname, "scheduler.log");

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    i += 1;
  }
  return args;
};

const args = parseArgs(process.argv.slice(2));
const tasksPath = path.resolve(String(args.tasks || defaultTasksPath));
const logPath = path.resolve(String(args.log || defaultLogPath));
const tickMs = Number(args["tick-ms"] || 1000);
const apiPort = args["api-port"] !== undefined ? Number(args["api-port"]) : 0;
const durationSeconds = args["duration-seconds"]
  ? Number(args["duration-seconds"])
  : null;

if (!Number.isFinite(tickMs) || tickMs <= 0) {
  console.error("Invalid --tick-ms, must be a positive number.");
  process.exit(1);
}

if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
  console.error("Invalid --duration-seconds, must be a positive number.");
  process.exit(1);
}

const runtimeState = new Map();
let stopping = false;
let intervalHandle = null;
let stopHandle = null;
let apiServer = null;

const ensureParentDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const writeLog = (level, message) => {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  console.log(line);
  ensureParentDir(logPath);
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
};

const normalizeTasks = (raw, options = {}) => {
  const includeDisabled = options.includeDisabled === true;

  if (!Array.isArray(raw)) {
    throw new Error("tasks file must be a JSON array");
  }

  const tasks = raw
    .map((task, index) => ({
      id: task.id || `task_${index + 1}`,
      name: task.name || `task_${index + 1}`,
      enabled: task.enabled !== false,
      runType: task.runType || "interval",
      intervalSeconds: Number(task.intervalSeconds || 60),
      runTime: task.runTime || null,
      cronExpression: task.cronExpression || null,
      runAt: task.runAt || null,
      action: task.action || "logMessage",
      payload: task.payload || {},
      timeoutMs: Number(task.timeoutMs || 10000),
    }));

  for (const task of tasks) {
    if (task.runType === "interval") {
      if (!Number.isFinite(task.intervalSeconds) || task.intervalSeconds <= 0) {
        throw new Error(`task ${task.id} has invalid intervalSeconds`);
      }
    }

    if (task.runType === "daily") {
      if (!/^\d{2}:\d{2}$/.test(String(task.runTime || ""))) {
        throw new Error(`task ${task.id} has invalid runTime, expected HH:mm`);
      }
    }

    if (task.runType === "cron") {
      const valid = validateCronExpression(task.cronExpression || "");
      if (!valid.valid) {
        throw new Error(`task ${task.id} has invalid cronExpression: ${valid.message}`);
      }
    }

    if (task.runType === "oneTime") {
      const runAtMs = Date.parse(String(task.runAt || ""));
      if (!Number.isFinite(runAtMs)) {
        throw new Error(`task ${task.id} has invalid runAt, expected ISO datetime`);
      }
    }

    if (!["logMessage", "httpPing", "batchPlan"].includes(task.action)) {
      throw new Error(`task ${task.id} has unsupported action: ${task.action}`);
    }
  }

  return includeDisabled ? tasks : tasks.filter((task) => task.enabled);
};

const loadTasks = () => {
  if (!fs.existsSync(tasksPath)) {
    writeLog("WARN", `tasks file not found at ${tasksPath}, scheduler is idle`);
    return [];
  }

  const fileText = fs.readFileSync(tasksPath, "utf8");
  if (!fileText.trim()) {
    return [];
  }

  const parsed = JSON.parse(fileText);
  return normalizeTasks(parsed);
};

const readStoredTasks = () => {
  if (!fs.existsSync(tasksPath)) {
    return [];
  }
  const text = fs.readFileSync(tasksPath, "utf8");
  if (!text.trim()) {
    return [];
  }
  const parsed = JSON.parse(text);
  return normalizeTasks(parsed, { includeDisabled: true });
};

const writeStoredTasks = (tasks) => {
  const normalized = normalizeTasks(tasks, { includeDisabled: true });
  ensureParentDir(tasksPath);
  fs.writeFileSync(tasksPath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
};

const sendJson = (res, statusCode, data) => {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(data));
};

const startApiServer = () => {
  if (!Number.isFinite(apiPort) || apiPort <= 0) {
    return;
  }

  apiServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scheduler/health") {
      sendJson(res, 200, {
        ok: true,
        tasksPath,
        logPath,
        tickMs,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scheduler/tasks") {
      try {
        const tasks = readStoredTasks();
        sendJson(res, 200, { ok: true, tasks });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/scheduler/tasks") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "[]");
          const tasks = writeStoredTasks(parsed);
          writeLog("INFO", `tasks updated via API, count=${tasks.length}`);
          sendJson(res, 200, { ok: true, tasks });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not Found" });
  });

  apiServer.listen(apiPort, "0.0.0.0", () => {
    writeLog("INFO", `scheduler API started on :${apiPort}`);
  });
};

const markExecuted = (task, nowMs) => {
  const state = runtimeState.get(task.id) || {};
  state.lastRunAt = nowMs;

  if (task.runType === "interval") {
    state.nextRunAt = nowMs + task.intervalSeconds * 1000;
  }

  if (task.runType === "daily") {
    state.lastDailyKey = `${new Date(nowMs).toISOString().slice(0, 10)}_${task.runTime}`;
  }

  if (task.runType === "cron") {
    const d = new Date(nowMs);
    state.lastCronKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
  }

  if (task.runType === "oneTime") {
    state.executed = true;
  }

  runtimeState.set(task.id, state);
};

const shouldRunTask = (task, now) => {
  const state = runtimeState.get(task.id) || {};
  const nowMs = now.getTime();

  if (task.runType === "interval") {
    const nextRunAt = state.nextRunAt ?? nowMs;
    return nowMs >= nextRunAt;
  }

  if (task.runType === "daily") {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const current = `${hh}:${mm}`;
    if (current !== task.runTime) return false;

    const dailyKey = `${now.toISOString().slice(0, 10)}_${task.runTime}`;
    return state.lastDailyKey !== dailyKey;
  }

  if (task.runType === "cron") {
    if (!matchesCronExpression(task.cronExpression, now)) return false;
    const cronKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    return state.lastCronKey !== cronKey;
  }

  if (task.runType === "oneTime") {
    if (state.executed) return false;
    const runAtMs = Date.parse(String(task.runAt || ""));
    return Number.isFinite(runAtMs) && nowMs >= runAtMs;
  }

  return false;
};

const executeTask = async (task) => {
  if (task.action === "logMessage") {
    const message = task.payload?.message || `${task.name} fired`;
    writeLog("TASK", `[${task.id}] ${message}`);
    return;
  }

  if (task.action === "httpPing") {
    const url = task.payload?.url;
    if (!url) {
      throw new Error("httpPing action requires payload.url");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      writeLog("TASK", `[${task.id}] HTTP ${response.status} ${url}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (task.action === "batchPlan") {
    const accountName = task.payload?.accountName || "unknown";
    const taskNames = Array.isArray(task.payload?.taskNames)
      ? task.payload.taskNames
      : [];
    writeLog(
      "TASK",
      `[${task.id}] account=${accountName} batchTasks=${taskNames.join(",") || "(none)"}`,
    );
    return;
  }
};

const tick = async () => {
  if (stopping) return;

  let tasks = [];
  try {
    tasks = loadTasks();
  } catch (error) {
    writeLog("ERROR", `failed to load tasks: ${error.message}`);
    return;
  }

  const now = new Date();

  for (const task of tasks) {
    if (!shouldRunTask(task, now)) continue;

    try {
      await executeTask(task);
      markExecuted(task, now.getTime());
    } catch (error) {
      writeLog("ERROR", `[${task.id}] execution failed: ${error.message}`);
      markExecuted(task, now.getTime());
    }
  }
};

const stop = (signal = "manual") => {
  if (stopping) return;
  stopping = true;

  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  if (stopHandle) {
    clearTimeout(stopHandle);
    stopHandle = null;
  }

  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }

  writeLog("INFO", `background scheduler stopped (${signal})`);
};

const start = () => {
  writeLog("INFO", `background scheduler started (tasks=${tasksPath}, log=${logPath}, tickMs=${tickMs})`);
  startApiServer();

  intervalHandle = setInterval(() => {
    tick().catch((error) => {
      writeLog("ERROR", `tick failed: ${error.message}`);
    });
  }, tickMs);

  tick().catch((error) => {
    writeLog("ERROR", `initial tick failed: ${error.message}`);
  });

  if (durationSeconds !== null) {
    stopHandle = setTimeout(() => {
      stop("duration reached");
      process.exit(0);
    }, durationSeconds * 1000);
  }
};

process.on("SIGINT", () => {
  stop("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  stop("SIGTERM");
  process.exit(0);
});

start();
