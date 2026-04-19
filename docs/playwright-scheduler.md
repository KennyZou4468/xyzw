# Playwright Scheduler Engine

This project now supports a browser-backed scheduler execution engine for batch tasks.

## Why

The legacy backend executor uses a Node.js WebSocket client. Some game sessions are rejected during the handshake when they run from a pure Node environment.

The Playwright engine keeps the existing browser task logic and runs it inside a persistent Chromium context on the server. The legacy executor is still kept as a fallback strategy.

## How it works

1. `server/backgroundScheduler.js` receives a `batchPlan` task.
2. The scheduler prefers the Playwright engine when `executionEngine` is `playwright` or `auto`.
3. `server/playwrightBatchExecutor.js` launches Chromium with a persistent profile directory.
4. It opens `/admin/batch-daily-tasks?schedulerEngine=browser`.
5. It injects the latest token snapshot into `localStorage`.
6. It calls `window.__XYZW_EXECUTE_SCHEDULED_TASK__(task)` inside the page.
7. Page logs are bridged back to the scheduler log stream.
8. If Playwright fails, the scheduler falls back to the legacy backend executor.

## Token preflight in Playwright engine

Before launching the browser, the scheduler now runs a token preflight phase that mirrors the backend executor behavior:

1. Merge token snapshots with the latest credentials from scheduler tasks.
2. Refresh URL-based tokens (`importMethod=url`) from `sourceUrl`.
3. Deduplicate duplicate token IDs.
4. Regenerate `sessId/connId` by default to reduce stale-session handshake failures.

This means Playwright mode is less sensitive to stale snapshot credentials.

## Required setup

Install package dependencies:

```bash
pnpm install
```

Install the Chromium browser used by Playwright:

```bash
npx playwright install chromium
```

Make sure the web app is reachable from the scheduler process. By default it uses:

```text
http://127.0.0.1:8080/admin/batch-daily-tasks
```

## Scripts

Prefer Playwright:

```bash
pnpm run scheduler:start:playwright
```

Force legacy executor:

```bash
pnpm run scheduler:start:legacy
```

## Environment variables

- `XYZW_EXECUTION_ENGINE`
  - `playwright` or `auto`: prefer browser execution
  - `legacy`: force the old Node WebSocket executor
- `XYZW_PLAYWRIGHT_APP_URL`
  - override the target web app URL
- `XYZW_PLAYWRIGHT_USER_DATA_DIR`
  - override the persistent browser profile directory
- `XYZW_PLAYWRIGHT_HEADLESS`
  - `true` or `false`
- `XYZW_PLAYWRIGHT_TIMEOUT_MS`
  - timeout for a single scheduler execution
- `XYZW_PLAYWRIGHT_EXECUTABLE_PATH`
  - optional explicit Chromium executable path
- `XYZW_SCHEDULER_TASKS_PATH`
  - optional scheduler tasks path used by Playwright token preflight merge
- `XYZW_PLAYWRIGHT_REGENERATE_SESSION`
  - defaults to `true`, set `false` to disable session field regeneration

## Task-level overrides

Task payload may include:

- `executionEngine`
- `browserAppUrl`
- `playwrightUserDataDir`
- `playwrightHeadless`
- `playwrightTimeoutMs`
- `playwrightRegenerateSessionFields`

## Notes

- This keeps the existing frontend execution path intact.
- The old backend executor is still available as a fallback.
- Browser scheduling can be forced for automation pages with `schedulerEngine=browser`.

## Troubleshooting

### Playwright keeps failing over to legacy

Check scheduler logs for a line like `Playwright执行失败，回退到旧后端执行器`.

Common causes:

- web page URL is unreachable from scheduler container
- browser launch dependency issue in host/container
- page failed to expose `window.__XYZW_EXECUTE_SCHEDULED_TASK__`

### WebSocket 1006 in scheduler

Playwright preflight already refreshes session fields and URL tokens, but if your token source is `bin` only and browser-side refresh data is unavailable on server, stale credentials may still occur.

Recommended mitigation:

- prefer URL token import for long-running backend scheduling
- periodically open the app and save tasks once to push latest token snapshots
