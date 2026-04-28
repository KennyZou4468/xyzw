#!/usr/bin/env sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

PLAYWRIGHT_BASE_IMAGE="${PLAYWRIGHT_BASE_IMAGE:-mcr.microsoft.com/playwright:v1.59.1-noble}"

pull_with_retry() {
	image="$1"
	max_attempts="${2:-5}"
	attempt=1
	while [ "$attempt" -le "$max_attempts" ]; do
		echo "[scheduler] Pulling base image ($attempt/$max_attempts): $image"
		if docker pull "$image"; then
			return 0
		fi
		if [ "$attempt" -lt "$max_attempts" ]; then
			echo "[scheduler] Pull failed, retrying in 5s..."
			sleep 5
		fi
		attempt=$((attempt + 1))
	done
	return 1
}

RUNTIME_DIR="$ROOT_DIR/server-runtime"
mkdir -p "$RUNTIME_DIR/playwright-profile"
mkdir -p "$RUNTIME_DIR/browser-profile"

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

if ! pull_with_retry "$PLAYWRIGHT_BASE_IMAGE" 5; then
	echo "[scheduler] Failed to pull Playwright base image after retries: $PLAYWRIGHT_BASE_IMAGE"
	echo "[scheduler] You can try a different base image, for example:"
	echo "  PLAYWRIGHT_BASE_IMAGE=mcr.microsoft.com/playwright:v1.58.0-noble sh docker/install.sh"
	echo "  PLAYWRIGHT_BASE_IMAGE=mcr.microsoft.com/playwright:v1.57.0-jammy sh docker/install.sh"
	exit 1
fi

docker compose up -d --build web scheduler

echo "Web URL: http://127.0.0.1:8080"
echo "Scheduler API: http://127.0.0.1:8090/api/scheduler/health"
echo "Scheduler Runtime Dir: $RUNTIME_DIR"
