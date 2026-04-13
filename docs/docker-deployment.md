# XYZW Web Helper Docker 部署说明

## 1. 实现目标

本项目的 Docker 形态是"前端静态产物 + Nginx"：

- 先在宿主机执行 `npm run build` 生成 `dist`。
- 再构建 Docker 镜像，把 `dist` 拷贝进 Nginx 容器。
- 最终由 Nginx 提供静态页面和前端路由回退（SPA fallback）。

这不是开发态热更新模式。开发调试仍使用 `npm run dev`。

## 2. 相关文件

### 2.1 [docker/dockerfile](docker/dockerfile)

镜像构建定义，关键点：

- 基础镜像：`nginx:alpine`
- 拷贝静态文件：`COPY ./dist /app/web`
- 拷贝 Nginx 配置：`COPY ./docker/nginx.conf /etc/nginx/conf.d/default.conf`
- 暴露端口：`80`
- 启动命令：`nginx -g 'daemon off;'`

### 2.2 [docker/nginx.conf](docker/nginx.conf)

Nginx 运行配置，关键点：

- `root /app/web;` 指向前端静态目录。
- `try_files $uri $uri/ /index.html;` 支持 Vue Router 历史路由。
- 5xx 错误页回退到静态目录。

### 2.3 [docker-compose.yml](docker-compose.yml)

本地一键部署配置，关键点：

- 构建上下文：项目根目录。
- Dockerfile 路径：`docker/dockerfile`
- `web` 镜像名：`xyzw-web:local`
- `web` 端口映射：`127.0.0.1:8080:80`（仅本机访问）
- `scheduler` 端口映射：`127.0.0.1:8090:8090`（任务同步 API）

### 2.4 [docker/install.sh](docker/install.sh) / [docker/install.cmd](docker/install.cmd)

固定脚本（推荐）：一条命令同时拉起网页和调度器。

### 2.5 [server/scheduler.tasks.json](server/scheduler.tasks.json)

后台调度器实际读取的任务文件。网页新增/编辑定时任务后会同步写入这个文件（通过 scheduler API）。

## 3. 本地部署流程（推荐）

在项目根目录执行：

```bash
npm run build
docker build -f docker/dockerfile -t xyzw-web:local .
docker rm -f xyzw-web-local >/dev/null 2>&1 || true
docker run -d --name xyzw-web-local -p 127.0.0.1:8080:80 xyzw-web:local
curl -I http://127.0.0.1:8080
```

如果 `curl -I` 返回 `HTTP/1.1 200 OK`，说明部署成功。

## 4. 本地部署流程（Compose）

### 4.1 一条命令启动（推荐）

macOS/Linux：

```bash
sh docker/install.sh
```

Windows：

```bat
docker\install.cmd
```

### 4.2 NPM 快捷命令

```bash
npm run docker:up
npm run docker:ps
```

说明：`docker:up` 会先清理同名旧容器（`xyzw-web-local`、`xyzw-scheduler-local`），再启动最新服务，避免容器名冲突。

### 4.3 手动 Compose（等价）

```bash
npm run build
docker compose up -d --build web scheduler
docker compose ps
curl -I http://127.0.0.1:8080
curl -s http://127.0.0.1:8090/api/scheduler/health
```

停止并清理：

```bash
docker compose stop web scheduler
```

网页地址：

`http://127.0.0.1:8080`

调度器健康检查：

`http://127.0.0.1:8090/api/scheduler/health`

## 5. 服务器部署流程

在服务器上执行：

```bash
git clone <your-repo-url>
cd xyzw_web_helper
npm ci
npm run build
docker build -f docker/dockerfile -t xyzw-web:prod .
docker rm -f xyzw-web >/dev/null 2>&1 || true
docker run -d --name xyzw-web \
	-p 127.0.0.1:8080:80 \
	--restart unless-stopped \
	xyzw-web:prod
```

验证：

```bash
docker ps
docker logs --tail=100 xyzw-web
curl -I http://127.0.0.1:8080
```

## 6. 同机部署访问控制（推荐）

当服务器同时运行宠物平台时，脚本平台不要直接占用公网 80/443。

推荐架构：

1. 脚本容器仅监听 `127.0.0.1:8080`
2. 外部流量统一由 Nginx 接入
3. Nginx 对脚本平台启用 IP 白名单 + Basic Auth

这样可以避免端口冲突，并确保脚本平台仅你本人可访问。

## 7. Nginx 反向代理示例（白名单 + Basic Auth）

```nginx
server {
	listen 443 ssl;
	server_name game.your-domain.com;

	ssl_certificate /etc/letsencrypt/live/game.your-domain.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/game.your-domain.com/privkey.pem;

	allow 1.2.3.4;       # 你的固定公网 IP
	deny all;

	auth_basic "Private Game Script";
	auth_basic_user_file /etc/nginx/.htpasswd_game;

	location / {
		proxy_pass http://127.0.0.1:8080;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
}
```

创建 Basic Auth 账号：

```bash
apt-get update && apt-get install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd_game your_admin_name
nginx -t && systemctl reload nginx
```

## 8. 更新发布流程

```bash
git pull
npm ci
npm run build
docker build -f docker/dockerfile -t xyzw-web:prod .
docker rm -f xyzw-web >/dev/null 2>&1 || true
docker run -d --name xyzw-web \
	-p 127.0.0.1:8080:80 \
	--restart unless-stopped \
	xyzw-web:prod
```

## 9. 干净环境验证（强烈建议）

用于确认镜像可独立重建、无临时依赖：

```bash
docker rm -f xyzw-web-local >/dev/null 2>&1 || true
docker rmi xyzw-web:local >/dev/null 2>&1 || true
docker build -f docker/dockerfile -t xyzw-web:local .
```

## 10. 常见问题

### 10.0 关闭网页后任务不执行

先检查 scheduler 容器和 API：

```bash
docker ps | grep xyzw-scheduler-local
curl -s http://127.0.0.1:8090/api/scheduler/health
```

再检查任务是否真的同步到了后台：

```bash
curl -s http://127.0.0.1:8090/api/scheduler/tasks
docker logs --tail=200 xyzw-scheduler-local
```

如果 scheduler 没有启动，执行：

```bash
npm run docker:up
```

### 10.1 端口占用

改端口即可：

```bash
docker run -d --name xyzw-web-local -p 127.0.0.1:18080:80 xyzw-web:local
```

访问 `http://127.0.0.1:18080`。

### 10.2 Apple Silicon 架构兼容问题

强制 amd64 构建：

```bash
docker build --platform linux/amd64 -f docker/dockerfile -t xyzw-web:local .
```

### 10.3 页面可打开但资源异常

优先检查：

- `npm run build` 是否成功。
- `dist` 是否包含最新产物。
- `docker logs --tail=200 <container-name>` 是否有 Nginx 报错。

## 11. .dockerignore 建议

建议创建 `.dockerignore` 来提升构建速度与稳定性，示例：

```dockerignore
node_modules
.git
.gitignore
npm-debug.log
pnpm-debug.log
yarn-error.log
.DS_Store
```

说明：

- 当前流程是宿主机先 `npm run build`，再 `COPY dist` 进镜像。
- 因此不要在 `.dockerignore` 里排除 `dist`。
- 如果后续改成"镜像内构建"，再调整 `.dockerignore` 策略。
