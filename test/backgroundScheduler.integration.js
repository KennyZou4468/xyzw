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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzw-scheduler-test-"));
  const tasksPath = path.join(tempDir, "tasks.json");
  const logPath = path.join(tempDir, "scheduler.log");
  const marker = `AUTO_TEST_TASK_${Date.now()}`;

  const tasks = [
    {
      id: "test_interval_task",
      name: "test interval task",
      enabled: true,
      runType: "interval",
      intervalSeconds: 1,
      action: "logMessage",
      payload: {
        message: marker,
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
      "300",
      "--duration-seconds",
      "4",
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

  if (!logText.includes(marker)) {
    throw new Error(`expected marker not found in log: ${marker}\nstdout=${stdout}\nlog=${logText}`);
  }

  console.log("Background scheduler integration test passed.");
  console.log(`Marker observed: ${marker}`);
  console.log(`Log file: ${logPath}`);
};

run().catch((error) => {
  console.error("Background scheduler integration test failed:");
  console.error(error.message);
  process.exit(1);
});
