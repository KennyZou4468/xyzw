import { bon, encode, getEnc, parse } from "../src/utils/bonProtocol.js";
import { WebSocket } from "ws";
import { DailyTaskRunner } from "../src/utils/dailyTaskRunner.js";
import {
  availableTasks,
  defaultBatchSettings,
  defaultSettings,
} from "../src/utils/batch/constants.js";
import {
  createTasksHangUp,
  createTasksBottle,
  createTasksTower,
  createTasksCar,
  createTasksItem,
  createTasksDungeon,
  createTasksArena,
  createTasksStore,
  createTasksLegacy,
} from "../src/utils/batch/index.js";
import {
  createConnectionManager,
  getActivityStatus,
  getTodayStartSec,
  isTodayAvailable,
  calculateMonthProgress,
} from "../src/utils/batch/connectionManager.js";
import {
  normalizeCars,
  gradeLabel,
  shouldSendCar,
  canClaim,
  isBigPrize,
  countRacingRefreshTickets,
} from "../src/utils/batch/carUtils.js";

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_ACTION_DELAY_MS = 400;
const DEFAULT_MAX_ACTIVE = 2;
const DEFAULT_CONNECT_STAGGER_MS = 300;
const DEFAULT_ACCOUNT_RETRIES = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureArray = (value) => (Array.isArray(value) ? value : []);

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

const refreshCredentialTokenFromSource = async (credential, addLog) => {
  if (!credential || credential.importMethod !== "url" || !credential.sourceUrl) {
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
    let payload;
    if (contentType.includes("application/json")) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    const refreshedToken = extractTokenFromSourcePayload(payload);
    if (!refreshedToken || refreshedToken === credential.token) {
      return credential;
    }

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${credential.name || credential.id} 已从URL刷新Token`,
      type: "info",
    });

    return {
      ...credential,
      token: refreshedToken,
    };
  } catch (error) {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${credential.name || credential.id} Token刷新失败，继续使用缓存Token: ${error.message}`,
      type: "warning",
    });
    return credential;
  }
};

const TASK_LABEL_MAP = Object.freeze({
  claimHangUpRewards: "领取挂机奖励",
  batchAddHangUpTime: "挂机加钟",
  resetBottles: "重置",
  batchlingguanzi: "领取罐子",
  climbTower: "爬塔",
  climbWeirdTower: "爬异塔",
  batchLegacyClaim: "领取功法残卷",
  batchclubsign: "俱乐部签到",
  startBatch: "日常任务",
});

const getTaskLabel = (taskName) => TASK_LABEL_MAP[taskName] || taskName;

const TASK_START_LABEL_MAP = Object.freeze({
  claimHangUpRewards: "开始领取挂机",
  batchAddHangUpTime: "开始一键加钟",
  resetBottles: "开始重置罐子",
  batchlingguanzi: "开始一键领取盐罐",
  climbTower: "开始爬塔",
  climbWeirdTower: "开始爬异塔",
  batchLegacyClaim: "开始领取功法残卷",
  startBatch: "开始执行",
});

const getTaskStartLabel = (taskName) => TASK_START_LABEL_MAP[taskName] || `开始${getTaskLabel(taskName)}`;

const logCn = (logger, accountName, message, level = "info") => {
  if (typeof logger !== "function") return;
  logger(`${accountName} ${message}`, level);
};

const mapRunnerLogType = (type) => {
  if (type === "warning") return "warn";
  if (type === "error") return "error";
  if (type === "success") return "success";
  return "info";
};

const createBackendRunnerStoreAdapter = ({
  client,
  tokenId,
  tokenName,
  logger,
}) => {
  const adapter = {
    gameTokens: [{ id: tokenId, name: tokenName }],
    async sendMessageWithPromise(targetTokenId, cmd, params = {}, timeout = DEFAULT_TIMEOUT_MS) {
      try {
        return await client.sendRaw(cmd, params, timeout);
      } catch (error) {
        if (!isTransportDisconnectedError(error)) {
          throw error;
        }

        // Mirror frontend send layer: reconnect and retry once for transport errors.
        await client.disconnect();
        await sleep(200);
        await client.connect();
        await initializeAccountSession(client);
        return client.sendRaw(cmd, params, timeout);
      }
    },
    async sendGetRoleInfo(targetTokenId) {
      return adapter.sendMessageWithPromise(targetTokenId, "role_getroleinfo", {}, 8000);
    },
  };

  return adapter;
};

const normalizeServerErrorMessage = (error) => {
  const text = String(error?.message || "");
  const match = text.match(/server error code=(\d+) hint=(.*)$/i);
  if (!match) {
    return text || "未知错误";
  }
  const code = match[1];
  const hint = (match[2] || "").trim();
  const codeHintMap = {
    12000116: "今日已领取免费奖励",
    2300070: "未加入俱乐部",
    200160: "模块未开启",
    12000060: "不在发车时间内",
    200020: "出了点小问题，请尝试重启游戏解决～",
    3500020: "没有可领取的奖励",
  };
  const fallbackHint = codeHintMap[Number(code)] || "未知错误";
  return `服务器错误: ${code} - ${hint || fallbackHint}`;
};

const createFrontendLikeBackendTokenStore = ({ tokenCredentials, logger, addLog }) => {
  const credentialMap = new Map(tokenCredentials.map((item) => [item.id, item]));
  const clientMap = new Map();
  const statusMap = new Map();

  const createWebSocketConnection = (tokenId, tokenRaw, wsUrl) => {
    const existingStatus = statusMap.get(tokenId);
    if (existingStatus === "connecting" || existingStatus === "connected") {
      return;
    }

    const credential = credentialMap.get(tokenId) || {
      id: tokenId,
      name: tokenId,
      token: tokenRaw,
      wsUrl,
    };
    const client = new BackendWsClient(buildWsUrl(credential), logger);
    clientMap.set(tokenId, client);
    statusMap.set(tokenId, "connecting");

    client
      .connect()
      .then(async () => {
        await initializeAccountSession(client);
        statusMap.set(tokenId, "connected");
      })
      .catch((error) => {
        statusMap.set(tokenId, "error");
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${credential?.name || tokenId} 连接失败: ${normalizeServerErrorMessage(error)}`,
          type: "error",
        });
      });
  };

  const closeWebSocketConnection = (tokenId) => {
    const client = clientMap.get(tokenId);
    statusMap.set(tokenId, "disconnected");
    if (client) {
      clientMap.delete(tokenId);
      client.disconnect().catch(() => {
        // ignore close errors
      });
    }
  };

  const sendMessageWithPromise = async (tokenId, cmd, params = {}, timeout = DEFAULT_TIMEOUT_MS) => {
    const client = clientMap.get(tokenId);
    const status = statusMap.get(tokenId);
    if (!client || status !== "connected") {
      throw new Error("WebSocket未连接");
    }
    try {
      return await client.sendRaw(cmd, params, timeout);
    } catch (error) {
      throw new Error(normalizeServerErrorMessage(error));
    }
  };

  const tokenStore = {
    gameTokens: tokenCredentials,
    gameData: {
      roleInfo: {},
      studyStatus: {
        isAnswering: false,
        questionCount: 0,
        answeredCount: 0,
        status: "",
        timestamp: null,
      },
      battleVersion: 0,
    },
    getWebSocketStatus: (tokenId) => statusMap.get(tokenId) || "disconnected",
    createWebSocketConnection,
    closeWebSocketConnection,
    async sendMessageWithPromise(tokenId, cmd, params = {}, timeout = DEFAULT_TIMEOUT_MS) {
      return sendMessageWithPromise(tokenId, cmd, params, timeout);
    },
    async sendMessage(tokenId, cmd, params = {}, timeout = DEFAULT_TIMEOUT_MS) {
      try {
        return await sendMessageWithPromise(tokenId, cmd, params, timeout);
      } catch {
        return null;
      }
    },
    async sendGetRoleInfo(tokenId) {
      const roleInfo = await sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 8000);
      tokenStore.gameData.roleInfo = roleInfo;
      return roleInfo;
    },
    setBattleVersion(version) {
      tokenStore.gameData.battleVersion = version;
    },
    async disconnectAllWebSockets() {
      const ids = [...clientMap.keys()];
      await Promise.all(
        ids.map(async (tokenId) => {
          closeWebSocketConnection(tokenId);
        }),
      );
    },
  };

  return tokenStore;
};

const createFrontendTaskFunctionMap = (deps) => {
  const hangUp = createTasksHangUp(deps);
  const bottle = createTasksBottle(deps);
  const tower = createTasksTower(deps);
  const car = createTasksCar(deps);
  const item = createTasksItem(deps);
  const dungeon = createTasksDungeon(deps);
  const arena = createTasksArena(deps);
  const store = createTasksStore(deps);
  const legacy = createTasksLegacy(deps);

  return {
    ...hangUp,
    ...bottle,
    ...tower,
    ...car,
    ...item,
    ...dungeon,
    ...arena,
    ...store,
    ...legacy,
  };
};

const formatTaskDoneMessage = (taskName, accountName, taskResult) => {
  if (taskName === "resetBottles") {
    return `=== ${accountName} 重置完成 ===`;
  }

  if (taskName === "batchLegacyClaim") {
    const rewardValue = taskResult?.reward?.[0]?.value;
    const totalCount = taskResult?.role?.items?.[37007]?.quantity;
    if (Number.isFinite(Number(rewardValue)) && Number.isFinite(Number(totalCount))) {
      return `=== ${accountName} 成功领取功法残卷${rewardValue}，共有${totalCount}个`;
    }
    return `=== ${accountName} 成功领取功法残卷`;
  }

  return `${accountName} ${getTaskLabel(taskName)}完成 ===`;
};

const TASK_NAME_LIST = [
  "startBatch",
  "claimHangUpRewards",
  "batchAddHangUpTime",
  "resetBottles",
  "batchlingguanzi",
  "climbTower",
  "climbWeirdTower",
  "batchStudy",
  "batchSmartSendCar",
  "batchClaimCars",
  "batchOpenBox",
  "batchOpenBoxByPoints",
  "batchClaimBoxPointReward",
  "batchFish",
  "batchRecruit",
  "batchbaoku13",
  "batchbaoku45",
  "batchmengjing",
  "batchclubsign",
  "batcharenafight",
  "batchTopUpFish",
  "batchTopUpArena",
  "batchClaimFreeEnergy",
  "skinChallenge",
  "legion_storebuygoods",
  "store_purchase",
  "collection_claimfreereward",
  "batchLegacyClaim",
  "batchLegacyGiftSendEnhanced",
  "batchUseItems",
  "batchMergeItems",
  "batchClaimPeachTasks",
  "batchGenieSweep",
  "batchBuyDreamItems",
];

export const SUPPORTED_TASKS = Object.freeze([...TASK_NAME_LIST]);

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

const buildWsUrl = (tokenCredential) => {
  if (tokenCredential?.wsUrl) return tokenCredential.wsUrl;

  const actualToken = parseActualToken(tokenCredential?.token || "");
  return `wss://xxz-xyzw.hortorgames.com/agent?p=${encodeURIComponent(actualToken)}&e=x&lang=chinese`;
};

const pickArenaTargetId = (targets) => {
  if (!targets) return null;

  if (Array.isArray(targets)) {
    const first = targets[0];
    return first?.roleId || first?.id || first?.targetId || null;
  }

  const first =
    targets?.rankList?.[0] ||
    targets?.roleList?.[0] ||
    targets?.targets?.[0] ||
    targets?.targetList?.[0] ||
    targets?.list?.[0];

  return first?.roleId || first?.id || first?.targetId || targets?.roleId || null;
};

const pickFromList = (value) => {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const arr = Object.values(value);
  return arr.length > 0 ? arr[0] : null;
};

const trySend = async (client, cmd, params = {}, options = {}) => {
  const ignoreErrors = options.ignoreErrors === true;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await client.sendRaw(cmd, params, timeoutMs);
  } catch (error) {
    if (ignoreErrors) {
      return null;
    }
    throw error;
  }
};

const runRepeated = async (count, fn, delayMs = DEFAULT_ACTION_DELAY_MS) => {
  for (let i = 0; i < count; i += 1) {
    await fn(i);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
};

const extractServerErrorCode = (error) => {
  const codeValue = error?.code;
  const numericCode = Number(codeValue);
  if (Number.isFinite(numericCode) && numericCode > 0) {
    return numericCode;
  }

  const text = String(error?.message || "");
  const match = text.match(/code=(\d+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const isServerBusinessError = (error) => {
  const code = extractServerErrorCode(error);
  if (code) return true;

  const text = String(error?.message || "").toLowerCase();
  return text.includes("server error") && text.includes("code=");
};

const isFatalBusinessError = (error) => {
  const code = extractServerErrorCode(error);
  const fatalCodes = new Set([
    // Typical auth/session fatal states: token invalid/expired/account restricted.
    1000001,
    1000002,
    1000003,
    1000004,
    1000005,
  ]);

  if (code && fatalCodes.has(code)) {
    return true;
  }

  const text = String(error?.message || "").toLowerCase();
  const fatalHints = [
    "token invalid",
    "token expired",
    "login expired",
    "auth failed",
    "forbidden",
    "banned",
    "account disabled",
  ];

  return fatalHints.some((hint) => text.includes(hint));
};

const shouldSkipTaskError = (taskName, error) => {
  const code = extractServerErrorCode(error);
  if (isFatalBusinessError(error)) {
    return false;
  }

  if (!code) return false;

  // Game-state business errors that can be skipped without blocking remaining tasks.
  if (taskName === "batchlingguanzi" && code === 2000150) {
    return true;
  }

  // Not in club; skip club sign-in without blocking other tasks.
  if (taskName === "batchclubsign" && code === 2300070) {
    return true;
  }

  // Tower conditions not met (e.g. no attempts/invalid stage state) should not block other tasks.
  if (taskName === "climbTower" && [1500020, 1500040].includes(code)) {
    return true;
  }

  // Some accounts cannot perform startBatch sub-steps due to role state restrictions.
  if (
    ["claimHangUpRewards", "batchAddHangUpTime", "batchclubsign"].includes(taskName) &&
    [2300070, 2300190].includes(code)
  ) {
    return true;
  }

  // Default fallback: unknown server business errors are task-scoped and should not block all remaining tasks.
  if (isServerBusinessError(error)) {
    return true;
  }

  return false;
};

const isTransportDisconnectedError = (error) => {
  const text = String(error?.message || "").toLowerCase();
  return (
    text.includes("websocket not connected") ||
    text.includes("websocket closed") ||
    text.includes("websocket disconnected") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("timeout cmd=")
  );
};

const initializeAccountSession = async (client) => {
  await client.sendRaw("role_getroleinfo", {
    clientVersion: "2.21.2-fa918e1997301834-wx",
    inviteUid: 0,
    platform: "hortor",
    platformExt: "mix",
    scene: "",
  });
};

class BackendWsClient {
  constructor(url, logger) {
    this.url = url;
    this.logger = logger;
    this.ws = null;
    this.seq = 0;
    this.ack = 0;
    this.pending = new Map();
    this.heartbeatTimer = null;
  }

  connect(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`connect timeout ${timeoutMs}ms`));
      }, timeoutMs);

      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        this.startHeartbeat();
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket error"));
      };

      ws.onclose = () => {
        this.stopHeartbeat();
        this.rejectAllPending("websocket closed");
      };

      ws.onmessage = (evt) => {
        this.handleMessage(evt.data);
      };
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw("heart_beat", {}, 0).catch(() => {
        // ignore heartbeat errors
      });
    }, 5000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  rejectAllPending(message) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }

  handleMessage(data) {
    try {
      if (!(data instanceof ArrayBuffer)) {
        return;
      }

      const packet = parse(data, getEnc("auto"));
      if (!packet) return;

      if (typeof packet?.seq === "number") {
        this.ack = packet.seq;
      }

      const respSeq = packet?.resp;
      if (respSeq !== undefined && this.pending.has(respSeq)) {
        const pending = this.pending.get(respSeq);
        this.pending.delete(respSeq);
        clearTimeout(pending.timer);

        if (packet.code === 0 || packet.code === undefined) {
          pending.resolve(packet.rawData ?? packet.decodedBody ?? packet.body ?? packet);
        } else {
          pending.reject(
            new Error(`server error code=${packet.code} hint=${packet.hint || ""}`),
          );
        }
      }
    } catch (error) {
      this.logger(`parse message failed: ${error.message}`, "warn");
    }
  }

  sendRaw(cmd, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("websocket not connected"));
    }

    if (cmd === "heart_beat") {
      const raw = {
        cmd: "_sys/ack",
        body: {},
        ack: this.ack,
        seq: 0,
        time: Date.now(),
      };
      const payload = encode(raw, getEnc("auto"));
      this.ws.send(payload);
      return Promise.resolve({ ok: true });
    }

    const requestSeq = ++this.seq;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestSeq);
        reject(new Error(`timeout cmd=${cmd}`));
      }, timeoutMs);

      this.pending.set(requestSeq, { resolve, reject, timer });

      const raw = {
        cmd,
        body: bon.encode(params),
        ack: this.ack,
        seq: requestSeq,
        time: Date.now(),
      };

      const payload = encode(raw, getEnc("auto"));
      this.ws.send(payload);
    });
  }

  async disconnect() {
    this.stopHeartbeat();
    this.rejectAllPending("websocket disconnected");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

const executeNamedTask = async (client, taskName, context = {}) => {
  const logger = context.logger;
  const accountName = context.accountName || "unknown";

  if (taskName === "batchclubsign") {
    await client.sendRaw("legion_signin", {});
    return;
  }

  if (taskName === "claimHangUpRewards") {
    logCn(logger, accountName, "领取挂机奖励", "info");
    await client.sendRaw("system_claimhangupreward", {});
    return;
  }

  if (taskName === "batchAddHangUpTime") {
    for (let i = 0; i < 4; i += 1) {
      logCn(logger, accountName, `挂机加钟 ${i + 1}/4`, "info");
      await client.sendRaw("system_mysharecallback", {
        isSkipShareCard: true,
        type: 2,
      });
      await sleep(250);
    }
    return;
  }

  if (taskName === "batchOpenBox") {
    await client.sendRaw("item_openbox", {
      itemId: 2001,
      number: 10,
    });
    return;
  }

  if (taskName === "batchOpenBoxByPoints") {
    await trySend(client, "item_batchclaimboxpointreward", {}, { ignoreErrors: true });
    await client.sendRaw("item_openbox", {
      itemId: 2001,
      number: 10,
    });
    return;
  }

  if (taskName === "batchClaimBoxPointReward") {
    await client.sendRaw("item_batchclaimboxpointreward", {});
    return;
  }

  if (taskName === "batchFish") {
    await client.sendRaw("artifact_lottery", {
      lotteryNumber: 10,
      newFree: true,
      type: 1,
    });
    return;
  }

  if (taskName === "batchRecruit") {
    await client.sendRaw("hero_recruit", {
      byClub: false,
      recruitNumber: 10,
      recruitType: 3,
    });
    return;
  }

  if (taskName === "resetBottles") {
    logCn(logger, accountName, "停止计时...", "info");
    await client.sendRaw("bottlehelper_stop", {});
    await sleep(300);
    logCn(logger, accountName, "开始计时...", "info");
    await client.sendRaw("bottlehelper_start", {});
    return;
  }

  if (taskName === "batchlingguanzi") {
    await client.sendRaw("bottlehelper_claim", {});
    return;
  }

  if (taskName === "batcharenafight") {
    await client.sendRaw("arena_startarea", {});
    const targets = await client.sendRaw("arena_getareatarget", { refresh: false });
    const targetId = pickArenaTargetId(targets);
    if (!targetId) {
      throw new Error("cannot find arena target");
    }
    await client.sendRaw("fight_startareaarena", { targetId });
    return;
  }

  if (taskName === "batchTopUpArena") {
    await runRepeated(3, async () => {
      await executeNamedTask(client, "batcharenafight", context);
    });
    return;
  }

  if (taskName === "batchTopUpFish") {
    await runRepeated(3, async () => {
      await client.sendRaw("artifact_lottery", {
        lotteryNumber: 10,
        newFree: true,
        type: 1,
      });
    });
    return;
  }

  if (taskName === "batchStudy") {
    await client.sendRaw("study_startgame", {});
    return;
  }

  if (taskName === "batchbaoku13") {
    const info = await client.sendRaw("bosstower_getinfo", {});
    const towerId = Number(info?.bossTower?.towerId || 0);
    if (towerId >= 1 && towerId <= 3) {
      await runRepeated(2, async () => {
        await client.sendRaw("bosstower_startboss", {});
      });
      await runRepeated(9, async () => {
        await client.sendRaw("bosstower_startbox", {});
      });
    }
    return;
  }

  if (taskName === "batchbaoku45") {
    const info = await client.sendRaw("bosstower_getinfo", {});
    const towerId = Number(info?.bossTower?.towerId || 0);
    if (towerId >= 4 && towerId <= 5) {
      await runRepeated(2, async () => {
        await client.sendRaw("bosstower_startboss", {});
      });
    }
    return;
  }

  if (taskName === "batchmengjing") {
    await client.sendRaw("dungeon_selecthero", {
      battleTeam: { 0: 107 },
    });
    return;
  }

  if (taskName === "batchBuyDreamItems") {
    await client.sendRaw("role_getroleinfo", {});
    await client.sendRaw("dungeon_buymerchant", {
      id: 1,
      index: 1,
      pos: 0,
    });
    return;
  }

  if (taskName === "climbTower") {
    await trySend(client, "tower_getinfo", {}, { ignoreErrors: true });
    await runRepeated(5, async (index) => {
      logCn(logger, accountName, `爬塔第 ${index + 1} 次`, "info");
      await client.sendRaw("fight_starttower", {});
    });
    await trySend(client, "tower_claimreward", { rewardId: 1 }, { ignoreErrors: true });
    return;
  }

  if (taskName === "climbWeirdTower") {
    await trySend(client, "evotower_getinfo", {}, { ignoreErrors: true });
    await runRepeated(3, async () => {
      await client.sendRaw("evotower_readyfight", {});
      await client.sendRaw("evotower_fight", { battleNum: 1, winNum: 1 });
    });
    await trySend(client, "evotower_claimreward", {}, { ignoreErrors: true });
    return;
  }

  if (taskName === "batchClaimFreeEnergy") {
    await client.sendRaw("mergebox_getinfo", { actType: 1 });
    await client.sendRaw("mergebox_claimfreeenergy", { actType: 1 });
    return;
  }

  if (taskName === "batchUseItems") {
    await client.sendRaw("mergebox_getinfo", { actType: 1 });
    await runRepeated(3, async () => {
      await client.sendRaw("mergebox_openbox", {
        actType: 1,
        pos: { gridX: 7, gridY: 3 },
      });
    });
    await trySend(client, "mergebox_claimcostprogress", { actType: 1 }, { ignoreErrors: true });
    return;
  }

  if (taskName === "batchMergeItems") {
    await client.sendRaw("mergebox_getinfo", { actType: 1 });
    await trySend(client, "mergebox_automergeitem", { actType: 1 }, { ignoreErrors: true });
    await trySend(client, "mergebox_claimmergeprogress", { actType: 1, taskId: 1 }, { ignoreErrors: true });
    return;
  }

  if (taskName === "skinChallenge") {
    const info = await client.sendRaw("towers_getinfo", {});
    const towerData = info?.towerData || info;
    const actId = towerData?.actId;
    if (!actId) {
      throw new Error("skinChallenge activity not available");
    }
    await client.sendRaw("towers_start", { towerType: 1 });
    await client.sendRaw("towers_fight", { towerType: 1 });
    return;
  }

  if (taskName === "batchSmartSendCar") {
    const cars = await client.sendRaw("car_getrolecar", {});
    const first = pickFromList(cars?.carMap || cars?.cars || cars?.roleCars || cars);
    const carId = first?.carId || first?.id || 1;
    await client.sendRaw("car_send", { carId });
    return;
  }

  if (taskName === "batchClaimCars") {
    const cars = await client.sendRaw("car_getrolecar", {});
    const first = pickFromList(cars?.carMap || cars?.cars || cars?.roleCars || cars);
    const carId = first?.carId || first?.id;
    if (carId) {
      await client.sendRaw("car_claim", { carId });
      return;
    }
    await client.sendRaw("car_claim", {});
    return;
  }

  if (taskName === "batchClaimPeachTasks") {
    const payload = await client.sendRaw("legion_getpayloadtask", {});
    const payloadTask = payload?.payloadTask;
    const taskMap = payloadTask?.taskMap || {};
    const firstTask = pickFromList(taskMap);
    const taskId = firstTask?.id;
    if (taskId) {
      await trySend(client, "legion_claimpayloadtask", { taskId }, { ignoreErrors: true });
    }
    await trySend(client, "legion_claimpayloadtaskprogress", { taskGroup: 1 }, { ignoreErrors: true });
    await trySend(client, "legion_claimpayloadtaskprogress", { taskGroup: 2 }, { ignoreErrors: true });
    return;
  }

  if (taskName === "batchGenieSweep") {
    const info = await client.sendRaw("role_getroleinfo", {});
    const role = info?.role || {};
    const ticket = Number(role?.items?.[1021]?.quantity || 0);
    if (ticket <= 0) {
      return;
    }
    await client.sendRaw("genie_sweep", {
      genieId: 1,
      sweepCnt: Math.min(20, ticket),
    });
    return;
  }

  if (taskName === "legion_storebuygoods") {
    await client.sendRaw("legion_storebuygoods", { id: 6 });
    return;
  }

  if (taskName === "store_purchase") {
    await client.sendRaw("store_purchase", {});
    return;
  }

  if (taskName === "collection_claimfreereward") {
    await client.sendRaw("collection_claimfreereward", {});
    return;
  }

  if (taskName === "batchLegacyClaim") {
    const resp = await client.sendRaw("legacy_claimhangup", {});
    return resp;
  }

  if (taskName === "batchLegacyGiftSendEnhanced") {
    throw new Error("batchLegacyGiftSendEnhanced requires recipient/password config not available in scheduler payload");
  }

  if (taskName === "startBatch") {
    const tokenId = context.tokenId || context.accountName;
    const tokenName = context.accountName || tokenId || "unknown";
    const runnerStore = createBackendRunnerStoreAdapter({
      client,
      tokenId,
      tokenName,
      logger,
    });
    const runner = new DailyTaskRunner(runnerStore, {
      commandDelay: Number(context.commandDelay || 500),
      taskDelay: Number(context.taskDelay || 500),
    });

    await runner.run(
      tokenId,
      {
        onLog: (log) => {
          logger(log.message, mapRunnerLogType(log.type));
        },
      },
      context.dailyRunnerSettings || null,
    );
    return;
  }

  throw new Error(`unsupported taskName=${taskName}`);
};

const executeBatchPlanWithFrontendModules = async (task, logger = () => {}) => {
  const rawTokenCredentials = ensureArray(task?.payload?.tokenCredentials);
  const selectedTaskNames = ensureArray(task?.payload?.taskNames);

  if (rawTokenCredentials.length === 0) {
    throw new Error("batchPlan missing payload.tokenCredentials");
  }
  if (selectedTaskNames.length === 0) {
    throw new Error("batchPlan missing payload.taskNames");
  }

  const addLog = (entry) => {
    logger(entry?.message || "", mapRunnerLogType(entry?.type));
  };

  const tokenCredentials = await Promise.all(
    rawTokenCredentials.map((item) => refreshCredentialTokenFromSource(item, addLog)),
  );

  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 开始执行定时任务: ${task?.name || task?.id || "batchPlan"} ===`,
    type: "info",
  });
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 开始验证定时任务 ${(task?.name || task?.id || "batchPlan")} 的依赖 ===`,
    type: "info",
  });
  addLog({
    time: new Date().toLocaleTimeString(),
    message: "✅ localStorage可用",
    type: "info",
  });
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `✅ 将使用 ${tokenCredentials.length} 个账号执行任务`,
    type: "info",
  });
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 定时任务 ${(task?.name || task?.id || "batchPlan")} 的依赖验证通过，将执行 ${tokenCredentials.length} 个账号 ===`,
    type: "success",
  });

  const selectedTokens = { value: tokenCredentials.map((item) => item.id) };
  const tokens = { value: tokenCredentials.map((item) => ({ ...item })) };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };

  const batchSettings = {
    ...defaultBatchSettings,
    maxActive: Number(task?.payload?.maxActive ?? task?.maxActive ?? defaultBatchSettings.maxActive),
    commandDelay: Number(task?.payload?.commandDelay ?? defaultBatchSettings.commandDelay),
    taskDelay: Number(task?.payload?.taskDelay ?? defaultBatchSettings.taskDelay),
    reconnectDelay: Number(task?.payload?.reconnectDelay ?? defaultBatchSettings.reconnectDelay),
    connectionTimeout: Number(task?.payload?.connectionTimeout ?? defaultBatchSettings.connectionTimeout),
    receiverId: task?.payload?.receiverId || "",
    password: task?.payload?.password || "",
  };

  const tokenStore = createFrontendLikeBackendTokenStore({ tokenCredentials, logger, addLog });
  const connectionManager = createConnectionManager({ tokenStore, batchSettings, addLog });

  const ensureConnection = async (tokenId, maxRetries = 2) => {
    return connectionManager.ensureConnection(tokenId, tokens.value, maxRetries);
  };

  const message = {
    success: (text) => addLog({ time: new Date().toLocaleTimeString(), message: text, type: "success" }),
    warning: (text) => addLog({ time: new Date().toLocaleTimeString(), message: text, type: "warning" }),
    info: (text) => addLog({ time: new Date().toLocaleTimeString(), message: text, type: "info" }),
    error: (text) => addLog({ time: new Date().toLocaleTimeString(), message: text, type: "error" }),
  };

  const currentSettings = { ...defaultSettings };
  const helperSettings = {
    boxType: defaultBatchSettings.defaultBoxType,
    fishType: defaultBatchSettings.defaultFishType,
    count: defaultBatchSettings.boxCount,
  };

  const deps = {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot: connectionManager.releaseConnectionSlot,
    connectionQueue: connectionManager.connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig: {
      command: batchSettings.commandDelay,
      task: batchSettings.taskDelay,
      action: batchSettings.commandDelay,
      battle: batchSettings.commandDelay,
      refresh: batchSettings.commandDelay,
      long: 1000,
    },
    logs: { value: [] },
    logContainer: { value: null },
    autoScrollLog: { value: false },
    nextTick: async () => {},
    shouldSendCar,
    canClaim,
    normalizeCars,
    gradeLabel,
    isBigPrize,
    countRacingRefreshTickets,
    currentSettings,
    helperSettings,
    recipientIdInput: { value: "" },
    recipientInfo: { value: null },
    securityPassword: { value: "" },
    giftQuantity: { value: 1 },
    pickArenaTargetId,
    getTodayStartSec,
    isTodayAvailable,
    calculateMonthProgress,
    loadSettings: () => ({ ...defaultSettings }),
  };

  const taskFunctions = createFrontendTaskFunctionMap(deps);

  taskFunctions.startBatch = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      let retryCount = 0;
      const MAX_RETRIES = 1;
      let done = false;

      while (retryCount <= MAX_RETRIES && !done && !shouldStop.value) {
        try {
          if (retryCount === 0) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== 开始执行: ${token?.name || tokenId} ===`,
              type: "info",
            });
          } else {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== 尝试重试: ${token?.name || tokenId} (第${retryCount}次) ===`,
              type: "info",
            });
          }

          await ensureConnection(tokenId);
          const runner = new DailyTaskRunner(tokenStore, {
            commandDelay: batchSettings.commandDelay,
            taskDelay: batchSettings.taskDelay,
          });

          await runner.run(
            tokenId,
            { onLog: (log) => addLog(log), onProgress: () => {} },
            task?.payload?.dailyRunnerSettingsByToken?.[tokenId] ||
              task?.payload?.dailyRunnerSettings ||
              null,
          );

          done = true;
          tokenStatus.value[tokenId] = "completed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token?.name || tokenId} 执行完成 ===`,
            type: "success",
          });
        } catch (error) {
          if (retryCount < MAX_RETRIES && !shouldStop.value) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token?.name || tokenId} 执行出错: ${error.message}，等待3秒后重试...`,
              type: "warning",
            });
            await sleep(3000);
            retryCount += 1;
          } else {
            tokenStatus.value[tokenId] = "failed";
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token?.name || tokenId} 执行失败: ${error.message}`,
              type: "error",
            });
            break;
          }
        } finally {
          tokenStore.closeWebSocketConnection(tokenId);
          connectionManager.releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token?.name || tokenId} 连接已关闭  (队列: ${connectionManager.connectionQueue.active}/${batchSettings.maxActive})`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量任务执行结束");
  };

  const taskLabelMap = new Map(availableTasks.map((item) => [item.value, item.label]));
  const activity = getActivityStatus();

  const originalConsoleError = console.error;
  // Frontend task modules sometimes call console.error before addLog;
  // suppress raw stderr noise to keep backend output consistent with UI logs.
  console.error = () => {};

  const taskPromises = selectedTaskNames.map(async (taskName) => {
    if (shouldStop.value) return;

    if (["batchbaoku45", "batchbaoku13"].includes(taskName) && !activity.isbaokuActivityOpen) {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `跳过任务: ${taskLabelMap.get(taskName) || taskName} (不在宝库开放时间)`,
        type: "warning",
      });
      return;
    }

    if (["batchmengjing", "batchBuyDreamItems"].includes(taskName) && !activity.ismengjingActivityOpen) {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `跳过任务: ${taskLabelMap.get(taskName) || taskName} (不在梦境开放时间)`,
        type: "warning",
      });
      return;
    }

    if (["batchSmartSendCar", "batchClaimCars"].includes(taskName) && !activity.isCarActivityOpen) {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `跳过任务: ${taskLabelMap.get(taskName) || taskName} (不在发车开放时间)`,
        type: "warning",
      });
      return;
    }

    if (["batchTopUpArena", "batcharenafight"].includes(taskName) && !activity.isarenaActivityOpen) {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `跳过任务: ${taskLabelMap.get(taskName) || taskName} (不在竞技场开放时间)`,
        type: "warning",
      });
      return;
    }

    if (["climbWeirdTower", "batchUseItems", "batchMergeItems", "batchClaimFreeEnergy"].includes(taskName) && !activity.isWeirdTowerActivityOpen) {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `跳过任务: ${taskLabelMap.get(taskName) || taskName} (不在怪异塔开放时间)`,
        type: "warning",
      });
      return;
    }

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `执行任务: ${taskLabelMap.get(taskName) || taskName}`,
      type: "info",
    });

    const fn = taskFunctions[taskName];
    if (typeof fn !== "function") {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `任务函数不存在: ${taskName}`,
        type: "error",
      });
      return;
    }

    if (["batchOpenBox", "batchOpenBoxByPoints", "batchFish", "batchRecruit", "batchLegacyGiftSendEnhanced"].includes(taskName)) {
      await fn(true);
    } else {
      await fn();
    }
  });

  try {
    await Promise.all(taskPromises);
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 定时任务执行完成: ${task?.name || task?.id || "batchPlan"} ===`,
      type: "success",
    });
  } finally {
    console.error = originalConsoleError;
  }

  const failed = Object.values(tokenStatus.value).filter((status) => status === "failed").length;
  const success = Math.max(0, selectedTokens.value.length - failed);
  return {
    success,
    failed,
    details: selectedTokens.value.map((tokenId) => ({
      accountName: tokens.value.find((item) => item.id === tokenId)?.name || tokenId,
      ok: tokenStatus.value[tokenId] !== "failed",
      status: tokenStatus.value[tokenId] || "completed",
    })),
  };
};

export const executeBatchPlanInBackend = async (task, logger = () => {}) => {
  if (task?.payload?.legacyBackendExecutor !== true) {
    return executeBatchPlanWithFrontendModules(task, logger);
  }

  const tokenCredentials = ensureArray(task?.payload?.tokenCredentials);
  const taskNames = ensureArray(task?.payload?.taskNames);
  const debugLogs = task?.payload?.debugLogs === true;
  const logStructured = (message, level = "info") => {
    if (!debugLogs) return;
    logger(message, level);
  };

  if (tokenCredentials.length === 0) {
    throw new Error("batchPlan missing payload.tokenCredentials");
  }
  if (taskNames.length === 0) {
    throw new Error("batchPlan missing payload.taskNames");
  }

  let success = 0;
  let failed = 0;
  const details = [];
  const totalAccounts = tokenCredentials.length;
  const rawMaxActive = Number(task?.payload?.maxActive ?? task?.maxActive ?? DEFAULT_MAX_ACTIVE);
  const connectStaggerMs = Math.max(0, Number(task?.payload?.connectStaggerMs || DEFAULT_CONNECT_STAGGER_MS));
  const accountRetries = Math.max(0, Number(task?.payload?.accountRetries || DEFAULT_ACCOUNT_RETRIES));
  const maxActive = Math.max(
    1,
    Math.min(totalAccounts, Number.isFinite(rawMaxActive) ? Math.floor(rawMaxActive) : totalAccounts),
  );
  let activeConnections = 0;

  const runAccount = async (credential, workerIndex) => {
    const accountName = credential?.name || credential?.id || "unknown";
    const wsUrl = buildWsUrl(credential);
    const client = new BackendWsClient(wsUrl, logger);
    let completedTaskCount = 0;
    let taskFailureCount = 0;

    const runOnce = async (attempt = 0) => {
      if (attempt === 0) {
        logger(`=== 开始执行: ${accountName} ===`, "info");
      } else {
        logger(`=== 尝试重试: ${accountName} (第${attempt}次) ===`, "info");
      }
      logStructured(`[backend-exec] connecting account=${accountName}`, "info");
      await client.connect();

      await initializeAccountSession(client);

      for (const taskName of taskNames) {
        const taskLabel = getTaskLabel(taskName);
        const taskStartLabel = getTaskStartLabel(taskName);
        logger(`=== ${taskStartLabel}: ${accountName} ===`, "info");
        logStructured(`[backend-exec] account=${accountName} task=${taskName} start`, "info");

        const runTaskOnce = async () => {
          try {
            const taskResult = await executeNamedTask(client, taskName, {
              logger,
              accountName,
              tokenId: credential?.id || accountName,
              dailyRunnerSettings:
                task?.payload?.dailyRunnerSettingsByToken?.[credential?.id] ||
                task?.payload?.dailyRunnerSettings ||
                null,
              commandDelay: task?.payload?.commandDelay,
              taskDelay: task?.payload?.taskDelay,
            });
            logStructured(`[backend-exec] account=${accountName} task=${taskName} done`, "success");
            logger(formatTaskDoneMessage(taskName, accountName, taskResult), "success");
            completedTaskCount += 1;
            return true;
          } catch (error) {
            if (shouldSkipTaskError(taskName, error)) {
              logStructured(
                `[backend-exec] account=${accountName} task=${taskName} skipped: ${error.message}`,
                "warn",
              );
              logger(`${accountName} ${taskLabel}跳过: ${error.message}`, "warn");
              completedTaskCount += 1;
              return true;
            }
            throw error;
          }
        };

        try {
          await runTaskOnce();
        } catch (error) {
          if (isTransportDisconnectedError(error)) {
            logStructured(
              `[backend-exec] account=${accountName} task=${taskName} reconnecting after transport error: ${error.message}`,
              "warn",
            );
            await client.disconnect();
            await sleep(200);
            await client.connect();
            await initializeAccountSession(client);
            try {
              await runTaskOnce();
            } catch (retryError) {
              if (shouldSkipTaskError(taskName, retryError)) {
                logStructured(
                  `[backend-exec] account=${accountName} task=${taskName} skipped after reconnect: ${retryError.message}`,
                  "warn",
                );
                logger(`${accountName} ${taskLabel}重连后跳过: ${retryError.message}`, "warn");
                completedTaskCount += 1;
              } else {
                taskFailureCount += 1;
                logStructured(
                  `[backend-exec] account=${accountName} task=${taskName} failed after reconnect: ${retryError.message}`,
                  "error",
                );
                logger(`${accountName} ${taskLabel}失败: ${retryError.message}`, "error");
              }
            }
            continue;
          }
          taskFailureCount += 1;
          logStructured(
            `[backend-exec] account=${accountName} task=${taskName} failed: ${error.message}`,
            "error",
          );
          logger(`${accountName} ${taskLabel}失败: ${error.message}`, "error");
          continue;
        }
      }

      return {
        completedTaskCount,
        taskFailureCount,
      };
    };

    // Spread worker startup slightly to avoid all accounts dialing at the same millisecond.
    if (connectStaggerMs > 0) {
      await sleep(workerIndex * connectStaggerMs);
    }

    try {
      let lastError = null;
      let accountRunResult = null;

      activeConnections += 1;
      logger(`正在连接... (队列: ${activeConnections}/${maxActive})`, "info");

      for (let attempt = 0; attempt <= accountRetries; attempt += 1) {
        try {
          accountRunResult = await runOnce(attempt);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const messageText = String(error?.message || "").toLowerCase();
          const canRetry =
            messageText.includes("websocket closed") ||
            messageText.includes("websocket error") ||
            messageText.includes("websocket not connected") ||
            messageText.includes("timeout") ||
            messageText.includes("econnreset") ||
            messageText.includes("etimedout");
          if (!canRetry || attempt >= accountRetries) {
            throw error;
          }
          logger(`${accountName} 连接异常，正在重试 (${attempt + 1}/${accountRetries})...`, "warn");
          await client.disconnect();
          await sleep(500 + attempt * 500);
        }
      }

      if (!accountRunResult && lastError) {
        throw lastError;
      }

      completedTaskCount = accountRunResult?.completedTaskCount || completedTaskCount;
      taskFailureCount = accountRunResult?.taskFailureCount || taskFailureCount;

      const accountOk = completedTaskCount > 0;
      if (accountOk) {
        success += 1;
      } else {
        failed += 1;
      }
      details.push({
        accountName,
        ok: accountOk,
        completedTaskCount,
        taskFailureCount,
      });
    } catch (error) {
      failed += 1;
      details.push({ accountName, ok: false, error: error.message });
      logStructured(`[backend-exec] account=${accountName} failed: ${error.message}`, "error");
      logger(`${accountName} 执行失败: ${error.message}`, "error");
    } finally {
      await client.disconnect();
      activeConnections = Math.max(0, activeConnections - 1);
      logger(`${accountName} 连接已关闭  (队列: ${activeConnections}/${maxActive})`, "info");
    }
  };

  let cursor = 0;
  const workerCount = Math.min(maxActive, tokenCredentials.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= tokenCredentials.length) {
        break;
      }
      await runAccount(tokenCredentials[current], current);
    }
  });

  await Promise.all(workers);

  return {
    success,
    failed,
    details,
  };
};
