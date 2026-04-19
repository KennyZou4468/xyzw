import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { matchesCronExpression, validateCronExpression } from "../src/utils/batch/cronUtils.js";
import { availableTasks } from "../src/utils/batch/constants.js";
import { executeBatchPlanInBackend, SUPPORTED_TASKS } from "./backendBatchExecutor.js";
import {
  executeBatchPlanWithPlaywright,
  isPlaywrightExecutionEnabled,
} from "./playwrightBatchExecutor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultTasksPath = path.resolve(__dirname, "scheduler.tasks.json");
const defaultLogPath = path.resolve(__dirname, "scheduler.log");
const defaultUiLogsPath = path.resolve(__dirname, "scheduler.ui.logs.json");
const defaultLockPath = path.resolve(__dirname, "scheduler.lock");

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
const uiLogsPath = path.resolve(String(args["ui-logs"] || defaultUiLogsPath));
const tickMs = Number(args["tick-ms"] || 1000);
const apiPort = args["api-port"] !== undefined ? Number(args["api-port"]) : 0;
const dailyCatchUpMinutes = Number(args["daily-catchup-minutes"] || 180);
const lockPath = path.resolve(String(args.lock || defaultLockPath));
const statePath = path.resolve(
  String(args.state || path.join(path.dirname(lockPath), "scheduler.state.json")),
);
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

if (!Number.isFinite(dailyCatchUpMinutes) || dailyCatchUpMinutes < 0) {
  console.error("Invalid --daily-catchup-minutes, must be a non-negative number.");
  process.exit(1);
}

const runtimeState = new Map();
let stopping = false;
let intervalHandle = null;
let stopHandle = null;
let apiServer = null;
let instanceLockAcquired = false;

const ensureParentDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const sanitizeRuntimeStateEntry = (state) => {
  if (!state || typeof state !== "object") return null;
  return {
    lastRunAt: Number(state.lastRunAt || 0) || null,
    nextRunAt: Number(state.nextRunAt || 0) || null,
    lastDailyKey: state.lastDailyKey || null,
    lastCronKey: state.lastCronKey || null,
    executed: Boolean(state.executed),
  };
};

const loadRuntimeStateFromDisk = () => {
  try {
    if (!fs.existsSync(statePath)) return;
    const text = fs.readFileSync(statePath, "utf8");
    if (!text.trim()) return;

    const parsed = JSON.parse(text);
    const entries = Object.entries(parsed || {});
    for (const [taskId, state] of entries) {
      const sanitized = sanitizeRuntimeStateEntry(state);
      if (!sanitized) continue;
      runtimeState.set(taskId, { ...sanitized, running: false });
    }
  } catch (error) {
    writeLog("WARN", `failed to load runtime state: ${error.message}`);
  }
};

const persistRuntimeStateToDisk = () => {
  try {
    const payload = {};
    for (const [taskId, state] of runtimeState.entries()) {
      payload[taskId] = sanitizeRuntimeStateEntry(state);
    }

    ensureParentDir(statePath);
    fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    writeLog("WARN", `failed to persist runtime state: ${error.message}`);
  }
};

const normalizeLogMessage = (message) => {
  const raw = String(message ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  const noisePatterns = [
    /^at\s+/i,
    /^call log:?$/i,
    /^-\s+navigating to\s+/i,
    /^-\s+waiting for\s+/i,
  ];

  const filtered = lines.filter((line) => !noisePatterns.some((pattern) => pattern.test(line)));
  const picked = (filtered[0] || lines[0] || "").trim();
  return picked || "";
};

const writeLog = (level, message) => {
  const normalizedMessage = normalizeLogMessage(message);
  const line = `${new Date().toISOString()} [${level}] ${normalizedMessage}`;
  console.log(line);
  ensureParentDir(logPath);
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
};

const isProcessRunning = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tryAcquireLockFile = () => {
  ensureParentDir(lockPath);
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const fd = fs.openSync(lockPath, "wx");
  fs.writeFileSync(fd, content, "utf8");
  fs.closeSync(fd);
  instanceLockAcquired = true;
};

const acquireInstanceLock = () => {
  try {
    tryAcquireLockFile();
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  let stalePid = null;
  try {
    const existing = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(existing);
    stalePid = Number(parsed?.pid);
  } catch {
    stalePid = null;
  }

  // Container restarts often reuse PID 1; treat same-pid lock as stale.
  if (stalePid === process.pid) {
    stalePid = null;
  }

  if (isProcessRunning(stalePid)) {
    throw new Error(`scheduler lock exists at ${lockPath}, pid=${stalePid}`);
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  tryAcquireLockFile();
};

const releaseInstanceLock = () => {
  if (!instanceLockAcquired) {
    return;
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`failed to release scheduler lock: ${error.message}`);
    }
  } finally {
    instanceLockAcquired = false;
  }
};

const isDirectExecution = () => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const entryPath = path.resolve(entry);
  return entryPath === __filename;
};

const normalizeTasks = (raw, options = {}) => {
  const includeDisabled = options.includeDisabled === true;

  if (!Array.isArray(raw)) {
    throw new Error("tasks file must be a JSON array");
  }

  const tasks = raw
    .map((task, index) => {
      const normalized = {
        ...task,
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
      };

      if (!Array.isArray(normalized.selectedTokens)) {
        normalized.selectedTokens = [];
      }

      if (!Array.isArray(normalized.selectedTasks)) {
        normalized.selectedTasks = [];
      }

      if (
        normalized.selectedTasks.length > 0 &&
        (!task.action || task.action === "logMessage")
      ) {
        normalized.action = "batchPlan";
        normalized.payload = {
          ...normalized.payload,
          taskNames: normalized.selectedTasks,
          selectedTokens: normalized.selectedTokens,
          accountName:
            normalized.payload?.accountName ||
            normalized.name ||
            normalized.id,
        };
      }

      return normalized;
    });

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

const buildScheduleSignature = (task) => {
  return [
    task?.runType || "",
    String(task?.intervalSeconds ?? ""),
    String(task?.runTime ?? ""),
    String(task?.cronExpression ?? ""),
    String(task?.runAt ?? ""),
    String(task?.enabled ?? true),
    String(task?.action ?? ""),
  ].join("|");
};

const reconcileRuntimeStateWithTasks = (previousTasks, nextTasks) => {
  const prevList = Array.isArray(previousTasks) ? previousTasks : [];
  const nextList = Array.isArray(nextTasks) ? nextTasks : [];

  const prevById = new Map(prevList.map((task) => [task.id, task]));
  const nextIds = new Set(nextList.map((task) => task.id));
  let stateChanged = false;

  // Remove runtime state for tasks that no longer exist.
  for (const taskId of runtimeState.keys()) {
    if (!nextIds.has(taskId)) {
      if (runtimeState.delete(taskId)) {
        stateChanged = true;
      }
    }
  }

  let resetCount = 0;
  for (const task of nextList) {
    const prev = prevById.get(task.id);
    if (!prev) {
      if (runtimeState.delete(task.id)) {
        stateChanged = true;
      }
      continue;
    }

    if (buildScheduleSignature(prev) !== buildScheduleSignature(task)) {
      if (runtimeState.delete(task.id)) {
        stateChanged = true;
      }
      resetCount += 1;
    }
  }

  if (stateChanged) {
    persistRuntimeStateToDisk();
  }

  return resetCount;
};

const writeStoredTasks = (tasks) => {
  const normalized = normalizeTasks(tasks, { includeDisabled: true });
  ensureParentDir(tasksPath);
  fs.writeFileSync(tasksPath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
};

const migrateStoredTasks = () => {
  const rawTasks = readStoredTasks();
  let changedCount = 0;
  const missingCredentials = [];

  const migrated = rawTasks.map((task) => {
    let changed = false;
    const next = {
      ...task,
      selectedTasks: Array.isArray(task.selectedTasks) ? task.selectedTasks : [],
      selectedTokens: Array.isArray(task.selectedTokens) ? task.selectedTokens : [],
      payload: { ...(task.payload || {}) },
    };

    if (next.selectedTasks.length > 0 && (next.action === "logMessage" || !next.action)) {
      next.action = "batchPlan";
      changed = true;
    }

    if (next.action === "batchPlan") {
      if (!Array.isArray(next.payload.taskNames) || next.payload.taskNames.length === 0) {
        next.payload.taskNames = next.selectedTasks;
        changed = true;
      }

      if (!Array.isArray(next.payload.selectedTokens) || next.payload.selectedTokens.length === 0) {
        next.payload.selectedTokens = next.selectedTokens;
        changed = true;
      }

      if (!next.payload.accountName) {
        next.payload.accountName = next.name || next.id || "unknown";
        changed = true;
      }

      if (!Array.isArray(next.payload.tokenCredentials) || next.payload.tokenCredentials.length === 0) {
        missingCredentials.push(next.id);
      }
    }

    if (changed) {
      changedCount += 1;
    }

    return next;
  });

  writeStoredTasks(migrated);
  return {
    tasks: migrated,
    changedCount,
    missingCredentials,
  };
};

const getCapabilities = () => {
  const frontendTaskNames = Array.isArray(availableTasks)
    ? availableTasks.map((item) => item?.value).filter(Boolean)
    : [];
  const supported = new Set(SUPPORTED_TASKS);

  const taskSupport = frontendTaskNames.map((taskName) => ({
    taskName,
    supported: supported.has(taskName),
  }));

  const defaultExecutionEngine = String(process.env.XYZW_EXECUTION_ENGINE || "playwright").toLowerCase();

  return {
    frontendTaskCount: frontendTaskNames.length,
    backendSupportedCount: SUPPORTED_TASKS.length,
    taskSupport,
    supportedTaskNames: SUPPORTED_TASKS,
    executionEngines: {
      default: defaultExecutionEngine,
      supported: ["auto", "playwright", "legacy"],
      playwrightAvailable: defaultExecutionEngine === "playwright" || defaultExecutionEngine === "auto",
    },
  };
};

const sendJson = (res, statusCode, data) => {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(data));
};

const readSchedulerLogLines = (tail = 200, sinceMs = 0) => {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const isNoiseLogLine = (text) => {
    const line = String(text || "").trim();
    if (!line) return true;
    return (
      /^at\s+/i.test(line) ||
      /^call log:?$/i.test(line) ||
      /^-\s+navigating to\s+/i.test(line) ||
      /^-\s+waiting until\s+/i.test(line) ||
      /^-\s+waiting for\s+/i.test(line)
    );
  };

  const text = fs.readFileSync(logPath, "utf8");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isNoiseLogLine(line));

  const typeMap = {
    ERROR: "error",
    WARN: "warning",
    TASK: "success",
    INFO: "info",
  };

  const normalized = lines.map((line, index) => {
    const match = line.match(/^(\S+)\s+\[(\w+)\]\s+(.*)$/);
    if (!match) {
      if (isNoiseLogLine(line)) {
        return null;
      }
      return {
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now(),
        sequence: index + 1,
        type: "info",
        message: line,
      };
    }

    const [, isoTime, level, message] = match;
    const parsedTime = Date.parse(isoTime);
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : Date.now();

    return {
      time: new Date(isoTime).toLocaleTimeString(),
      timestamp,
      sequence: index + 1,
      type: typeMap[level] || "info",
      message,
    };
  }).filter(Boolean);

  const filtered = Number(sinceMs) > 0
    ? normalized.filter((item) => Number(item.timestamp || 0) > Number(sinceMs))
    : normalized;

  return filtered.slice(-Math.max(1, tail));
};

const readUiLogs = () => {
  if (!fs.existsSync(uiLogsPath)) {
    return [];
  }

  const text = fs.readFileSync(uiLogsPath, "utf8");
  if (!text.trim()) {
    return [];
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
};

const writeUiLogs = (items) => {
  const logs = Array.isArray(items) ? items : [];
  ensureParentDir(uiLogsPath);
  fs.writeFileSync(uiLogsPath, JSON.stringify(logs, null, 2), "utf8");
  return logs;
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

    if (req.method === "GET" && url.pathname === "/api/scheduler/capabilities") {
      try {
        sendJson(res, 200, {
          ok: true,
          capabilities: getCapabilities(),
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
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

    if (req.method === "GET" && url.pathname === "/api/scheduler/logs") {
      try {
        const tail = Number(url.searchParams.get("tail") || 200);
        const sinceMs = Number(url.searchParams.get("sinceMs") || 0);
        const logs = readSchedulerLogLines(tail, sinceMs);
        sendJson(res, 200, { ok: true, logs });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scheduler/ui-logs") {
      try {
        const logs = readUiLogs();
        sendJson(res, 200, { ok: true, logs });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/scheduler/ui-logs") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "[]");
          const logs = writeUiLogs(parsed);
          sendJson(res, 200, { ok: true, logsCount: logs.length });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/scheduler/tasks") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const previousTasks = readStoredTasks();
          const parsed = JSON.parse(body || "[]");
          const tasks = writeStoredTasks(parsed);
          const resetCount = reconcileRuntimeStateWithTasks(previousTasks, tasks);
          writeLog("INFO", `tasks updated via API, count=${tasks.length}`);
          if (resetCount > 0) {
            writeLog("INFO", `runtime state reset for ${resetCount} task(s) after schedule change`);
          }
          sendJson(res, 200, { ok: true, tasks });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scheduler/tasks/migrate") {
      try {
        const result = migrateStoredTasks();
        writeLog(
          "INFO",
          `tasks migrated via API, changed=${result.changedCount}, missingCredentials=${result.missingCredentials.length}`,
        );
        sendJson(res, 200, {
          ok: true,
          changedCount: result.changedCount,
          missingCredentials: result.missingCredentials,
          tasks: result.tasks,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
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
  persistRuntimeStateToDisk();
};

const shouldRunTask = (task, now) => {
  const state = runtimeState.get(task.id) || {};
  const nowMs = now.getTime();

  if (state.running) {
    return false;
  }

  if (task.runType === "interval") {
    const nextRunAt = state.nextRunAt ?? nowMs;
    return nowMs >= nextRunAt;
  }

  if (task.runType === "daily") {
    const dailyKey = `${now.toISOString().slice(0, 10)}_${task.runTime}`;
    if (state.lastDailyKey === dailyKey) return false;

    const [hourStr, minuteStr] = String(task.runTime || "").split(":");
    const targetHour = Number(hourStr);
    const targetMinute = Number(minuteStr);
    if (!Number.isFinite(targetHour) || !Number.isFinite(targetMinute)) {
      return false;
    }

    const targetTime = new Date(now);
    targetTime.setHours(targetHour, targetMinute, 0, 0);
    const targetMs = targetTime.getTime();
    const oneMinuteMs = 60 * 1000;

    // Exact minute window: preserve existing behavior.
    if (nowMs >= targetMs && nowMs < targetMs + oneMinuteMs) {
      return true;
    }

    // Catch-up window: if exact minute is missed, run once within configured grace period.
    if (dailyCatchUpMinutes > 0 && nowMs > targetMs) {
      const catchUpMs = dailyCatchUpMinutes * 60 * 1000;
      return nowMs - targetMs <= catchUpMs;
    }

    return false;
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
    const message =
      task.payload?.message || `${task.name} triggered (logMessage only)`;
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
    const schedulerLogger = (message, level = "info") => {
      const mappedLevel =
        level === "error"
          ? "ERROR"
          : level === "warn"
            ? "WARN"
            : level === "success"
              ? "TASK"
              : "INFO";
      writeLog(mappedLevel, message);
    };

    const taskExecutionEngine = String(
      task?.payload?.executionEngine ||
        task?.executionEngine ||
        process.env.XYZW_EXECUTION_ENGINE ||
        "playwright",
    ).toLowerCase();
    schedulerLogger(`batchPlan执行引擎: ${taskExecutionEngine}`, "info");

    if (isPlaywrightExecutionEnabled(task)) {
      try {
        schedulerLogger("优先使用 Playwright 浏览器执行引擎", "info");
        await executeBatchPlanWithPlaywright(task, schedulerLogger);
        return;
      } catch (error) {
        schedulerLogger(
          `Playwright执行失败，回退到旧后端执行器: ${error.message}`,
          "warn",
        );
      }
    }

    await executeBatchPlanInBackend(task, schedulerLogger);
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

    const state = runtimeState.get(task.id) || {};
    state.running = true;
    runtimeState.set(task.id, state);

    try {
      await executeTask(task);
      markExecuted(task, now.getTime());
    } catch (error) {
      writeLog("ERROR", `[${task.id}] execution failed: ${error.message}`);
      markExecuted(task, now.getTime());
    } finally {
      const latest = runtimeState.get(task.id) || {};
      latest.running = false;
      runtimeState.set(task.id, latest);
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

  releaseInstanceLock();

  writeLog("INFO", `background scheduler stopped (${signal})`);
  writeLog("INFO", "=== 定时任务调度服务已停止 ===");
};

const start = () => {
  acquireInstanceLock();
  loadRuntimeStateFromDisk();
  writeLog("INFO", `background scheduler started (tasks=${tasksPath}, log=${logPath}, tickMs=${tickMs})`);
  writeLog("INFO", "=== 定时任务调度服务已启动 ===");
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

process.on("exit", () => {
  releaseInstanceLock();
});

if (isDirectExecution()) {
  start();
}
