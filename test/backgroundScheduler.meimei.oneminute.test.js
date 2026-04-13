import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const waitForExit = (child) =>
  new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

const run = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzw-meimei-test-"));
  const tasksPath = path.join(tempDir, "tasks.json");
  const logPath = path.join(tempDir, "scheduler.log");

  const now = new Date();
  const runAt = new Date(now.getTime() + 60 * 1000).toISOString();
  const marker = `MEIMEI_ONE_MINUTE_${Date.now()}`;

  const tasks = [
    {
      id: "meimei_one_minute_task",
      name: "咩咩-一分钟后任务",
      enabled: true,
      runType: "oneTime",
      runAt,
      action: "batchPlan",
      payload: {
        accountName: "咩咩",
        taskNames: ["startBatch", marker],
      },
    },
  ];

  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), "utf8");

  const child = spawn(
    process.execPath,
    [
      "server/backgroundScheduler.js",
      "--tasks",
      tasksPath,
      "--log",
      logPath,
      "--tick-ms",
      "500",
      "--duration-seconds",
      "75",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (buf) => {
    stdout += buf.toString();
  });
  child.stderr.on("data", (buf) => {
    stderr += buf.toString();
  });

  const result = await waitForExit(child);
  if (result.code !== 0) {
    throw new Error(`scheduler process failed (code=${result.code}): ${stderr || stdout}`);
  }

  const logText = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf8")
    : "";

  if (!logText.includes("account=咩咩")) {
    throw new Error(`did not find account output for 咩咩\nlog=${logText}`);
  }

  if (!logText.includes(marker)) {
    throw new Error(`did not find one-minute marker output ${marker}\nlog=${logText}`);
  }

  console.log("One-minute meimei scheduler test passed.");
  console.log(`runAt: ${runAt}`);
  console.log(`marker: ${marker}`);
  console.log(`log file: ${logPath}`);
};

run().catch((error) => {
  console.error("One-minute meimei scheduler test failed:");
  console.error(error.message);
  process.exit(1);
});
