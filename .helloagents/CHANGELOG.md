# 变更日志

## [Unreleased]

### 变更

- **[channels/sites/admin-ui/settings]**: 统一站点验证与恢复评估语义，验证结果改为阶段化输出并接入真实 provider-aware 服务验证链路 — by openclaw
  - 方案: [202604042102_site-verification-system](plan/202604042102_site-verification-system/)
  - 决策: site-verification-system#D001(统一站点验证语义并复用真实代理链路)

- **[tooling/docs]**: 清理仓库内本地 unit/service 测试文件，保留 Playwright E2E，并同步校验链说明 — by openclaw
  - 方案: [202604031348_remove-all-test-files](archive/2026-04/202604031348_remove-all-test-files/)
  - 决策: remove-all-test-files#D001(删除本地 unit/service 测试，但保留 Playwright E2E)

- **[tooling]**: `bun run autostart` 新增 Linux `systemd --user` 自启动支持，并保留 Windows 计划任务实现 — by openclaw
  - 方案: [202604031311_linux-systemd-autostart](archive/2026-04/202604031311_linux-systemd-autostart/)
  - 决策: linux-systemd-autostart#D001(Linux 自启动采用 systemd --user service)

- **[tooling/docs]**: 统一本地启动运行时目录，Windows 自启动改为计划任务，并新增后台日志模式控制 — by lsy
  - 方案: [202604022339_startup-runtime-hardening](archive/2026-04/202604022339_startup-runtime-hardening/)
  - 决策: startup-runtime-hardening#D001(Windows 自启动改用计划任务), startup-runtime-hardening#D002(运行时配置与日志统一收敛到 .dev)

### 修复

- **[proxy/sites/admin-ui]**: 修复候选站点筛选与真实模型解析口径不一致、调用 token 模型写回污染，以及使用日志缺少策略判定上下文的问题 — by Codex
  - 方案: [202604071250_candidate-routing-alignment](plan/202604071250_candidate-routing-alignment/)
- **[worker/proxy]**: 修复渠道不支持目标模型时仍可能回退到首个已知模型并误发请求的问题；现在仅允许显式 `model_mapping` 改写模型，未命中模型的渠道会在候选筛选与实际请求阶段一并跳过 — by Codex
  - 类型: 快速修改（无方案包）
  - 文件: apps/worker/src/services/channel-routing.ts, apps/worker/src/shared/proxy.ts

- **[tooling]**: 修复 Linux `systemd --user` 自启动仍经由 `--bg` 二次派生导致开机状态误判，改为直接托管守护进程并增强 `autostart status` 运行态识别 — by openclaw
  - 方案: [202604031515_linux-autostart-boot-fix](archive/2026-04/202604031515_linux-autostart-boot-fix/)

- **[proxy/usage]**: 删除 stream usage 旁路解析的固定 `maxBytes` 截断，避免长 Responses 流在尾部 usage 到达前被误记为 `stream_meta_partial` — by lsy
  - 方案: [202604030046_remove-stream-usage-maxbytes](archive/2026-04/202604030046_remove-stream-usage-maxbytes/)
- **[worker/proxy]**: 修复 OpenAI→Anthropic 流式适配仅转文本导致 Claude Code 无法消费工具调用，补齐 `tool_calls -> tool_use + input_json_delta` 事件链 — by Codex
  - 类型: 快速修改（无方案包）
  - 文件: apps/worker/src/services/chat-response-adapter.ts, apps/worker/src/services/chat-response-adapter.test.ts, .helloagents/modules/proxy.md

### 快速修改

- **[tooling]**: 修复计划任务直接执行 `bun.exe` 仍可能弹出控制台窗口，改为隐藏 PowerShell 启动器包裹 `bun run dev -- --bg` — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/autostart.mjs, README.md, .helloagents/modules/tooling.md

- **[tooling]**: 修复 Windows 后台守护进程子进程仍可能弹出控制台窗口，改为隐藏窗口并显式重定向 stdout/stderr 到日志文件或空设备 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/dev.mjs, README.md, .helloagents/modules/tooling.md

- **[tooling]**: 修复输出到 `.dev/generated/wrangler/` 后 `main` 与 `assets.directory` 仍按相对路径解析，导致 Wrangler 找不到入口文件 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/prepare-remote-config.mjs, scripts/prepare-no-hot-cache-config.mjs, .helloagents/modules/tooling.md

- **[worker/proxy]**: 删除 `chat-response-adapter` 与 `provider-transform` 中未使用的 JS 回退转换辅助函数，保留 WASM 主路径 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/worker/src/services/chat-response-adapter.ts:1-140, apps/worker/src/services/provider-transform.ts:1-170

### ????

- **[proxy/usage]**: ???? usage ?????? ? by lsy
  - ??: ??????????
  - ??: apps/worker/src/routes/proxy.ts:70-560, .helloagents/modules/proxy.md:20-40, .helloagents/modules/usage.md:10-30


### ??

- **[proxy/usage]**: ?? usage ???????????? ? by lsy
  - ??: [202603181533_usage-event-call-fix](archive/2026-03/202603181533_usage-event-call-fix/)


### 新增

- **[deploy-workflow]**: 新增本地一键部署脚本（init/update） — by lsy
  - 方案: [202603161914_local-deploy-script](archive/2026-03/202603161914_local-deploy-script/)

### 变更

- **[settings/admin-ui]**: 设置页分区重排并内联队列状态与使用数量 — by lsy
  - 方案: [202603181300_settings-panel-sections](archive/2026-03/202603181300_settings-panel-sections/)
  - 决策: settings-panel-sections#D001(只读项内联展示)
- **[settings/admin-ui]**: 运行时设置改为仅数据库生效，移除环境变量回退 — by lsy
  - 方案: [202603181221_settings-db-only](archive/2026-03/202603181221_settings-db-only/)
  - 决策: settings-db-only#D001(停用环境变量回退)
- **[settings/proxy/usage/admin-ui]**: 运行时设置可在后台配置，新增队列日限额与直写比例并接入 UsageLimiter — by lsy
  - 方案: [202603180031_usage-queue-simplified](archive/2026-03/202603180031_usage-queue-simplified/)
- **[cache/settings/proxy/usage/admin-ui]**: 引入分组缓存与自动失效，面板/日志/模型短期缓存可配置，清理节流并补齐索引 — by lsy
  - 方案: [202603172242_cache-strategy-optimizations](plan/202603172242_cache-strategy-optimizations/)
- **[deploy/proxy/settings]**: 调整 stream usage 默认值并避免部署覆盖云端变量 — by lsy
  - 方案: [202603170025_runtime-defaults-no-override](archive/2026-03/202603170025_runtime-defaults-no-override/)
- **[admin-ui/usage]**: 使用日志渠道筛选改为搜索多选，分页条数与列偏好本地记忆 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[admin-ui/usage]**: 状态展示改为仅显示上游状态码并在详情弹窗展示完整错误摘要 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[admin-ui/usage]**: 修复使用日志多选下拉的宽度与定位 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[admin-ui]**: 页面布局拆分为标题/筛选/数据区，数据面板筛选条更紧凑 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[usage]**: 使用日志筛选支持渠道/令牌/模型/状态多选查询 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[deploy-workflow]**: 本地部署脚本改为纯本地流程（构建 + 本地迁移） — by lsy
  - 方案: [202603162008_local-deploy-local-only](archive/2026-03/202603162008_local-deploy-local-only/)
- **[settings/admin-ui]**: 设置接口返回运行时配置，管理台只读展示并指引环境变量配置
  - 方案: [202603161748_settings-runtime-env-display](archive/2026-03/202603161748_settings-runtime-env-display/)
- **[deploy-workflow]**: 部署流程自动创建 `usage-events` Queue（存在则跳过） — by lsy
  - 方案: [202603161714_deploy-create-queue](archive/2026-03/202603161714_deploy-create-queue/)
  - 决策: deploy-create-queue#D001(CI 自动创建队列)
- **[admin-ui/dashboard]**: Dashboard 样板页引入 Apple 风主题（bento grid 卡片/表格/按钮重绘）
  - 方案: [202603152243_apple-ui-sample-dashboard](archive/2026-03/202603152243_apple-ui-sample-dashboard/)
  - 文件: apps/ui/src/features/DashboardView.tsx, apps/ui/src/styles.css, .helloagents/modules/admin-ui.md, .helloagents/modules/dashboard.md
- **[sites]**: 站点类型接口字段由 claude 改为 Anthropic，并新增数据迁移脚本
  - 类型: 变更（无方案包）
  - 文件: apps/worker/src/services/site-metadata.ts, apps/worker/src/routes/sites.ts, apps/worker/src/services/channel-metadata.ts, apps/worker/src/services/provider-transform.ts, apps/worker/src/routes/proxy.ts, apps/worker/migrations/0003_rename_claude_anthropic.sql, apps/ui/src/core/types.ts, apps/ui/src/core/sites.ts, apps/ui/src/features/SitesView.tsx, apps/ui/src/App.tsx, tests/worker/provider-transform.test.ts, tests/worker/channel-metadata.test.ts, helloagents/modules/admin-ui.md, helloagents/modules/sites.md, helloagents/modules/channels.md, helloagents/modules/proxy.md
- **[admin-ui]**: 站点类型显示将 Claude 调整为 Anthropic，并移除无用的 ChannelsView 导出
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/features/SitesView.tsx, apps/ui/src/core/sites.ts, apps/ui/src/features/ChannelsView.tsx, helloagents/modules/admin-ui.md, helloagents/modules/sites.md, helloagents/modules/channels.md
- **[proxy]**: 代理支持 OpenAI/Anthropic/Gemini 下游与上游格式转换，加入模型映射与上游覆盖配置
  - 类型: 变更
  - 方案: [202602271236_proxy-multi-provider](plan/202602271236_proxy-multi-provider/)
  - 文件: apps/worker/src/routes/proxy.ts, apps/worker/src/services/channel-metadata.ts, apps/worker/src/services/provider-transform.ts, apps/worker/src/utils/usage.ts, tests/worker/usage.test.ts, tests/worker/channel-metadata.test.ts, tests/worker/provider-transform.test.ts, helloagents/modules/proxy.md, helloagents/INDEX.md

### 微调

- **[admin-ui/settings]**: 运行时配置卡片展示并内联环境变量名 — by lsy
  - 方案: [202603162329_settings-runtime-config-cards](archive/2026-03/202603162329_settings-runtime-config-cards/)
- **[proxy/settings]**: 流式 usage 解析上限支持 `0` 表示无限制 — by lsy
  - 方案: [202603161849_stream-usage-unlimited](archive/2026-03/202603161849_stream-usage-unlimited/)
- **[worker/models]**: 引入通道模型能力表并基于“模型广场测试结果+可配置TTL（默认2小时）”进行模型发布与路由匹配
  - 类型: 微调（无方案包）
  - 文件: apps/worker/migrations/0004_add_channel_model_capabilities.sql, apps/worker/src/services/channel-model-capabilities.ts, apps/worker/src/services/channel-testing.ts, apps/worker/src/services/settings.ts, apps/worker/src/routes/settings.ts, apps/worker/src/routes/models.ts, apps/worker/src/routes/newapiUsers.ts, apps/worker/src/routes/proxy.ts, tests/worker/channel-model-capabilities.test.ts, tests/worker/newapi.test.ts, helloagents/modules/settings.md, helloagents/modules/models.md, helloagents/modules/proxy.md
- **[worker/models]**: 运行时失败冷却与成功刷新能力表，TTL 过期回退模型列表
  - 方案: [202603141718_model-health](archive/2026-03/202603141718_model-health/)
  - 文件: apps/worker/src/routes/proxy.ts, apps/worker/src/services/channel-model-capabilities.ts, apps/worker/src/routes/models.ts, apps/worker/src/routes/newapiUsers.ts, apps/worker/src/services/settings.ts, apps/worker/src/routes/settings.ts, tests/worker/settings.test.ts, tests/worker/channel-model-capabilities.test.ts, .helloagents/modules/proxy.md, .helloagents/modules/models.md, .helloagents/modules/settings.md
- **[proxy]**: 失败判定简化为非 2xx/超时即失败
  - 方案: [202603141749_usage-summary](archive/2026-03/202603141749_usage-summary/)
  - 文件: apps/worker/src/routes/proxy.ts
- **[usage/proxy]**: 使用日志记录上游失败详情并在日志状态列展示
  - 方案: [202603141815_usage-log-status](archive/2026-03/202603141815_usage-log-status/)
  - 文件: apps/worker/migrations/0005_add_usage_error_fields.sql, apps/worker/src/db/schema.sql, apps/worker/src/services/usage.ts, apps/worker/src/routes/proxy.ts, apps/ui/src/core/types.ts, apps/ui/src/core/utils.ts, apps/ui/src/features/UsageView.tsx, tests/ui/usage-status.test.ts, .helloagents/modules/usage.md, .helloagents/modules/admin-ui.md
- **[admin-ui/usage]**: 状态列改为“状态码 + 错误码”，成功展示 `200 OK`
  - 方案: [202603141925_usage-status-label](archive/2026-03/202603141925_usage-status-label/)
  - 文件: apps/worker/src/routes/proxy.ts, apps/ui/src/core/utils.ts, apps/ui/src/features/UsageView.tsx, tests/ui/usage-status.test.ts, .helloagents/modules/usage.md, .helloagents/modules/admin-ui.md
- **[worker/proxy]**: 移除临时调试日志（请求入口/出口与上游响应汇总）
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/index.ts, apps/worker/src/routes/proxy.ts
- **[worker/proxy]**: 请求日志改为安全采样并补充上游失败异常日志，便于定位 Claude 请求故障
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/index.ts, apps/worker/src/routes/proxy.ts
- **[worker/proxy]**: 上游请求新增超时中断（默认 30s），避免代理请求卡住“有进没出”
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, apps/worker/src/env.ts, apps/worker/wrangler.toml
- **[worker/proxy]**: 候选通道改为“模型匹配优先、同提供商次优、全通道兜底”并补充筛选日志
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, tests/worker/channel-metadata.test.ts
- **[worker/proxy]**: 跨提供商且无显式模型映射时自动选择通道已声明模型，提升上下游互转可用性
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, tests/worker/channel-metadata.test.ts
- **[worker/proxy]**: 自动模型兜底改为学习型复用（成功后记忆映射），并增加失败通道退避与 `PROXY_RETRY_ON_429` 开关降低长耗时重试
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, apps/worker/src/env.ts, apps/worker/wrangler.toml, tests/worker/channel-metadata.test.ts
- **[worker/proxy]**: 通道选择不再受下游协议约束，并新增 OpenAI→Anthropic 响应转换（含 SSE）修复上游成功但客户端无输出
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, tests/worker/channel-metadata.test.ts
- **[worker/proxy]**: 按“以上游为准”收敛，移除学习映射/失败退避/429重试开关，保留确定性转换与超时保护
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, apps/worker/src/env.ts, apps/worker/wrangler.toml
- **[worker/proxy]**: 新增响应适配器注册层（OpenAI↔Anthropic，JSON+SSE），并将上游模型决策与下游协议完全解耦
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/services/chat-response-adapter.ts, apps/worker/src/routes/proxy.ts, tests/worker/provider-transform.test.ts, tests/worker/channel-metadata.test.ts
- **[checkin]**: 自动签到不再依赖站点启用状态
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/services/checkin-runner.ts, tests/worker/checkin-runner.test.ts, helloagents/modules/sites.md
- **[checkin]**: 自动签到仅依赖 checkin_enabled，不再限制 site_type
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/services/checkin-runner.ts, helloagents/modules/sites.md
- **[sites]**: 站点类型名称从 chatgpt 调整为 openai
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/App.tsx, apps/ui/src/core/sites.ts, apps/ui/src/core/types.ts, apps/ui/src/features/SitesView.tsx, apps/worker/src/routes/sites.ts, apps/worker/src/services/site-metadata.ts, apps/worker/migrations/0003_rename_chatgpt_openai.sql, helloagents/modules/admin-ui.md, helloagents/modules/channels.md, helloagents/modules/sites.md
- **[worker]**: Durable Object 迁移改用 new_sqlite_classes 以兼容免费计划
  - 类型: 微调（无方案包）
  - 文件: apps/worker/wrangler.toml
- **[admin-ui]**: 令牌创建表单使用 FormData.forEach 以兼容缺少 entries 的类型定义
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/App.tsx
- **[admin-ui]**: 清理站点列表未使用变量以通过 lint
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/features/SitesView.tsx
- **[worker]**: 时间工具函数移除非空断言以满足 lint
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/utils/time.ts
- **[admin-ui]**: 站点管理新增一键测试并汇总结果提示
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/App.tsx, apps/ui/src/features/SitesView.tsx, apps/ui/src/core/sites.ts, tests/ui/sites.test.ts
- **[admin-ui]**: 编辑站点时站点类型/状态选择与当前值一致
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/features/SitesView.tsx:567-689
- **[ci]**: push 变更检测在 before 提交缺失时按全量变更处理并拉全历史
  - 类型: 微调（无方案包）
  - 文件: .github/workflows/deploy.yml:45-100
- **[admin-ui]**: 处理剪贴板异常时忽略未使用的错误变量
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/App.tsx:500
- **[worker]**: 创建渠道时 metadata_json 为空则写入 null 以满足类型约束
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/newapiChannels.ts:293
- **[admin-ui]**: 令牌查看自动复制并提示
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/App.tsx:440-455
- **[docs]**: 补充本地开发流程、API 接口与 GitHub Actions 自动部署说明
  - 类型: 微调（无方案包）
  - 文件: README.md:12-272
- **[worker]**: 补齐 admin 静态目录占位以通过 wrangler assets 检查
  - 类型: 微调（无方案包）
  - 文件: apps/ui/dist/.gitkeep
- **[worker]**: 修正 wrangler assets 配置并为非 API 路由回退静态资源
  - 类型: 微调（无方案包）
  - 文件: apps/worker/wrangler.toml:15-19, apps/worker/src/index.ts:114-127
- **[tooling]**: 修复 bun check 脚本名称（移除尾随空格）
  - 类型: 微调（无方案包）
  - 文件: package.json
- **[docs]**: 补充云端部署与本地迁移的区分说明
  - 类型: 微调（无方案包）
  - 文件: README.md
- **[ci]**: 自动部署加入远程 D1 迁移步骤
  - 类型: 微调（无方案包）
  - 文件: .github/workflows/deploy.yml
- **[ci]**: 对齐 CloudPaste 风格的 SPA 自动部署流程与数据库初始化
  - 类型: 微调（无方案包）
  - 文件: .github/workflows/deploy.yml
- **[docs]**: 说明 SPA_DEPLOY 自动部署开关
  - 类型: 微调（无方案包）
  - 文件: README.md
- **[admin-ui]**: 渠道创建移除 ID 字段并校验名称唯一
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/main.tsx:250-287, 664-829
- **[worker]**: 全局记录收到的请求概要
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/index.ts
- **[worker]**: base_url 为空时返回空字符串避免崩溃
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/utils/url.ts
- **[tooling]**: dev 脚本改为 Bun workspace 执行
  - 类型: 微调（无方案包）
  - 文件: package.json
- **[admin-ui]**: 本地开发增加 Vite proxy 解决前后端端口不一致
  - 类型: 微调（无方案包）
  - 文件: apps/ui/vite.config.ts, README.md
- **[worker]**: 补充 wrangler.toml 示例配置占位
  - 类型: 微调（无方案包）
  - 文件: apps/worker/wrangler.toml
- **[admin-ui]**: 渠道 ID 与日志渠道可见，操作反馈更清晰
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/main.ts
- **[worker]**: 使用日志关联渠道/令牌，base_url 自动纠正
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/usage.ts, apps/worker/src/routes/channels.ts, apps/worker/src/routes/proxy.ts
- **[worker]**: 渠道 ID 支持自定义，令牌可二次查看
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/channels.ts, apps/worker/src/routes/tokens.ts, apps/worker/src/db/schema.sql, apps/worker/migrations/0002_add_token_plain.sql
- **[admin-ui]**: 渠道 ID 可录入、令牌查看按钮
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/main.ts
- **[tests]**: 补充 URL 规范化单测
  - 类型: 微调（无方案包）
  - 文件: tests/worker/url.test.ts
- **[proxy]**: 增加失败轮询重试与相关配置
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts, apps/worker/src/env.ts, apps/worker/wrangler.toml
- **[docs]**: 更新代理重试与本地配置说明
  - 类型: 微调（无方案包）
  - 文件: README.md, helloagents/modules/proxy.md
- **[worker]**: 放宽路由严格匹配以兼容 `/api/channel/` 尾斜杠
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/index.ts
- **[worker]**: 新增 `/api/group` 兼容接口并放行鉴权
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/index.ts, apps/worker/src/routes/newapiGroups.ts, tests/worker/newapi.test.ts
- **[proxy]**: 流式请求自动补 `stream_options.include_usage` 以获取 usage
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/proxy.ts

### 修复

- **[deploy-workflow]**: 队列检查改为 Node 解析并容错非 JSON 输出 — by lsy
  - 方案: [202603162220_deploy-queue-json-parse](archive/2026-03/202603162220_deploy-queue-json-parse/)
  - 决策: deploy-queue-json-parse#D001(队列列表解析方式选择)
- **[dashboard]**: 修复数据面板筛选 SQL 歧义导致的 500 错误 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[admin-ui/sites]**: 修复站点管理筛选区域 JSX 结构错误导致构建失败 — by lsy
  - 方案: [202603170949_shadcn-unified-ui](archive/2026-03/202603170949_shadcn-unified-ui/)
- **[admin-ui]**: Toast 通知固定右上并带进度条，弹窗改为全屏遮罩，筛选标题横排 — by lsy
  - 方案: [202603160049_modal-toast-search-fixes](archive/2026-03/202603160049_modal-toast-search-fixes/)
  - 决策: modal-toast-search-fixes#D001(通知统一为右上 Toast)

### 快速修改

- **[deploy-workflow]**: 本地部署脚本移除 .env 自动生成与加载 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/deploy.mjs:1-292
- **[admin-ui/settings]**: 缓存 TTL 与版本成对展示为卡片 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/ui/src/features/SettingsView.tsx:417-632
- **[admin-ui/settings]**: 缓存版本调整为小标题展示 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/ui/src/features/SettingsView.tsx:566-584
- **[ci]**: 队列创建失败时识别“名称已占用(11009)”并视为已存在 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: .github/workflows/deploy.yml:263-320,416-473
- **[ci]**: 队列创建失败时输出完整错误信息 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: .github/workflows/deploy.yml:263-320,416-473
- **[ci]**: 修复队列检查脚本的 heredoc 缩进导致的 YAML 解析失败 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: .github/workflows/deploy.yml:263-316,416-469
- **[tooling]**: dev 脚本适配 bun 可执行路径解析 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/dev.mjs
- **[deploy-workflow]**: 本地部署脚本适配 bun 可执行路径解析 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/deploy.mjs
- **[tooling]**: 将 `dev:all` 简化为 `dev` 脚本 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: package.json, README.md
- **[deploy-workflow]**: 缺少环境变量时 .env 优先从 .env.example 生成 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/deploy.mjs, .helloagents/modules/deploy-workflow.md
- **[deploy-workflow]**: .env.example 注释改为中文并补充默认代理配置 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: .env.example
- **[deploy-workflow]**: 本地部署脚本补充 .env 占位与 .env.example 模板 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/deploy.mjs, .env.example, .helloagents/modules/deploy-workflow.md, README.md
- **[deploy-workflow]**: 本地部署脚本未传参时支持交互选择 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: scripts/deploy.mjs, README.md, .helloagents/modules/deploy-workflow.md
- **[deploy-workflow]**: 增加本地部署脚本的 package scripts 快捷入口 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: package.json, README.md
- **[docs]**: README 补充系统设置的运行时环境变量说明
  - 类型: 快速修改（无方案包）
  - 文件: README.md
- **[admin-ui]**: 加深弹窗遮罩并支持多条通知弹窗，使用日志表头遮罩更清晰 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/ui/src/App.tsx:129-220,1357-1510, apps/ui/src/features/AppLayout.tsx:1-195, apps/ui/src/features/SitesView.tsx:582, apps/ui/src/features/TokensView.tsx:415, apps/ui/src/features/UsageView.tsx:209-219,377, apps/ui/src/styles.css:424-440

## [0.9.7] - 2026-03-16

### 变更
- **[proxy/usage]**: 引入 usage 队列异步写入与流式解析降载，增加 CPU 降载开关 — by lsy
  - 方案: [202603161542_proxy-cpu-limit-mitigation](archive/2026-03/202603161542_proxy-cpu-limit-mitigation/)
  - 决策: proxy-cpu-limit-mitigation#D001(用量写入异步化策略)

## [0.9.6] - 2026-03-15

### 修复
- **[opencode-config]**: 配置 Gemini + Claude 模型并补充鉴权头 — by lsy
  - 方案: [202603152216_opencode-models-gemini-claude](archive/2026-03/202603152216_opencode-models-gemini-claude/)

## [0.9.5] - 2026-03-15

### 修复
- **[opencode-config]**: 更新 OpenCode 模型列表与默认模型 — by lsy
  - 方案: [202603152138_opencode-model-config](archive/2026-03/202603152138_opencode-model-config/)

### 快速修改

- **[admin-ui]**: 修复模型广场渲染语法错误 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/ui/src/features/ModelsView.tsx:16
- **[admin-ui]**: 站点搜索加入防抖与使用日志状态码/摘要展示优化 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/ui/src/features/SitesView.tsx, apps/ui/src/core/utils.ts, apps/ui/src/features/UsageView.tsx
- **[admin-ui]**: 提交操作增加即时防重复锁，避免连点重复创建 — by lsy
  - 类型: 快速修改（无方案包）
  - 文件: apps/ui/src/App.tsx

## [0.9.4] - 2026-03-15

### 变更
- **[usage/admin-ui]**: 使用日志改为服务端分页并支持渠道/令牌/模型搜索 — by lsy
  - 方案: [202603150145_usage-log-pagination-and-channel-disable](archive/2026-03/202603150145_usage-log-pagination-and-channel-disable/)
  - 决策: usage-log-pagination-and-channel-disable#D001(使用 offset+limit+total 分页协议)
- **[channels]**: 连通性测试不再覆盖已禁用渠道状态 — by lsy
  - 方案: [202603150145_usage-log-pagination-and-channel-disable](archive/2026-03/202603150145_usage-log-pagination-and-channel-disable/)

## [0.9.2] - 2026-03-14

### 变更
- **[usage/proxy]**: 状态列仅展示日志状态码并支持错误详情查看，冷却改为窗口内连续失败触发 — by lsy
  - 方案: [202603142337_usage-status-cooldown-tuning](archive/2026-03/202603142337_usage-status-cooldown-tuning/)
  - 决策: usage-status-cooldown-tuning#D001(连续失败阈值冷却)

## [0.9.1] - 2026-03-14

### 变更
- **[proxy/models/settings/admin-ui]**: 移除模型能力 TTL，路由不再兜底并支持失败冷却配置 — by lsy
  - 方案: [202603142241_remove-model-ttl-fix-routing](archive/2026-03/202603142241_remove-model-ttl-fix-routing/)
  - 决策: remove-model-ttl-fix-routing#D001(移除模型能力 TTL)

## [0.9.2] - 2026-03-15

### 变更
- **[proxy/usage/admin-ui]**: 冷却仅对上游失败触发，使用日志列表仅展示状态码 — by lsy
  - 方案: [202603150017_usage-status-cooldown-migration](archive/2026-03/202603150017_usage-status-cooldown-migration/)
  - 决策: usage-status-cooldown-migration#D001(冷却仅针对上游/网络失败)

## [0.9.3] - 2026-03-15

### 变更
- **[proxy/usage]**: 所有调用写入日志，失败计数仅在成功时清零 — by lsy
  - 方案: [202603150017_usage-status-cooldown-migration](archive/2026-03/202603150017_usage-status-cooldown-migration/)
  - 决策: usage-status-cooldown-migration#D001(冷却仅针对上游/网络失败)

## [0.9.0] - 2026-03-14

### 新增
- **[admin-ui]**: 管理台体验升级（通知分级、确认弹窗、空状态 CTA、视觉主题与动效） — by lsy
  - 方案: [202603142024_admin-ui-ux-upgrade](archive/2026-03/202603142024_admin-ui-ux-upgrade/)
  - 决策: admin-ui-ux-upgrade#D001(统一通知与确认对话管理)

## [0.8.4] - 2026-02-25

### 变更
- **[checkin/settings]**: 定时签到改为始终启用，仅保留签到时间配置
  - 方案: [202602251706_checkin-always-on](archive/2026-02/202602251706_checkin-always-on/)
- **[admin-ui]**: 设置页移除定时签到启用开关
  - 方案: [202602251706_checkin-always-on](archive/2026-02/202602251706_checkin-always-on/)

## [0.8.3] - 2026-02-25

### 修复
- **[checkin]**: 后端定时自动签到接入 Durable Object Alarm 调度
  - 方案: [202602251604_checkin-do-alarm](archive/2026-02/202602251604_checkin-do-alarm/)
  - 决策: checkin-do-alarm#D001(采用 Durable Object Alarm)
- **[checkin]**: 修改签到时间后当日可再次触发自动签到
  - 方案: [202602251604_checkin-do-alarm](archive/2026-02/202602251604_checkin-do-alarm/)

## [0.8.2] - 2026-02-23

### 修复
- **[proxy]**: Responses 流式 usage 解析支持 `response.usage`
  - 方案: [202602230044_usage-parse-fix](archive/2026-02/202602230044_usage-parse-fix/)

## [0.8.1] - 2026-02-23

### 变更
- **[admin-ui]**: 站点管理新增搜索与排序，移动端提供排序控件
  - 方案: [202602230005_site-sort-search](archive/2026-02/202602230005_site-sort-search/)
- **[tests]**: 增加站点搜索与排序单测
  - 方案: [202602230005_site-sort-search](archive/2026-02/202602230005_site-sort-search/)

## [0.8.0] - 2026-02-22

### 变更
- **[channels]**: 连通测试改为遍历调用令牌并汇总模型与结果统计
  - 方案: [202602222335_multi-token-test-checkin-default-off](archive/2026-02/202602222335_multi-token-test-checkin-default-off/)
- **[admin-ui]**: 新增站点默认关闭自动签到，连通测试提示令牌统计
  - 方案: [202602222335_multi-token-test-checkin-default-off](archive/2026-02/202602222335_multi-token-test-checkin-default-off/)
- **[tests]**: 新增多令牌连通测试聚合单测
  - 方案: [202602222335_multi-token-test-checkin-default-off](archive/2026-02/202602222335_multi-token-test-checkin-default-off/)

### 修复

- **[checkin]**: 签到结果增加二次校验与非 JSON 响应判定
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/services/checkin.ts
- **[checkin]**: 已签到判定兼容 `checkin_date` 与“今日已签到”消息
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/services/checkin.ts

### 变更

- **[sites/admin-ui]**: 移除历史签到记录关联入口与 orphans 返回，简化站点签到提示
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/sites.ts, apps/ui/src/features/SitesView.tsx, apps/ui/src/App.tsx, apps/ui/src/core/types.ts, apps/ui/src/core/constants.ts, helloagents/modules/sites.md, helloagents/modules/checkin.md, helloagents/modules/admin-ui.md
- **[checkin/db]**: 移除 `checkin_sites` 表与 `/api/checkin-sites` 路由，签到字段迁移至 `channels`
  - 类型: 微调（无方案包）
  - ⚠️ EHRB: 数据删除 - 用户已确认风险
  - 检测依据: DROP TABLE
  - 文件: apps/worker/src/index.ts, apps/worker/src/routes/sites.ts, apps/worker/src/services/checkin.ts, apps/worker/src/services/channel-repo.ts, apps/worker/src/services/channel-types.ts, apps/worker/src/db/schema.sql, apps/worker/migrations/0005_move_checkin_to_channels.sql, helloagents/modules/checkin.md, helloagents/modules/sites.md
- **[sites/proxy/admin-ui]**: 移除调用令牌的模型权限字段，改为按顺序选择令牌
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/sites.ts, apps/worker/src/routes/proxy.ts, apps/worker/src/services/call-token-selector.ts, apps/worker/src/services/channel-call-token-repo.ts, apps/worker/src/services/channel-call-token-types.ts, apps/ui/src/features/SitesView.tsx, apps/ui/src/App.tsx, apps/ui/src/core/types.ts, apps/ui/src/core/constants.ts, tests/worker/call-token-selector.test.ts, helloagents/modules/admin-ui.md, helloagents/modules/proxy.md, helloagents/plan/202602221951_site-redesign/proposal.md
- **[admin-ui]**: 新增站点默认开启自动签到，并限制调用令牌列表高度
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/core/constants.ts, apps/ui/src/features/SitesView.tsx, helloagents/modules/admin-ui.md
- **[admin-ui]**: 站点弹窗设置最大高度并允许表单滚动，避免调用令牌过多导致超出屏幕
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/features/SitesView.tsx
- **[checkin]**: 对齐 `/api/user/checkin` 接口并增加 `New-Api-User` 头支持
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/services/checkin.ts, apps/worker/src/routes/checkin-sites.ts, apps/ui/src/features/CheckinSitesView.tsx, apps/worker/migrations/0002_add_checkin_sites.sql
- **[checkin]**: 站点字段命名为 `userid`，结果展示移动到列表列
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/checkin-sites.ts, apps/ui/src/features/CheckinSitesView.tsx, apps/ui/src/core/types.ts
- **[checkin]**: 一键签到写回结果并跳过今日已签到站点
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/checkin-sites.ts, apps/ui/src/features/CheckinSitesView.tsx, apps/ui/src/core/types.ts, apps/ui/src/core/utils.ts, apps/ui/src/App.tsx
- **[settings]**: 增加定时签到开关与时间配置（中国时间）
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/settings.ts, apps/ui/src/features/SettingsView.tsx, apps/ui/src/core/types.ts, apps/ui/src/core/constants.ts, apps/ui/src/App.tsx, tests/worker/settings.test.ts
- **[admin-ui]**: 今日签到状态区分未签到与签到失败
  - 类型: 微调（无方案包）
  - 文件: apps/ui/src/features/CheckinSitesView.tsx
- **[checkin]**: 签到失败也标记当日状态，避免显示为未签到
  - 类型: 微调（无方案包）
  - 文件: apps/worker/src/routes/checkin-sites.ts
- **[db]**: 合并签到相关迁移到单一脚本
  - 类型: 微调（无方案包）
  - 文件: apps/worker/migrations/0002_add_checkin_sites.sql

## [0.7.1] - 2026-02-22

### 变更
- **[db]**: 合并 0002-0005 迁移为单一 0002 并同步 schema
  - 方案: [202602222203_merge-migrations](archive/2026-02/202602222203_merge-migrations/)

## [0.7.0] - 2026-02-22

### 变更
- **[sites]**: 站点重设计，支持系统令牌与多调用令牌、上游类型扩展与官方地址默认值
  - 方案: [202602221951_site-redesign](archive/2026-02/202602221951_site-redesign/)
  - 决策: site-redesign#D001(调用令牌独立表), site-redesign#D002(系统令牌复用 checkin_sites), site-redesign#D003(done-hub 仅默认地址)
- **[proxy]**: 按调用令牌模型权限选择上游并移除 done-hub 多地址切换
  - 方案: [202602221951_site-redesign](archive/2026-02/202602221951_site-redesign/)
- **[admin-ui]**: 站点管理重构为系统令牌 + 多调用令牌，并支持新上游类型
  - 方案: [202602221951_site-redesign](archive/2026-02/202602221951_site-redesign/)
- **[checkin]**: 签到支持自定义地址优先并保留 new-api 自动签到
  - 方案: [202602221951_site-redesign](archive/2026-02/202602221951_site-redesign/)
- **[db]**: 新增 `channel_call_tokens` 以存储多调用令牌
  - 方案: [202602221951_site-redesign](archive/2026-02/202602221951_site-redesign/)

## [0.6.0] - 2026-02-22

### 变更

- **[sites]**: 新增站点聚合接口与类型分类，支持自动关联签到记录
  - 方案: [202602221813_unify-sites](archive/2026-02/202602221813_unify-sites/)
  - 决策: unify-sites#D001(渠道为主 + 签到绑定)
- **[admin-ui]**: 站点管理合并渠道与签到配置，支持类型字段与一键签到
  - 方案: [202602221813_unify-sites](archive/2026-02/202602221813_unify-sites/)
- **[checkin]**: 签到记录关联渠道，仅对 new-api 站点执行
  - 方案: [202602221813_unify-sites](archive/2026-02/202602221813_unify-sites/)
- **[proxy]**: done-hub 站点按多地址配置选择上游
  - 方案: [202602221813_unify-sites](archive/2026-02/202602221813_unify-sites/)
- **[db]**: checkin_sites 增加 channel_id 关联字段与索引
  - 方案: [202602221813_unify-sites](archive/2026-02/202602221813_unify-sites/)

## [0.5.0] - 2026-02-22

### 新增

- **[checkin]**: 新增签到站点管理与一键签到
  - 方案: [202602221450_checkin-sites](archive/2026-02/202602221450_checkin-sites/)

## [0.4.11] - 2026-02-22

### 变更

- **[admin-ui]**: 管理台移动端适配（导航抽屉、列表卡片、表格横向滚动）
  - 方案: [202602220036_mobile-ui](archive/2026-02/202602220036_mobile-ui/)

## [0.4.10] - 2026-02-21

### 变更

- **[ci]**: D1 数据库名称调整为 `api-worker`
  - 方案: [202602212345_db-name-api-worker](archive/2026-02/202602212345_db-name-api-worker/)

## [0.4.9] - 2026-02-21

### 变更

- **[ci]**: 部署流程新增 init 动作并仅首次初始化
  - 方案: [202602212329_deploy-init-action](archive/2026-02/202602212329_deploy-init-action/)

## [0.4.8] - 2026-02-21

### 变更

- **[ci]**: 部署流程支持按变更范围选择前端/后端并默认按迁移变更执行
  - 方案: [202602211446_deploy-workflow-auto](archive/2026-02/202602211446_deploy-workflow-auto/)

## [0.4.7] - 2026-02-21

### 变更

- **[tooling]**: UI 目录从 apps/admin 迁移为 apps/ui 并同步配置
  - 方案: [202602211405_rename-admin-ui](archive/2026-02/202602211405_rename-admin-ui/)
- **[ci]**: 部署流程改用 apps/ui 与 api-worker-ui
  - 方案: [202602211405_rename-admin-ui](archive/2026-02/202602211405_rename-admin-ui/)
- **[docs]**: 文档与知识库路径更新为 apps/ui
  - 方案: [202602211405_rename-admin-ui](archive/2026-02/202602211405_rename-admin-ui/)

## [0.4.6] - 2026-02-21

### 变更

- **[tooling]**: 统一工作区包名与脚本为 api-worker / api-worker-ui
  - 方案: [202602161825_rename-api-worker-ui](archive/2026-02/202602161825_rename-api-worker-ui/)
- **[worker]**: Worker 部署名称更新为 api-worker
  - 方案: [202602161825_rename-api-worker-ui](archive/2026-02/202602161825_rename-api-worker-ui/)
- **[docs]**: README 与知识库名称同步为 api-worker / api-worker-ui
  - 方案: [202602161825_rename-api-worker-ui](archive/2026-02/202602161825_rename-api-worker-ui/)

## [0.4.5] - 2026-02-16

### 变更

- **[admin-ui]**: 令牌管理改为列表视图并支持分页弹窗创建
  - 方案: [202602161600_token-list-ui](archive/2026-02/202602161600_token-list-ui/)

## [0.4.4] - 2026-02-16

### 修复

- **[admin-ui]**: 使用日志默认每页 50 条并修正本地时间显示
  - 方案: [202602161433_usage-log-fixes](archive/2026-02/202602161433_usage-log-fixes/)
- **[usage/proxy]**: 使用日志补充首 token 延迟、流式与推理强度记录
  - 方案: [202602161433_usage-log-fixes](archive/2026-02/202602161433_usage-log-fixes/)

## [0.4.3] - 2026-02-16

### 变更

- **[admin-ui]**: 使用日志支持分页与指标拆分展示
  - 方案: [202602161355_usage-view-metrics](archive/2026-02/202602161355_usage-view-metrics/)

## [0.4.2] - 2026-02-16

### 变更

- **[deployment]**: 管理台通过 Worker Static Assets 部署并补齐手动/自动部署流程
  - 方案: [202602161013_worker-assets-deploy](archive/2026-02/202602161013_worker-assets-deploy/)

## [0.4.1] - 2026-02-15

### 变更

- **[admin-ui]**: 管理台入口拆分为模块、扁平化 features，并将 AppShell 调整为 AppLayout
  - 方案: [202602152325_admin-ui-modularize](archive/2026-02/202602152325_admin-ui-modularize/)
  - 决策: admin-ui-modularize#D001(功能域拆分)

## [0.4.0] - 2026-02-15

### 新增

- **[channels]**: New API 标签批量权重/启用/停用接口
  - 方案: [202602152211_newapi-tag-sync](archive/2026-02/202602152211_newapi-tag-sync/)

## [0.3.1] - 2026-02-15

### 修复

- **[proxy]**: 增强 usage 解析以修复使用日志与数据面板 token 统计为 0
  - 方案: [202602151843_fix-usage-tokens](archive/2026-02/202602151843_fix-usage-tokens/)

## [0.3.0] - 2026-02-15

### 变更

- **[admin-ui]**: 管理台改为 Hono + TSX DOM 渲染并接入 Tailwind v4
  - 方案: [202602151628_admin-ui-hono-tsx-tailwind](archive/2026-02/202602151628_admin-ui-hono-tsx-tailwind/)
  - 决策: admin-ui-hono-tsx-tailwind#D001(采用 Hono JSX DOM + Tailwind)

## [0.2.1] - 2026-02-15

### 变更

- **[tooling]**: 切换为 Bun 作为包管理器，补充部署说明与 fix 命令
  - 方案: [202602150153_bun-tooling](archive/2026-02/202602150153_bun-tooling/)

## [0.2.0] - 2026-02-15

### 新增

- **[channels/auth/models]**: 新增 New API 兼容渠道管理接口、用户模型接口与管理员令牌鉴权
  - 方案: [202602150127_newapi-channel-compat](archive/2026-02/202602150127_newapi-channel-compat/)
  - 决策: newapi-channel-compat#D001(新增兼容层并保留扩展字段)

## [0.1.0] - 2026-02-14

### 新增

- **[核心服务]**: 初始化 Worker + D1 后端与 Vite 管理台，提供渠道/模型/令牌/日志/面板与 OpenAI 兼容代理
  - 方案: [202602142217_new-api-lite](archive/2026-02/202602142217_new-api-lite/)
  - 决策: new-api-lite#D001(单 Worker + Hono), new-api-lite#D002(Vite + Pages), new-api-lite#D003(Token 默认全渠道), new-api-lite#D004(日志保留可配置)

### 修复

- **[{模块名}]**: {修复描述}
  - 方案: [{YYYYMMDDHHMM}\_{fix}](archive/{YYYY-MM}/{YYYYMMDDHHMM}_{fix}/)

### 微调

- **[{模块名}]**: {微调描述}
  - 类型: 微调（无方案包）
  - 文件: {文件路径}:{行号范围}

### 回滚

- **[{模块名}]**: 回滚至 {版本/提交}
  - 原因: {回滚原因}
  - 方案: [{原方案包}](archive/{YYYY-MM}/{原方案包}/)
