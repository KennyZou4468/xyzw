#!/usr/bin/env sh

set -eu

# 可选：如果提供了离线镜像包则优先导入
if [ -f "./xzyw_web_helper.docker" ]; then
	docker load -i ./xzyw_web_helper.docker
fi

docker rm -f xyzw-web-local >/dev/null 2>&1 || true
docker run -d --name xyzw-web-local \
	-p 127.0.0.1:8080:80 \
	--restart unless-stopped \
	xyzw-web:local