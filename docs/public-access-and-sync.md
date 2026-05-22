# 公网访问与云端同步技术方案文档

## 1. 背景目标
将原本依赖 SSH 隧道（`localhost:18080`）访问的 XYZW 游戏管理系统，安全地迁移至公网域名子路径（`https://kennycad.cn/xyzw/`），并解决不同浏览器（Chrome/Safari）之间数据不互通、不持久的问题。

---

## 2. 公网子路径部署方案

### 2.1 技术挑战
1.  **资源路径偏移**：默认情况下，Vite 打包产物引用资源的路径为 `/assets/...`。在子路径 `/xyzw/` 下，浏览器会向域名根目录请求资源，导致 404。
2.  **路由匹配失效**：Vue Router 默认识别根路径。当 URL 为 `/xyzw/admin` 时，路由表若无前缀配置，会跳转至内置的 `NotFound` 页面。
3.  **API 冲突**：前端发起的 `/api` 请求会被主站（Next.js）拦截。

### 2.2 解决方案
-   **动态环境注入**：修改 `vite.config.js`，通过环境变量 `VITE_APP_BASE` 决定构建基准路径。
-   **路由适配**：在 `src/router/index.js` 中使用 `createWebHistory(import.meta.env.BASE_URL)`，让路由自动感知子目录环境。
-   **Docker 构建参数同步**：在 `docker/dockerfile` 和 `docker-compose.yml` 中引入 `ARG` 和 `args` 指令，确保宿主机的环境变量能正确传递到镜像打包过程。

---

## 3. 云端账号同步系统 (Cloud Token Sync)

### 3.1 核心痛点：存储隔离
浏览器基于同源策略，对 LocalStorage 进行了严格的域名和浏览器隔离。
-   `localhost` 与 `kennycad.cn` 不互通。
-   同一域名的 `Chrome` 与 `Safari` 不互通。
-   用户在不同设备上操作时，Token 存储极其碎片化。

### 3.2 实现架构
我们建立了一套以**服务器持久化存储**为中心的状态同步机制：

1.  **后端存储接口**：
    -   路径：`server-runtime/scheduler.tokens.json`（位于 Docker 挂载的持久化卷中）。
    -   接口：提供 `GET /api/scheduler/tokens`（拉取）和 `PUT/POST /api/scheduler/tokens`（同步）。
2.  **前端状态同步（Pinia + Watch）**：
    -   **初始化拉取**：Vue 路由守卫在页面渲染前强制等待云端数据，确保 Safari 等空存储浏览器能“瞬间填满”。
    -   **自动增量备份**：监听 `gameTokens` 的变化，任何改动（添加/删除账号）都会在 3 秒延迟后自动推送到服务器。
3.  **网关兼容性（Fallback）**：
    -   针对某些公网网关禁用 `PUT` 方法的情况，实现了 **Method Fallback**。如果 `PUT` 报 405，系统会自动降级为 `POST` 重新尝试。

---

## 4. 故障排查与运维 (Troubleshooting)

### 4.1 访问卡在“正在加载中”
-   **原因**：Nginx 缓存了旧版的 `index.html`（依然指向 `/assets`），或者 Docker 构建时环境变量未生效。
-   **检查**：按 `F12` 查看 Console。如果出现大量 `/assets/xxx.js` 404，说明需要重新执行构建脚本并强制刷新浏览器（Ctrl+Shift+R）。

### 4.2 账号数据不更新
-   **原因**：同步冲突或未完成首次固化。
-   **操作**：在有数据的浏览器（如 Chrome）中手动刷新页面，观察网络请求中是否有 `/api/scheduler/tokens` 的成功返回。

### 4.3 Nginx 配置参考（嵌套 Location 最佳实践）
```nginx
location ^~ /xyzw/ {
    auth_basic "KennyCAD Private Access";
    auth_basic_user_file /etc/nginx/.htpasswd_xyzw;
    
    # 转发给前端容器
    proxy_pass http://127.0.0.1:8080/; 
    proxy_set_header Host $host;
    
    # 内部嵌套规则：捕获前端发往后端的 API 请求
    # 前端配置应确保 API 路径为 /xyzw/api/...
    location /xyzw/api/scheduler/ {
        proxy_pass http://127.0.0.1:8090/api/scheduler/;
    }
}
```

---

## 5. 设计约束与安全建议
-   **持久化建议**：务必确保 `server-runtime` 目录在宿主机上有正确的读写权限。
-   **安全提醒**：云端同步会涉及 Token 数据在服务器明文存储（JSON 格式），虽然有 Nginx Basic Auth 保护，仍建议服务器定期进行文件备份。
