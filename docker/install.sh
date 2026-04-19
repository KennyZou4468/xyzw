#!/usr/bin/env sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

RUNTIME_DIR="$ROOT_DIR/server-runtime"
mkdir -p "$RUNTIME_DIR/playwright-profile"

if [ ! -f "$RUNTIME_DIR/scheduler.tasks.json" ]; then
	cp "$ROOT_DIR/server/scheduler.tasks.example.json" "$RUNTIME_DIR/scheduler.tasks.json"
fi

if [ ! -f "$RUNTIME_DIR/scheduler.ui.logs.json" ]; then
	printf "[]\n" > "$RUNTIME_DIR/scheduler.ui.logs.json"
fi

if [ ! -f "$RUNTIME_DIR/scheduler.log" ]; then
	: > "$RUNTIME_DIR/scheduler.log"
fi

# 可选：如果提供了离线镜像包则优先导入
if [ -f "./xzyw_web_helper.docker" ]; then
	docker load -i ./xzyw_web_helper.docker
fi

docker rm -f xyzw-web-local >/dev/null 2>&1 || true
docker rm -f xyzw-scheduler-local >/dev/null 2>&1 || true
docker compose up -d --build web scheduler

echo "Web URL: http://127.0.0.1:8080"
echo "Scheduler API: http://127.0.0.1:8090/api/scheduler/health"
echo "Scheduler Runtime Dir: $RUNTIME_DIR"
