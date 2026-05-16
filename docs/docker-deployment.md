# XYZW Docker 部署说明

这次我把 Docker 部署链路补成了“真正适合服务器长期运行”的模式，同时保留了旧后端执行器作为兜底。

## 我做了什么

### 1. `web` 容器改成多阶段构建

文件：

- [docker/dockerfile](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/dockerfile)

现在 `web` 镜像会在 Docker 构建时自动：

1. `npm ci`
2. `npm run build`
3. 把产物复制到 `nginx:alpine`

这样服务器部署时不需要先在宿主机手动执行 `npm run build`。

### 2. 新增 Playwright 调度器镜像

文件：

- [docker/scheduler.dockerfile](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/scheduler.dockerfile)

调度器现在基于 Playwright 官方镜像构建，镜像里自带浏览器运行环境，适合在服务器里执行“浏览器上下文驱动”的批量任务。

### 3. `docker-compose` 改成 Playwright 优先

文件：

- [docker-compose.yml](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker-compose.yml)

调度器默认环境变量现在是：

- `XYZW_EXECUTION_ENGINE=playwright`
- `XYZW_PLAYWRIGHT_APP_URL=http://web/admin/batch-daily-tasks`
- `XYZW_PLAYWRIGHT_USER_DATA_DIR=/app/runtime/playwright-profile`
- `XYZW_PLAYWRIGHT_HEADLESS=true`

也就是说，在 Docker 网络内，调度器会直接访问 `web` 服务页面，并优先走 Playwright 浏览器执行链路。

如果 Playwright 执行失败，代码仍会自动回退到旧的 `backendBatchExecutor.js`。

### 4. 运行时数据独立到 `server-runtime/`

新增约定：

- `server-runtime/scheduler.tasks.json`
- `server-runtime/scheduler.log`
- `server-runtime/scheduler.ui.logs.json`
- `server-runtime/playwright-profile/`
- `server-runtime/scheduler.lock`

这个目录用于持久化：

- 定时任务配置
- 调度日志
- Playwright 持久化浏览器上下文
- 调度器锁文件

这样容器重建后，任务和浏览器上下文不会丢。

### 5. 安装脚本已适配 Docker 运行时目录

文件：

- [docker/install.sh](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/install.sh)
- [docker/install.cmd](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/install.cmd)

脚本现在会自动：

1. 创建 `server-runtime/`
2. 如果没有任务文件，就从 [server/scheduler.tasks.example.json](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/server/scheduler.tasks.example.json) 初始化
3. 初始化日志文件
4. `docker compose up -d --build web scheduler`

### 6. 调度任务 UI 新增“执行引擎”选项

文件：

- [src/views/BatchDailyTasks.vue](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/src/views/BatchDailyTasks.vue)

现在每个定时任务可选：

- `auto`
- `playwright`
- `legacy`

调度器会按这个值决定优先走哪条执行链路。

## 如何运行

### 方式一：推荐，一键安装并启动

macOS / Linux:

```bash
sh docker/install.sh
```

Windows:

```bat
docker\install.cmd
```

启动后：

- Web: [http://127.0.0.1:8080](http://127.0.0.1:8080)
- Scheduler API: [http://127.0.0.1:8090/api/scheduler/health](http://127.0.0.1:8090/api/scheduler/health)

### 方式二：直接 Compose

```bash
mkdir -p server-runtime/playwright-profile
cp -n server/scheduler.tasks.example.json server-runtime/scheduler.tasks.json
test -f server-runtime/scheduler.ui.logs.json || echo "[]" > server-runtime/scheduler.ui.logs.json
test -f server-runtime/scheduler.log || : > server-runtime/scheduler.log

docker compose up -d --build web scheduler
docker compose ps
```

查看健康状态：

```bash
curl -s http://127.0.0.1:8090/api/scheduler/health
```

### 停止服务

```bash
docker compose stop web scheduler
```

## 如何选择执行引擎

在页面新增或编辑定时任务时，可以选择：

- `自动`
  - 默认推荐，优先 Playwright，失败时兜底到 legacy
- `Playwright 浏览器`
  - 强制走浏览器执行链路
- `Legacy 后端兜底`
  - 强制走旧的 Node 后端执行器

如果你的目标是“服务器长期自动化运行”，推荐优先用 `Playwright 浏览器` 或 `自动`。

## 重要文件

- [docker-compose.yml](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker-compose.yml)
- [docker/dockerfile](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/dockerfile)
- [docker/scheduler.dockerfile](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/scheduler.dockerfile)
- [docker/install.sh](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docker/install.sh)
- [server/playwrightBatchExecutor.js](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/server/playwrightBatchExecutor.js)
- [server/backgroundScheduler.js](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/server/backgroundScheduler.js)
- [docs/playwright-scheduler.md](/Users/zoukaiyun/Documents/GitHub/XYZW/xyzw_web_helper/docs/playwright-scheduler.md)

## 说明

- 当前 Docker 调度器已经以 Playwright 为默认执行引擎。
- 旧后端执行器没有删除，仍然保留作为兜底。
- `server-runtime/` 已加入忽略规则，不会混进版本控制。

## 执行引擎决策逻辑

调度器执行 `batchPlan` 时的决策顺序如下：

1. 读取任务级 `executionEngine`（`auto | playwright | legacy`）。
2. 若任务未指定，则使用环境变量 `XYZW_EXECUTION_ENGINE`。
3. 若最终为 `playwright` 或 `auto`：优先执行 Playwright。
4. Playwright 失败时自动回退 legacy（并写入告警日志）。
5. 若最终为 `legacy`：直接走旧后端执行器。

你可以通过接口查看当前能力信息：

```bash
curl -s http://127.0.0.1:8090/api/scheduler/capabilities
```

返回内容包含 `executionEngines`（默认引擎、支持枚举、是否启用 Playwright 优先）。

## Playwright 稳定性实现补充

Playwright 执行器现在会在启动浏览器前做凭证预检：

1. 从任务快照中读取 `payload.tokenCredentials`。
2. 合并调度任务文件中的最新凭证快照。
3. 对 URL 导入账号按 `sourceUrl` 拉取新 token。
4. 默认重建 `sessId/connId`，降低会话过期导致的握手失败。
5. 去重重复 `tokenId`，避免重复连接冲突。

可通过环境变量控制是否重建会话字段：

- `XYZW_PLAYWRIGHT_REGENERATE_SESSION=true|false`（默认 `true`）

## 常用运维命令

```bash
# 查看容器状态
docker compose ps

# 查看调度器日志
docker logs -f xyzw-scheduler-local

# 查看最近后端日志（API）
curl -s 'http://127.0.0.1:8080/api/scheduler/logs?tail=50&sinceMs=0'

# 健康检查
curl -s http://127.0.0.1:8080/api/scheduler/health
```

## 任务文件与运行时文件

运行时目录：`server-runtime/`

- `scheduler.tasks.json`: 定时任务配置
- `scheduler.log`: 调度器主日志
- `scheduler.ui.logs.json`: 前端日志回放数据
- `playwright-profile/`: 持久化浏览器上下文
- `scheduler.lock`: 单实例锁文件

说明：删除 `playwright-profile/` 会丢失浏览器侧持久化状态，通常仅在排障时手动清理。
http://127.0.0.1:18080/admin/batch-daily-tasks
ssh -L 18080:127.0.0.1:8080 kennys

## 踩坑记录与极致部署方案 (2026-05-07)

在将本项目从本地推送至远程服务器（特别是境内服务器）的过程中，我们遇到了多个维度的障碍。以下是详细的排查记录与最终的闭环方案，供后续复用。

### 1. 前端构建：handleHotUpdate 错误
- **现象**：执行 `npm run build` 时报错，提示 `handleHotUpdate` 不是 `virtual:vue-router/auto-routes` 导出的成员。
- **原因**：`handleHotUpdate` 仅在开发环境（DEV）的热更新模式下存在，生产环境构建时该虚拟模块不会导出此函数。
- **解决**：在 `src/router/index.js` 中改用精准导入 `import { routes }`，并彻底移除生产环境下无效的热更新调用逻辑。

### 2. 核心挑战：Playwright 镜像拉取
- **现象**：服务器尝试从 `mcr.microsoft.com` 拉取镜像持续超时。
- **坑点 A（镜像源失效）**：国内多个学术源（NJU, ISCAS）由于流量或权限控制，对 2GB+ 的大镜像返回 403 或直接连接重置。
- **坑点 B（BuildKit 联网校验）**：即使手动打标签（`docker tag`），Docker BuildKit 在构建时仍会尝试联网校验 Manifest。如果服务器配置了失效的镜像源（如已下线的网易 163 镜像），会因 DNS 解析失败导致整个构建崩溃。
- **最终方案（镜像搬运/Sideloading）**：
    1.  **本地拉取**：在本地（有代理环境）拉取镜像。
    2.  **强制架构**：必须指定架构 `docker pull --platform linux/amd64`，否则 Mac (ARM64) 导出的镜像在服务器上会报 `Exec format error`。
    3.  **ID 引用**：获取镜像的完整 SHA256 ID，并将其作为构建变量传递。**使用 ID 引用能强行掐断 Docker 联网校验的念想**。
    4.  **降级构建**：设置 `DOCKER_BUILDKIT=0` 回归传统构建模式，配合 `--pull=false` 实现真正的全离线构建。

### 3. 部署细节：rsync 权限与构建上下文
- **rsync 权限**：如果远程目录由 `root` 创建，需使用 `rsync --rsync-path="sudo rsync"` 才能顺利写入。
- **上下文爆炸**：若不小心将 2.7GB 的 `.tar` 镜像包留在根目录且未在 `.dockerignore` 排除，每次 `docker build` 都会上传数 GB 的数据，导致构建极慢甚至 OOM。

### 4. 微信登录：Nginx 代理缺失
- **现象**：本地运行正常，部署后“微信扫码登录”无法获取二维码。
- **原因**：Nginx 未配置对 `/api/weixin`、`/api/weixin-long` 和 `/api/hortor` 的转发，导致前端请求被当做静态资源处理（404 或返回 index.html）。
- **解决**：在 `docker/nginx.conf` 中同步补齐与 `vite.config.js` 一致的代理配置，并伪造正确的 `User-Agent` 和 `Referer`。

---

## 优化的本地推送脚本

脚本路径：`script/local-push-deploy.sh` (已加入 .gitignore)

### 脚本核心逻辑流：
1.  **Git 自动保存**：提交本地修改，但不强求推送成功（防止断网阻塞）。
2.  **本地镜像预处理**：检查本地是否有 `linux/amd64` 版本的镜像，没有则自动拉取并打包。
3.  **差异化传输**：
    -   代码通过 `tar` 流式传输（排除大文件、node_modules 等）。
    -   镜像包通过 `rsync` 传输（支持断点续传，检测文件是否已存在）。
4.  **远程全离线构建**：
    -   `docker load` 加载镜像。
    -   提取镜像长 ID，注入 `PLAYWRIGHT_BASE_IMAGE`。
    -   `DOCKER_BUILDKIT=0` + `docker compose build --pull=false`。

### 复用注意事项：
-   **SSH 别名**：确保本地 `~/.ssh/config` 中配置了服务器别名（如 `kennys`）。
-   **本地环境**：运行脚本的机器必须安装有 Docker。
-   **架构匹配**：如果服务器不是 `amd64`，需修改脚本中的 `--platform` 参数。
