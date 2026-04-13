#!/usr/bin/env sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 可选：如果提供了离线镜像包则优先导入
if [ -f "./xzyw_web_helper.docker" ]; then
	docker load -i ./xzyw_web_helper.docker
fi

npm run build
docker rm -f xyzw-web-local >/dev/null 2>&1 || true
docker rm -f xyzw-scheduler-local >/dev/null 2>&1 || true
docker compose up -d --build web scheduler

echo "Web URL: http://127.0.0.1:8080"
echo "Scheduler API: http://127.0.0.1:8090/api/scheduler/health"