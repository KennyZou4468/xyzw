import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, getEnc } from "../src/utils/bonProtocol.js";

const DEFAULT_APP_URL = "http://127.0.0.1:8080/admin/batch-daily-tasks";
const DEFAULT_PROFILE_DIR = "/srv/xyzw/browser-profile";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SCHEDULER_TASKS_PATH = path.resolve(process.cwd(), "server/scheduler.tasks.json");

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensurePersistentProfileDir = (dirPath, logger = () => {}) => {
  ensureDir(dirPath);
  try {
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new Error(`Playwright profile目录不可读写: ${dirPath} (${error.message})`);
  }
  logger(`Playwright持久化目录检查通过: ${dirPath}`, "info");
};

const isRunningInDocker = () => {
  try {
    if (fs.existsSync("/.dockerenv")) return true;
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
};

const resolveAppUrlForEnvironment = (rawUrl, logger = () => {}) => {
  const inDocker = isRunningInDocker();
  const url = new URL(rawUrl || DEFAULT_APP_URL);
  const original = url.toString();

  if (inDocker && ["127.0.0.1", "localhost"].includes(url.hostname)) {
    url.hostname = "web";
    if (!url.port) {
      url.port = "80";
    }
  }

  const publicHost = process.env.XYZW_PLAYWRIGHT_PUBLIC_HOST || "127.0.0.1";
  const publicPort = process.env.XYZW_PLAYWRIGHT_PUBLIC_PORT || "8080";
  if (!inDocker && url.hostname === "web") {
    url.hostname = publicHost;
    if (!url.port || url.port === "80") {
      url.port = publicPort;
    }
  }

  const resolved = url.toString();
  if (resolved !== original) {
    logger(`Playwright环境适配: ${original} -> ${resolved}`, "info");
  } else {
    logger(`Playwright环境适配: 使用 ${resolved}`, "info");
  }
  logger(`Playwright环境检测: inDocker=${inDocker}`, "info");

  return resolved;
};

const resolvePlaywrightExecutablePath = () => {
  const envPath = process.env.XYZW_PLAYWRIGHT_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const home = os.homedir();
  const candidates = [
    path.join(
      home,
      "Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
    path.join(
      home,
      "Library/Caches/ms-playwright/chromium-1208/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || undefined;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const normalizeConsoleMessage = (text) => {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  // Keep only non-stack lines and avoid flooding scheduler logs with repeated call stacks.
  const nonStackLines = lines.filter((line) => !/^at\s+/.test(line));
  const firstMeaningful = (nonStackLines[0] || lines[0] || "").trim();
  if (!firstMeaningful) return "";

  // Typical noisy call-stack line accidentally logged as a standalone console error.
  if (/^at\s+async\s+/i.test(firstMeaningful) || /^at\s+/.test(firstMeaningful)) {
    return "";
  }

  return firstMeaningful;
};

const parseTimestamp = (value) => {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
};

const parseActualToken = (rawToken) => {
  if (!rawToken || typeof rawToken !== "string") {
    throw new Error("token is empty");
  }

  const trimmed = rawToken.trim();
  if (!trimmed) {
    throw new Error("token is empty");
  }

  const maybeBase64 = trimmed.replace(/^data:.*base64,/, "");
  try {
    const decoded = Buffer.from(maybeBase64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed?.token || parsed?.gameToken || decoded || trimmed;
  } catch {
    return trimmed;
  }
};

const resolveSchedulerTasksPath = () => {
  const candidates = [
    process.env.XYZW_SCHEDULER_TASKS_PATH,
    "/app/runtime/scheduler.tasks.json",
    DEFAULT_SCHEDULER_TASKS_PATH,
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
};

const buildLatestCredentialMap = (tasks) => {
  const map = new Map();
  const scoreMap = new Map();

  ensureArray(tasks).forEach((task, taskIndex) => {
    const credentials = ensureArray(task?.payload?.tokenCredentials);
    credentials.forEach((credential, credentialIndex) => {
      if (!credential?.id) return;
      const timestamp = Math.max(
        parseTimestamp(credential.updatedAt),
        parseTimestamp(credential.upgradedAt),
      );
      const fallbackOrder = taskIndex * 1000 + credentialIndex;
      const score = timestamp > 0 ? timestamp : fallbackOrder;
      const prev = scoreMap.get(credential.id) || -1;
      if (score >= prev) {
        map.set(credential.id, credential);
        scoreMap.set(credential.id, score);
      }
    });
  });

  return map;
};

const loadGlobalLatestCredentialMap = () => {
  const schedulerTasksPath = resolveSchedulerTasksPath();
  try {
    if (!schedulerTasksPath || !fs.existsSync(schedulerTasksPath)) {
      return new Map();
    }

    const text = fs.readFileSync(schedulerTasksPath, "utf8");
    if (!text.trim()) {
      return new Map();
    }

    const tasks = JSON.parse(text);
    return buildLatestCredentialMap(tasks);
  } catch {
    return new Map();
  }
};

const mergeWithLatestTokenCredentials = (tokenCredentials, logger = () => {}) => {
  const latestMap = loadGlobalLatestCredentialMap();
  if (latestMap.size === 0) return tokenCredentials;

  let refreshedCount = 0;
  const merged = tokenCredentials.map((credential) => {
    const latest = latestMap.get(credential?.id);
    if (!latest) return credential;

    const tokenChanged = String(latest.token || "") !== String(credential.token || "");
    const wsChanged = String(latest.wsUrl || "") !== String(credential.wsUrl || "");
    const latestBinData = String(latest.binData || "");
    const currentBinData = String(credential.binData || "");
    const binChanged = latestBinData !== currentBinData;
    if (!tokenChanged && !wsChanged && !binChanged) return credential;

    refreshedCount += 1;
    return {
      ...credential,
      token: latest.token || credential.token,
      wsUrl: latest.wsUrl || credential.wsUrl || null,
      importMethod: latest.importMethod || credential.importMethod,
      sourceUrl: latest.sourceUrl || credential.sourceUrl || null,
      binData: latest.binData || credential.binData,
      binDataEncoding: latest.binDataEncoding || credential.binDataEncoding,
      binDataUpdatedAt: latest.binDataUpdatedAt || credential.binDataUpdatedAt,
      updatedAt: latest.updatedAt || credential.updatedAt,
    };
  });

  if (refreshedCount > 0) {
    logger(`Playwright Token预检：检测到 ${refreshedCount} 个账号快照过旧，已替换为最新凭证`, "info");
  }

  return merged;
};

const extractTokenFromSourcePayload = (payload) => {
  if (!payload) return "";
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed);
      return extractTokenFromSourcePayload(parsed);
    } catch {
      return trimmed;
    }
  }
  if (typeof payload !== "object") return "";
  const token = payload.token || payload.data?.token || payload.result?.token;
  if (typeof token === "string") {
    return token.trim();
  }
  return "";
};

const refreshCredentialTokenFromSource = async (credential, logger = () => {}) => {
  if (!credential || !credential.sourceUrl) {
    return credential;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(credential.sourceUrl, {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response?.ok) {
      throw new Error(`http ${response?.status || "unknown"}`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    const refreshedToken = extractTokenFromSourcePayload(payload);
    if (!refreshedToken || refreshedToken === credential.token) {
      return credential;
    }

    logger(`${credential.name || credential.id} 已从URL刷新Token(Playwright)`, "info");
    return {
      ...credential,
      token: refreshedToken,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger(
      `${credential.name || credential.id} Token刷新失败，继续使用缓存Token(Playwright): ${error.message}`,
      "warn",
    );
    return credential;
  }
};

const decodeBinDataToBuffer = (rawData, encodingHint = "base64") => {
  if (!rawData) return null;

  if (Buffer.isBuffer(rawData)) return rawData;
  if (rawData instanceof Uint8Array) return Buffer.from(rawData);
  if (Array.isArray(rawData)) return Buffer.from(rawData);

  if (typeof rawData !== "string") return null;
  const text = rawData.trim();
  if (!text) return null;

  const hint = String(encodingHint || "").toLowerCase();
  try {
    if (hint === "hex") {
      return Buffer.from(text, "hex");
    }
    const normalized = text.replace(/^data:.*;base64,/, "").replace(/\s+/g, "");
    return Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
};

const refreshCredentialTokenFromBinData = async (credential, logger = () => {}) => {
  if (!credential?.binData) {
    return credential;
  }

  const method = String(credential.importMethod || "").toLowerCase();
  if (method !== "bin" && method !== "wxqrcode") {
    return credential;
  }

  const payloadBuffer = decodeBinDataToBuffer(
    credential.binData,
    credential.binDataEncoding || "base64",
  );
  if (!payloadBuffer || payloadBuffer.byteLength === 0) {
    logger(`${credential.name || credential.id} BIN刷新数据无效，继续使用缓存Token(Playwright)`, "warn");
    return credential;
  }

  try {
    const response = await fetch("https://xxz-xyzw.hortorgames.com/login/authuser?_seq=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        referrerPolicy: "no-referrer",
      },
      body: payloadBuffer,
    });

    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }

    const raw = new Uint8Array(await response.arrayBuffer());
    const msg = parse(raw, getEnc("auto"));
    const data = msg?.getData?.();
    if (!data?.roleToken || !data?.roleId) {
      throw new Error("authuser returned invalid payload");
    }

    const now = Date.now();
    const sessId = now * 100 + Math.floor(Math.random() * 100);
    const connId = now + Math.floor(Math.random() * 10);

    const refreshedToken = JSON.stringify({
      ...data,
      sessId,
      connId,
      isRestore: 0,
    });

    logger(`${credential.name || credential.id} 已从BIN刷新Token(Playwright)`, "info");
    return {
      ...credential,
      token: refreshedToken,
      version: (credential.version || 0) + 1,
      lastRefreshed: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger(
      `${credential.name || credential.id} BIN刷新失败，继续使用缓存Token(Playwright): ${error.message}`,
      "warn",
    );
    return credential;
  }
};

const sanitizeTokenCredentialsBeforeRun = (tokenCredentials, logger = () => {}) => {
  const seenTokenIds = new Set();
  const sanitized = [];

  for (const credential of ensureArray(tokenCredentials)) {
    if (!credential?.id) continue;
    if (seenTokenIds.has(credential.id)) {
      logger(`Playwright Token预检：检测到重复tokenId，已跳过 ${credential.name || credential.id}`, "warn");
      continue;
    }
    seenTokenIds.add(credential.id);
    sanitized.push(credential);
  }

  return sanitized;
};

const regenerateTokenSessionFields = (credential) => {
  try {
    if (!credential?.token) return credential;

    const tokenText = parseActualToken(String(credential.token || ""));
    if (!tokenText || !tokenText.trim().startsWith("{")) {
      return credential;
    }

    const parsed = JSON.parse(tokenText);
    if (!parsed?.roleToken || !parsed?.roleId) {
      return credential;
    }

    const now = Date.now();
    const sessId = now * 100 + Math.floor(Math.random() * 100);
    const connId = now + Math.floor(Math.random() * 10);

    return {
      ...credential,
      token: JSON.stringify({
        ...parsed,
        sessId,
        connId,
        isRestore: 0,
      }),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return credential;
  }
};

const regenerateSessionFieldsForCredentials = (tokenCredentials, logger = () => {}) => {
  let changedCount = 0;
  const next = ensureArray(tokenCredentials).map((credential) => {
    const regenerated = regenerateTokenSessionFields(credential);
    if (String(regenerated?.token || "") !== String(credential?.token || "")) {
      changedCount += 1;
    }
    return regenerated;
  });

  if (changedCount > 0) {
    logger(`Playwright Token预检：已为 ${changedCount} 个账号刷新会话参数(sessId/connId)`, "info");
  }

  return next;
};

const withBrowserSchedulerQuery = (rawUrl) => {
  const url = new URL(rawUrl || DEFAULT_APP_URL);
  url.searchParams.set("schedulerEngine", "browser");
  return url.toString();
};

const buildBrowserTokens = (credentials) => {
  return credentials.map((item) => ({
    id: item.id,
    name: item.name,
    token: item.token,
    wsUrl: item.wsUrl || null,
    server: item.server || "",
    remark: item.remark || "",
    sourceUrl: item.sourceUrl || null,
    importMethod: item.importMethod || "manual",
    avatar: item.avatar || "",
    updatedAt: item.updatedAt || new Date().toISOString(),
    createdAt: item.createdAt || new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    isActive: true,
  }));
};

const createTaskForBrowser = (task) => {
  const selectedTokens = ensureArray(task?.selectedTokens);
  const selectedTasks = ensureArray(task?.selectedTasks || task?.payload?.taskNames);
  return {
    ...task,
    selectedTokens,
    connectedTokens: selectedTokens,
    selectedTasks,
    allowSameRoleParallel: Boolean(
      task?.allowSameRoleParallel ?? task?.payload?.allowSameRoleParallel ?? false,
    ),
    enabled: true,
  };
};

const pickBinDataCredentials = (credentials) => {
  return ensureArray(credentials)
    .filter((item) => {
      const method = String(item?.importMethod || "").toLowerCase();
      return (method === "bin" || method === "wxqrcode") && Boolean(item?.binData);
    })
    .map((item) => ({
      id: item.id,
      name: item.name || item.id,
      importMethod: item.importMethod,
      binData: item.binData,
      binDataEncoding: item.binDataEncoding || "base64",
      binDataUpdatedAt: item.binDataUpdatedAt || Date.now(),
    }));
};

const autoInjectIndexedDB = async (page, binCredentials, logger = () => {}) => {
  if (!Array.isArray(binCredentials) || binCredentials.length === 0) {
    logger("IndexedDB注入: 当前任务无可注入BIN数据，跳过", "info");
    return { inserted: 0, existing: 0, failed: 0, skipped: 0 };
  }

  logger(`IndexedDB注入: 准备注入 ${binCredentials.length} 条BIN记录`, "info");

  const summary = await page.evaluate(async (records) => {
    const openDb = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("xyzw", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("tokens")) {
            const store = db.createObjectStore("tokens", { keyPath: "id" });
            store.createIndex("by-created", "createdAt");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("open indexeddb failed"));
      });

    const decodeToArrayBuffer = (raw, encodingHint) => {
      if (!raw) return null;

      if (raw instanceof ArrayBuffer) return raw;
      if (ArrayBuffer.isView(raw)) return raw.buffer;

      if (Array.isArray(raw)) {
        return new Uint8Array(raw).buffer;
      }

      if (typeof raw !== "string") return null;
      const text = raw.trim();
      if (!text) return null;

      const fromHex = (hex) => {
        if (hex.length % 2 !== 0) return null;
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
          const byte = parseInt(hex.slice(i, i + 2), 16);
          if (Number.isNaN(byte)) return null;
          out[i / 2] = byte;
        }
        return out.buffer;
      };

      const fromBase64 = (b64) => {
        const normalized = b64.replace(/^data:.*;base64,/, "").replace(/\s+/g, "");
        if (!normalized) return null;
        const binary = atob(normalized);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          out[i] = binary.charCodeAt(i);
        }
        return out.buffer;
      };

      const hint = String(encodingHint || "").toLowerCase();
      if (hint === "hex") {
        return fromHex(text);
      }
      if (hint === "base64") {
        return fromBase64(text);
      }

      if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
        const hexDecoded = fromHex(text);
        if (hexDecoded) return hexDecoded;
      }

      return fromBase64(text);
    };

    const txDone = (tx) =>
      new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error("indexeddb tx failed"));
        tx.onabort = () => reject(tx.error || new Error("indexeddb tx aborted"));
      });

    const summary = { inserted: 0, existing: 0, failed: 0, skipped: 0 };
    const db = await openDb();

    try {
      for (const record of records) {
        const id = record?.id;
        if (!id) {
          summary.skipped += 1;
          continue;
        }

        const readTx = db.transaction("tokens", "readonly");
        const readStore = readTx.objectStore("tokens");
        const existing = await new Promise((resolve, reject) => {
          const req = readStore.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error || new Error("indexeddb read failed"));
        });
        await txDone(readTx);

        if (existing?.data instanceof ArrayBuffer && existing.data.byteLength > 0) {
          summary.existing += 1;
          continue;
        }

        const buffer = decodeToArrayBuffer(record?.binData, record?.binDataEncoding);
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
          summary.failed += 1;
          continue;
        }

        const writeTx = db.transaction("tokens", "readwrite");
        const writeStore = writeTx.objectStore("tokens");
        writeStore.put({
          id,
          data: buffer,
          metadata: {
            injectedBy: "playwright-scheduler",
            source: record?.importMethod || "bin",
            accountName: record?.name || id,
            updatedAt: record?.binDataUpdatedAt || Date.now(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await txDone(writeTx);
        summary.inserted += 1;
      }
    } finally {
      db.close();
    }

    return summary;
  }, binCredentials);

  logger(
    `IndexedDB注入完成: inserted=${summary.inserted}, existing=${summary.existing}, failed=${summary.failed}, skipped=${summary.skipped}`,
    summary.failed > 0 ? "warn" : "info",
  );

  return summary;
};

const preparePlaywrightTokenCredentials = async (task, logger = () => {}) => {
  const rawTokenCredentials = ensureArray(task?.payload?.tokenCredentials);
  if (rawTokenCredentials.length === 0) {
    throw new Error("Playwright执行器缺少 payload.tokenCredentials");
  }

  const merged = mergeWithLatestTokenCredentials(rawTokenCredentials, logger);
  const refreshed = await Promise.all(
    merged.map((item) => refreshCredentialTokenFromSource(item, logger)),
  );
  const refreshedWithBin = await Promise.all(
    refreshed.map((item) => refreshCredentialTokenFromBinData(item, logger)),
  );
  const sanitized = sanitizeTokenCredentialsBeforeRun(refreshedWithBin, logger);

  const shouldRegenerateSession = parseBoolean(
    task?.payload?.playwrightRegenerateSessionFields ?? process.env.XYZW_PLAYWRIGHT_REGENERATE_SESSION,
    true,
  );

  const preprocessed = shouldRegenerateSession
    ? regenerateSessionFieldsForCredentials(sanitized, logger)
    : sanitized;

  if (preprocessed.length === 0) {
    throw new Error("Playwright Token预检失败：没有可用账号");
  }

  return preprocessed;
};

export const isPlaywrightExecutionEnabled = (task) => {
  const engine = String(
    task?.payload?.executionEngine ||
      task?.executionEngine ||
      process.env.XYZW_EXECUTION_ENGINE ||
      "playwright",
  ).toLowerCase();
  return engine === "playwright" || engine === "auto";
};

export const executeBatchPlanWithPlaywright = async (
  task,
  logger = () => {},
) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new Error(
      `Playwright不可用，请先安装依赖后再启用浏览器执行引擎: ${error.message}`,
    );
  }

  const tokenCredentials = await preparePlaywrightTokenCredentials(task, logger);
  const browserTask = createTaskForBrowser(task);
  browserTask.selectedTokens = tokenCredentials.map((item) => item.id);
  browserTask.connectedTokens = tokenCredentials.map((item) => item.id);
  const browserTokens = buildBrowserTokens(tokenCredentials);

  const appUrl = withBrowserSchedulerQuery(
    resolveAppUrlForEnvironment(
      task?.payload?.browserAppUrl ||
        process.env.XYZW_PLAYWRIGHT_APP_URL ||
        DEFAULT_APP_URL,
      logger,
    ),
  );
  const userDataDir = path.resolve(
    process.env.XYZW_PLAYWRIGHT_USER_DATA_DIR || DEFAULT_PROFILE_DIR,
  );
  const requestedTempProfile = parseBoolean(
    task?.payload?.playwrightUseTempProfile ?? process.env.XYZW_PLAYWRIGHT_USE_TEMP_PROFILE,
    false,
  );
  const headless = parseBoolean(
    task?.payload?.playwrightHeadless ?? process.env.XYZW_PLAYWRIGHT_HEADLESS,
    true,
  );
  const timeoutMs = Number(
    task?.payload?.playwrightTimeoutMs ||
      process.env.XYZW_PLAYWRIGHT_TIMEOUT_MS ||
      DEFAULT_TIMEOUT_MS,
  );

  ensurePersistentProfileDir(userDataDir, logger);

  const executablePath = resolvePlaywrightExecutablePath();

  logger(`Playwright执行器启动: ${appUrl}`, "info");
  logger(`Playwright用户数据目录: ${userDataDir}`, "info");
  if (requestedTempProfile) {
    logger("检测到临时Profile请求，但当前已强制使用持久化目录模式", "warn");
  }
  logger(`Playwright执行账号数: ${browserTokens.length}`, "info");
  if (executablePath) {
    logger(`Playwright浏览器可执行文件: ${executablePath}`, "info");
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath,
    viewport: { width: 1440, height: 960 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(timeoutMs);

    await page.exposeFunction("__XYZW_AUTOMATION_LOG_BRIDGE__", (entry) => {
      const level =
        entry?.type === "error"
          ? "error"
          : entry?.type === "warning"
            ? "warn"
            : entry?.type === "success"
              ? "success"
              : "info";
      logger(entry?.message || "", level);
    });

    await page.addInitScript(
      ({ tokens, selectedTokenId }) => {
        window.__XYZW_FORCE_BROWSER_SCHEDULER__ = true;
        window.__XYZW_AUTOMATION_LOG__ = (entry) => {
          if (typeof window.__XYZW_AUTOMATION_LOG_BRIDGE__ === "function") {
            window.__XYZW_AUTOMATION_LOG_BRIDGE__(entry);
          }
        };
        localStorage.setItem("xyzw_force_browser_scheduler", "true");
        localStorage.setItem("gameTokens", JSON.stringify(tokens));
        localStorage.setItem("selectedTokenId", selectedTokenId || "");
      },
      {
        tokens: browserTokens,
        selectedTokenId: browserTokens[0]?.id || "",
      },
    );

    page.on("pageerror", (error) => {
      logger(`Playwright页面错误: ${error.message}`, "error");
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const normalized = normalizeConsoleMessage(msg.text());
        if (!normalized) return;
        logger(`页面控制台错误: ${normalized}`, "warn");
      }
    });

    await page.goto(appUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const binCredentials = pickBinDataCredentials(tokenCredentials);
    await autoInjectIndexedDB(page, binCredentials, logger);

    await page.waitForFunction(
      () => typeof window.__XYZW_EXECUTE_SCHEDULED_TASK__ === "function",
      undefined,
      { timeout: timeoutMs },
    );

    logger(
      `Playwright已加载批量任务页面，开始执行: ${browserTask?.name || browserTask?.id || "batchPlan"}`,
      "info",
    );

    await page.evaluate(async (scheduledTask) => {
      return window.__XYZW_EXECUTE_SCHEDULED_TASK__(scheduledTask);
    }, browserTask);

    logger(
      `Playwright执行完成: ${browserTask?.name || browserTask?.id || "batchPlan"}`,
      "success",
    );

    return {
      engine: "playwright",
      success: browserTokens.length,
      failed: 0,
      details: browserTokens.map((token) => ({
        accountName: token.name || token.id,
        ok: true,
        status: "completed",
      })),
    };
  } finally {
    await context.close();
  }
};
