import { bon, encode, getEnc, parse } from "../src/utils/bonProtocol.js";
import { WebSocket } from "ws";

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_ACTION_DELAY_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureArray = (value) => (Array.isArray(value) ? value : []);

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
  const text = String(error?.message || "");
  const match = text.match(/code=(\d+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const shouldSkipTaskError = (taskName, error) => {
  const code = extractServerErrorCode(error);
  if (!code) return false;

  // Game-state business errors that can be skipped without blocking remaining tasks.
  if (taskName === "batchlingguanzi" && code === 2000150) {
    return true;
  }

  // Not in club; skip club sign-in without blocking other tasks.
  if (taskName === "batchclubsign" && code === 2300070) {
    return true;
  }

  return false;
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

const executeNamedTask = async (client, taskName) => {
  if (taskName === "batchclubsign") {
    await client.sendRaw("legion_signin", {});
    return;
  }

  if (taskName === "claimHangUpRewards") {
    await client.sendRaw("system_claimhangupreward", {});
    return;
  }

  if (taskName === "batchAddHangUpTime") {
    for (let i = 0; i < 4; i += 1) {
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
    await client.sendRaw("bottlehelper_stop", {});
    await sleep(300);
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
      await executeNamedTask(client, "batcharenafight");
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
    await runRepeated(5, async () => {
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
    await client.sendRaw("legacy_claimhangup", {});
    return;
  }

  if (taskName === "batchLegacyGiftSendEnhanced") {
    throw new Error("batchLegacyGiftSendEnhanced requires recipient/password config not available in scheduler payload");
  }

  if (taskName === "startBatch") {
    await executeNamedTask(client, "claimHangUpRewards");
    await executeNamedTask(client, "batchAddHangUpTime");
    await executeNamedTask(client, "batchclubsign");
    return;
  }

  throw new Error(`unsupported taskName=${taskName}`);
};

export const executeBatchPlanInBackend = async (task, logger = () => {}) => {
  const tokenCredentials = ensureArray(task?.payload?.tokenCredentials);
  const taskNames = ensureArray(task?.payload?.taskNames);

  if (tokenCredentials.length === 0) {
    throw new Error("batchPlan missing payload.tokenCredentials");
  }
  if (taskNames.length === 0) {
    throw new Error("batchPlan missing payload.taskNames");
  }

  let success = 0;
  let failed = 0;
  const details = [];

  for (const credential of tokenCredentials) {
    const accountName = credential?.name || credential?.id || "unknown";
    const wsUrl = buildWsUrl(credential);
    const client = new BackendWsClient(wsUrl, logger);

    try {
      logger(`[backend-exec] connecting account=${accountName}`, "info");
      await client.connect();

      await client.sendRaw("role_getroleinfo", {
        clientVersion: "2.21.2-fa918e1997301834-wx",
        inviteUid: 0,
        platform: "hortor",
        platformExt: "mix",
        scene: "",
      });

      for (const taskName of taskNames) {
        logger(`[backend-exec] account=${accountName} task=${taskName} start`, "info");
        try {
          await executeNamedTask(client, taskName);
          logger(`[backend-exec] account=${accountName} task=${taskName} done`, "success");
        } catch (error) {
          if (shouldSkipTaskError(taskName, error)) {
            logger(
              `[backend-exec] account=${accountName} task=${taskName} skipped: ${error.message}`,
              "warn",
            );
            continue;
          }
          throw error;
        }
      }

      success += 1;
      details.push({ accountName, ok: true });
    } catch (error) {
      failed += 1;
      details.push({ accountName, ok: false, error: error.message });
      logger(`[backend-exec] account=${accountName} failed: ${error.message}`, "error");
    } finally {
      await client.disconnect();
    }
  }

  return {
    success,
    failed,
    details,
  };
};
