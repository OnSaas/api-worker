# api-worker

Cloudflare Workers + D1 的 API 网关与管理台一体化项目。

- 后端编排：`apps/worker`（主 Worker，负责鉴权、路由、重试编排）
- 后端执行：`apps/attempt-worker`（调用执行器 Worker，负责单次上游调用）
- 前端：`apps/ui`（Vite 管理控制台）
- 部署：Worker 静态资源模式，`apps/ui/dist` 与 Worker 一起发布

## 适用场景

- 统一管理多上游 AI 渠道（OpenAI / Anthropic / Gemini 等）
- 基于 Token 的访问控制、配额与用量统计
- 提供 OpenAI 兼容代理入口（`/v1/*`、`/v1beta/*`）
- 提供管理台用于渠道、模型、令牌、日志和系统设置维护

## 部署

### 部署前环境变量

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

说明：

- 创建 `CLOUDFLARE_API_TOKEN` 时，建议使用 **Account Token**，资源范围限制到目标账号（`CLOUDFLARE_ACCOUNT_ID` 对应账号）。
- 建议最小权限（Edit）：`Workers Scripts`、`D1`。
- 可选权限：`Workers Routes`（仅需要管理路由时）、`Workers Tail`（仅需要日志 tail 调试时）、`Workers Observability`（仅需要通过 Observability 能力查询/分析日志与追踪时）。

### GitHub Actions 自动部署

工作流：`.github/workflows/deploy.yml`（`Deploy SPA CF Workers[Worker一体化部署]`）

触发方式：

- `push` 到 `main/master` 且命中 `apps/ui/**`、`apps/worker/**` 或 `apps/attempt-worker/**`
- `workflow_dispatch` 手动触发
- `repository_dispatch`（`deploy-spa-button`）

需要配置的 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

可选变量：

- `SPA_DEPLOY`：自动部署开关（`true` / `false`）

### 本地部署脚本（不执行远程 deploy）

```bash
node scripts/deploy.mjs init
node scripts/deploy.mjs update
```

等价脚本：

```bash
bun run deploy:init
bun run deploy:update
```

说明：

- `init`：全量初始化流程（包含本地迁移）
- `update`：按参数执行构建与本地迁移判断
- 该脚本用于本地复刻流程，不会执行远程 `wrangler deploy`

## 技术栈

- Runtime: Cloudflare Workers
- API Framework: Hono
- Database: Cloudflare D1（SQLite）
- Stateful: Durable Objects
- WASM: Rust + wasm-bindgen（`apps/worker/wasm`）
- Frontend: Vite + TypeScript
- Monorepo: Bun workspaces

## 项目结构

```text
.
├─ apps/
│  ├─ worker/               # Worker API、路由、D1 迁移、wrangler 配置
│  │  ├─ src/
│  │  ├─ migrations/
│  │  ├─ wasm/
│  │  └─ wrangler.toml
│  ├─ attempt-worker/       # 调用执行器（单次上游调用）
│  └─ ui/                   # 管理台（Vite）
├─ scripts/
│  ├─ dev.mjs               # 本地并行启动 worker + attempt-worker + ui
│  └─ deploy.mjs            # 本地部署流程脚本（构建 + 本地迁移）
├─ package.json
└─ README.md
```

## 快速开始

### 1) 前置要求

- Bun `1.3.9`（见根 `package.json` 的 `packageManager`）
- Node.js（运行 `scripts/*.mjs`）
- Cloudflare Wrangler（通过 `bunx wrangler` 调用）

### 2) 安装依赖

```bash
bun install
```

### 3) 启动本地开发

同时启动 Worker 和 UI：

```bash
bun run dev
```

或分别启动：

```bash
bun run dev:attempt-worker
bun run dev:worker
bun run dev:ui
```

默认端口：

- Worker: `8787`（wrangler dev 默认）
- Attempt Worker: `8788`
- UI: `4173`

### 4) 首次本地迁移（推荐）

```bash
bun run --filter api-worker db:migrate
```

## 常用命令

```bash
bun run test
bun run typecheck
bun run lint
bun run format
bun run check
```

## Agent 协作规范

- 统一执行规范：`AGENTS.md`
- Agent 本地环境变量文件：`.env.agent`（本地创建，不入库）
- Agent 环境变量参考模板：`.env.agent.example`

约定：

- 任务完成后必须执行格式化与检测。
- 前端改动必须使用自动化工具回归关键交互。
- 后端改动必须通过直接请求验证接口行为。

## Worker 绑定与运行配置

关键配置位于 `apps/worker/wrangler.toml`：

- D1: `DB`
- KV（热点只读数据）: `KV_HOT`
- Static Assets: `ASSETS`（目录 `../ui/dist`）
- Durable Objects: `CHECKIN_SCHEDULER`
- Service Binding: `ATTEMPT_WORKER`（绑定到 `attempt-worker`）
- CORS 默认值：`*`（如需限制来源，可配置可选绑定 `CORS_ORIGIN`）

注意：

- 仓库中的 `database_id` / `KV namespace id` 使用占位值，避免提交个人账号资源 ID。
- GitHub Actions 部署流程会自动“检查/创建资源并回填真实 ID”后再部署，因此不影响他人一键初始化。

### 前端开发代理

`apps/ui/vite.config.ts` 默认将以下路径代理到 `VITE_API_TARGET`（默认 `http://localhost:8787`）：

- `/api`
- `/v1`

`apps/ui/src/core/constants.ts` 支持 `VITE_API_BASE`，用于覆盖前端请求基址（默认同源）。

## API 概览

### 健康检查

- `GET /health`

### 管理台 API（`/api/*`）

- 认证
- `POST /api/auth/login`
- `POST /api/auth/logout`

- 渠道（兼容接口）
- `GET /api/channels`
- `POST /api/channels`
- `PATCH /api/channels/:id`
- `DELETE /api/channels/:id`
- `POST /api/channels/:id/test`

- 站点（管理台主用）
- `GET /api/sites`
- `POST /api/sites`
- `PATCH /api/sites/:id`
- `DELETE /api/sites/:id`
- `POST /api/sites/checkin-all`
- `POST /api/sites/:id/checkin`

- 模型
- `GET /api/models`

- 令牌
- `GET /api/tokens`
- `POST /api/tokens`
- `PATCH /api/tokens/:id`
- `GET /api/tokens/:id/reveal`
- `DELETE /api/tokens/:id`

- 用量与看板
- `GET /api/usage`
- `GET /api/dashboard`

- 系统设置
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/settings/cache/refresh`

### New API 兼容（`/api/channel` / `/api/group` / `/api/user`）

- 渠道
- `GET /api/channel`
- `GET /api/channel/search`
- `GET /api/channel/:id`
- `POST /api/channel`
- `PUT /api/channel`
- `DELETE /api/channel/:id`
- `GET /api/channel/test/:id`
- `POST /api/channel/test`
- `GET /api/channel/fetch_models/:id`
- `POST /api/channel/fetch_models`
- `GET /api/channel/models`
- `GET /api/channel/models_enabled`
- `PUT /api/channel/tag`
- `POST /api/channel/tag/enabled`
- `POST /api/channel/tag/disabled`

- 分组与用户
- `GET /api/group`
- `GET /api/user/models`

### OpenAI 兼容代理

- `ALL /v1/*`
- `ALL /v1beta/*`

鉴权与细节请以 `apps/worker/src/middleware/*` 与对应 route 实现为准。

## 验收与排障建议

在提交前建议至少执行：

```bash
bun run typecheck
bun run check
bun run test
```

若本地接口异常，优先检查：

- Worker 是否运行（`bun run dev:worker`）
- UI 代理目标是否正确（`VITE_API_TARGET`）
- D1 本地迁移是否完成（`db:migrate`）

## 维护说明

- 文档以代码为准；若行为变更，请同步更新本 README。
- API 全量定义请参考 `apps/worker/src/routes`。
