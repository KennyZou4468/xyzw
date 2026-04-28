# XYZW 项目进展与已知问题（2026-04-26）

## 1. 目标与当前状态

当前项目已经完成“前端任务配置 + 后端定时调度 + Playwright/Legacy 双执行引擎”的主链路，具备可持续运行能力。

已落地能力主要集中在：
- Docker 化部署与运行时目录持久化
- 定时任务可视化配置
- 执行引擎可选（auto / playwright / legacy）
- 账号凭证预检、快照同步、失败回退

## 2. 已完成进展（代码层面）

### 2.1 后端调度能力

- 支持执行引擎选择与能力暴露
  - 参考 [server/backgroundScheduler.js](../server/backgroundScheduler.js)
- 默认执行引擎为 playwright（可通过环境变量覆盖）
  - 参考 [server/backgroundScheduler.js](../server/backgroundScheduler.js)
- 支持 daily 执行状态记录（含 lastDailyKey）与状态文件
  - 参考 [server/backgroundScheduler.js](../server/backgroundScheduler.js)

### 2.2 Playwright 执行器

- 执行前 Token 预检：合并最新快照、URL 刷新、去重、会话字段更新
  - 参考 [server/playwrightBatchExecutor.js](../server/playwrightBatchExecutor.js)
- 支持临时 Profile 开关（playwrightUseTempProfile / XYZW_PLAYWRIGHT_USE_TEMP_PROFILE）
  - 参考 [server/playwrightBatchExecutor.js](../server/playwrightBatchExecutor.js)
- Playwright 失败可回退 legacy 执行器（由调度层负责）
  - 参考 [server/backgroundScheduler.js](../server/backgroundScheduler.js)

### 2.3 Legacy 后端执行器

- 执行前 Token 预检：合并最新快照、URL 刷新、去重、会话字段更新
  - 参考 [server/backendBatchExecutor.js](../server/backendBatchExecutor.js)
- 增强连接错误诊断与不可恢复错误识别
  - 参考 [server/backendBatchExecutor.js](../server/backendBatchExecutor.js)

### 2.4 前端任务与凭证快照同步

- 任务保存时会把 selectedTokens 和 tokenCredentials 写入 payload
  - 参考 [src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)
- 页面存在静默快照同步心跳，用于把当前最新 token 快照推到调度端
  - 参考 [src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)
- Token 页面提供单账号刷新能力（URL / BIN / wxQrcode 路径）
  - 参考 [src/views/TokenImport/index.vue](../src/views/TokenImport/index.vue)

## 3. 已观察到的稳定性现象

### 3.1 现象 A：进入 /tokens 并点击刷新后，后台任务更稳定

该现象与代码逻辑一致，存在关联：
- 刷新动作会更新 tokenStore 中的 token 值
- 任务执行前会优先合并最新 token 快照
- 当快照同步及时，后台执行会使用更新后的凭证，连接成功率提升

结论：这是合理现象，不是偶发错觉。

### 3.2 现象 B：同一天不同时段表现差异明显（如 8 点正常、11 点易失败）

主要与以下因素叠加有关：
- 任务规模与并发压力不同
- 执行引擎切换（Playwright 超时后回退 legacy）引入额外波动
- 某些账号凭证在高峰时段握手更容易被服务端拒绝

## 4. 依然存在的问题（重点）

### 当前阻塞问题（2026-04-26 19:54 最新日志）

现象摘要：
- Playwright 预检阶段的 BIN 刷新全部失败，报错为 `Cannot read properties of undefined (reading 'decrypt')`
- 页面阶段仍持续出现 `IndexedDB 初始化错误: UnknownError: Internal error opening backing store for indexedDB.open.`
- 进入页面后的“执行前Token刷新”仍提示“未找到BIN刷新数据，已跳过执行前刷新（继续使用当前Token）”
- 主任务本身可执行完成，但刷新链路未真正恢复

影响评估：
- 任务成功率暂时依赖缓存 token 的有效期，不具备稳定的“执行前自动续新”能力
- 账号一旦缓存 token 过期，会回到批量失败风险

初步判断：
- 后端 BIN 刷新逻辑调用了解析链路中的 decrypt 能力，但运行时上下文未满足该能力依赖，导致预检失败
- 即使注入了持久化 profile，容器内 Chromium 的 IndexedDB backing store 仍存在环境级异常，前端页内 BIN 数据读取链路不可依赖
- 调度端任务快照在运行时仍可能缺失 `tokenCredentials.binData`，导致页面执行前刷新必然跳过

下一步修复方向（已确认优先级最高）：
1. 将 BIN->token 刷新完全前置到后端执行器，并使用不依赖浏览器上下文的解析路径
2. 对 `tokenCredentials.binData` 增加执行前硬校验与日志计数（有/无 BIN 数据账号数）
3. 把页面 IndexedDB 注入降级为“可选增强”而非主刷新路径

### 问题 1：定时任务偶发大面积连接失败

表现：
- 日志出现“连接超时，尝试重连”“重连后仍超时”“websocket closed 1006”等
- 同一批任务中多个子任务连续失败

影响：
- 单次定时窗口内成功率明显下降
- 日志噪音大，排查成本高

可能原因：
- 同时启动的子任务过多，造成握手瞬时压力过高
- 同角色多账号场景在服务端侧互斥或互踢
- 上游网络波动与服务端限流叠加

临时规避：
- 拆分大任务，降低同一时刻并发
- 优先使用 auto 并保留 fallback
- 对关键任务单独定时，避免与重任务同窗执行

建议改进：
- 增加“任务内子任务串行/限并发”配置
- 为连接失败增加指数退避与批次级熔断
- 将不可恢复错误与可重试错误分层统计

### 问题 2：Token 快照更新链路依赖页面行为，后端并非总能拿到最新凭证

表现：
- 用户在 /tokens 刷新后，若快照未及时推送到 scheduler tasks，后台仍可能使用旧凭证
- 表现为“前台手动执行更稳，后台定时偶发失败”

影响：
- 时段性不稳定，复现随机性高

建议改进：
- 在 Token 刷新成功后，主动触发一次调度任务快照更新接口
- 后端执行前增加快照新鲜度检查并记录版本号/时间戳

### 问题 3：Playwright 临时 Profile 与凭证刷新路径存在取舍

表现：
- 临时 Profile 可以规避部分持久 profile 污染问题
- 但临时环境缺失浏览器侧持久数据时，某些刷新路径能力会下降

建议改进：
- 区分“稳定优先模式（临时 profile）”与“状态继承模式（持久 profile）”
- 在任务级提供明确开关，并将当前模式写入日志头

## 5. 当前建议的运维策略（短期）

- 生产默认使用 auto 执行引擎
- 高价值任务分组执行，减少同窗并发
- 每日固定时段执行前，先做一次凭证刷新与快照同步
- 保留 scheduler 日志与 UI 日志，按失败批次做对照

## 6. 下一阶段建议（开发）

1. 增加“子任务执行策略”配置：串行、限并发、全并发
2. 新增 Token 快照版本机制（版本号 + 更新时间）并在执行日志输出
3. 增加连接失败聚合报表（按账号、任务、错误码、时段）
4. 在任务执行入口加“预热探测”步骤，失败则快速终止当前批次并上报

## 7. 文档维护说明

本文件用于阶段复盘与排障基线，建议在每次影响调度稳定性的变更后更新：
- 变更内容
- 复现日志特征
- 影响范围
- 回滚方案

案例：
8:03:00 PMbatchPlan执行引擎: auto
8:03:00 PM优先使用 Playwright 浏览器执行引擎
8:03:00 PM咩咩-0-664382501 BIN刷新失败，继续使用缓存Token(Playwright): Cannot read properties of undefined (reading 'decrypt')
8:03:00 PM咩咩咩-2-689898963 BIN刷新失败，继续使用缓存Token(Playwright): Cannot read properties of undefined (reading 'decrypt')
8:03:00 PM咩咩-0-529938321 BIN刷新失败，继续使用缓存Token(Playwright): Cannot read properties of undefined (reading 'decrypt')
8:03:00 PM咩咩咩-1-597541905 BIN刷新失败，继续使用缓存Token(Playwright): Cannot read properties of undefined (reading 'decrypt')
8:03:00 PMPlaywright Token预检：已为 4 个账号刷新会话参数(sessId/connId)
8:03:00 PMPlaywright环境适配: 使用 http://web/admin/batch-daily-tasks
8:03:00 PMPlaywright环境检测: inDocker=true
8:03:00 PMPlaywright持久化目录检查通过: /srv/xyzw/browser-profile
8:03:00 PMPlaywright执行器启动: http://web/admin/batch-daily-tasks?schedulerEngine=browser
8:03:00 PMPlaywright用户数据目录: /srv/xyzw/browser-profile
8:03:00 PMPlaywright执行账号数: 4
8:03:06 PM页面控制台错误: ❌ IndexedDB 初始化错误: UnknownError: Internal error opening backing store for indexedDB.open.
8:03:08 PM页面控制台错误: ❌ IndexedDB 初始化错误: UnknownError: Internal error opening backing store for indexedDB.open.
8:03:15 PM=== 开始执行定时任务: test ===
8:03:15 PM执行前Token刷新开始（4个账号）
8:03:15 PM咩咩-0-529938321 未找到BIN刷新数据，已跳过执行前刷新（继续使用当前Token）
8:03:15 PM咩咩咩-1-597541905 未找到BIN刷新数据，已跳过执行前刷新（继续使用当前Token）
8:03:15 PM咩咩-0-664382501 未找到BIN刷新数据，已跳过执行前刷新（继续使用当前Token）
8:03:15 PM咩咩咩-2-689898963 未找到BIN刷新数据，已跳过执行前刷新（继续使用当前Token）
8:03:15 PM执行前Token刷新完成：成功0，跳过4，失败0
8:03:15 PM=== 开始验证定时任务 test 的依赖 ===
8:03:15 PM✅ localStorage可用
8:03:15 PM✅ 将使用 4 个账号执行任务
8:03:15 PM=== 定时任务 test 的依赖验证通过，将执行 4 个账号 ===
8:03:15 PM执行任务: 重置罐子
8:03:15 PM执行任务: 一键答题
8:03:15 PM正在连接... (队列: 2/2)
8:03:15 PM正在连接... (队列: 2/2)
8:03:15 PM正在加载题库...
8:03:15 PM=== 开始答题: 咩咩-0-529938321 ===
8:03:15 PM=== 开始答题: 咩咩咩-1-597541905 ===
8:03:15 PM=== 开始答题: 咩咩-0-664382501 ===
8:03:15 PM=== 开始答题: 咩咩咩-2-689898963 ===
8:03:16 PM=== 开始重置罐子: 咩咩咩-1-597541905 ===
8:03:16 PM咩咩咩-1-597541905 停止计时...
8:03:16 PM=== 开始重置罐子: 咩咩-0-529938321 ===
8:03:16 PM咩咩-0-529938321 停止计时...
8:03:16 PM咩咩咩-1-597541905 开始计时...
8:03:16 PM咩咩-0-529938321 开始计时...
8:03:16 PM=== 咩咩咩-1-597541905 重置完成 ===
8:03:16 PM咩咩咩-1-597541905 连接已关闭 (队列: 1/2)
8:03:16 PM=== 咩咩-0-529938321 重置完成 ===
8:03:16 PM咩咩-0-529938321 连接已关闭 (队列: 0/2)
8:03:17 PM正在连接... (队列: 1/2)
8:03:17 PM正在连接... (队列: 2/2)
8:03:18 PM=== 开始重置罐子: 咩咩咩-2-689898963 ===
8:03:18 PM咩咩咩-2-689898963 停止计时...
8:03:18 PM=== 开始重置罐子: 咩咩-0-664382501 ===
8:03:18 PM咩咩-0-664382501 停止计时...
8:03:18 PM咩咩咩-2-689898963 开始计时...
8:03:18 PM咩咩-0-664382501 开始计时...
8:03:18 PM=== 咩咩咩-2-689898963 重置完成 ===
8:03:18 PM咩咩咩-2-689898963 连接已关闭 (队列: 1/2)
8:03:18 PM=== 咩咩-0-664382501 重置完成 ===
8:03:18 PM咩咩-0-664382501 连接已关闭 (队列: 0/2)
8:03:19 PM正在连接... (队列: 1/2)
8:03:19 PM正在连接... (队列: 2/2)
8:03:20 PM咩咩咩-1-597541905 开始答题...
8:03:20 PM咩咩-0-529938321 开始答题...
8:03:23 PMtasks updated via API, count=2
8:03:25 PM咩咩咩-1-597541905 领取奖励...
8:03:25 PM咩咩-0-529938321 领取奖励...
8:03:27 PM=== 咩咩咩-1-597541905 答题完成 ===
8:03:27 PM咩咩咩-1-597541905 连接已关闭 (队列: 1/2)
8:03:27 PM=== 咩咩-0-529938321 答题完成 ===
8:03:27 PM咩咩-0-529938321 连接已关闭 (队列: 0/2)
8:03:27 PM正在连接... (队列: 1/2)
8:03:27 PM正在连接... (队列: 2/2)
8:03:27 PM页面控制台错误: wss://xxz-xyzw.hortorgames.com/agent?p=%7B%22roleToken%22%3A%22JHpc70VxSw6rfsi%2BclwqoTkl2yGJajwhNl%2BLmdDHUHdBg%2BT%2FNzdGhZ4Z6caaX100zlxt883JalVhPbfBE9jyio6WshYSz29S3Ua1ZTGvsufHyiWvb6GX7qNWnw%2Boi1xVmbvlNtpGSk07oCMdSSN4iAOwznCq5NGZfY7etgaedaM%3D%22%2C%22roleId%22%3A349039073%2C%22sessId%22%3A177729138038259%2C%22connId%22%3A1777291380391%2C%22isRestore%22%3A0%7D&e=x&lang=chinese-role_getroleinfo: the ajax request is failed : Error: WebSocket 连接已关闭
8:03:27 PM页面控制台错误: wss://xxz-xyzw.hortorgames.com/agent?p=%7B%22roleToken%22%3A%22slV36Fw0XevECFmBGDju6e0VOup%2B9IaLDPuta9A%2Bpt13NARZU4zsaK2yi%2FJ0nmX55ZS2x71vtKHWm0oHmBKfEVqZVkHsYKUdgosoGvAfRgl1r74YqHZhVtglEAzFBi76Gfn09BOuJ4b7JHVEjJUixv1CjbfKGGK4GKyUcubM9ys%3D%22%2C%22roleId%22%3A349039073%2C%22sessId%22%3A177729138038100%2C%22connId%22%3A1777291380385%2C%22isRestore%22%3A0%7D&e=x&lang=chinese-role_getroleinfo: the ajax request is failed : Error: WebSocket 连接已关闭
8:03:28 PM咩咩咩-2-689898963 开始答题...
8:03:28 PM咩咩-0-664382501 开始答题...
8:03:33 PM咩咩咩-2-689898963 领取奖励...
8:03:33 PM咩咩-0-664382501 领取奖励...
8:03:35 PM=== 咩咩咩-2-689898963 答题完成 ===
8:03:35 PM咩咩咩-2-689898963 连接已关闭 (队列: 1/2)
8:03:35 PM=== 咩咩-0-664382501 答题完成 ===
8:03:35 PM咩咩-0-664382501 连接已关闭 (队列: 0/2)
8:03:35 PM=== 定时任务执行完成: test ===
8:03:35 PM页面控制台错误: wss://xxz-xyzw.hortorgames.com/agent?p=%7B%22roleToken%22%3A%22KRcUcN8YCSQ0abkoVX0V2fjzZp56cqkyT7dQB%2FV09IisEL0l1%2FlvxFz89rhs3MQrL0fUvgLUgN%2BXt%2BhS7SuhysJVLrS8iR5lEyFZnYBm9n8vMIx%2F%2BxNp6VFCfq51sUrnPvHSefUEcYxF99OsZ36FKL1v07j9R335aLd4s7rA6lU%3D%22%2C%22roleId%22%3A349039073%2C%22sessId%22%3A177729138038238%2C%22connId%22%3A1777291380387%2C%22isRestore%22%3A0%7D&e=x&lang=chinese-role_getroleinfo: the ajax request is failed : Error: WebSocket 连接已关闭
8:03:35 PM页面控制台错误: wss://xxz-xyzw.hortorgames.com/agent?p=%7B%22roleToken%22%3A%22T%2FeMJnkDpcD0buW5d4ermIheIilPij2PcoPddeVOoedQOZQ2UYCLZHaiX65G8GdCnHQUGPUID6DbQ0t03etK92sl701YO2t9%2Bpn46I94yxGDJyAleFZ7rB0xy5nlTgO2djpwJfx%2BbFleYvNBBXartv1m%2FJ7BQ13jh8ybYY4MVRw%3D%22%2C%22roleId%22%3A349039073%2C%22sessId%22%3A177729138038235%2C%22connId%22%3A1777291380389%2C%22isRestore%22%3A0%7D&e=x&lang=chinese-role_getroleinfo: the ajax request is failed : Error: WebSocket 连接已关闭
