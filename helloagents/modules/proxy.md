# proxy 模块

## 职责
- 提供 OpenAI / Anthropic / Gemini 多协议代理
- 支持下游协议与上游渠道类型分离并做请求转换
- 根据权重选择渠道并支持故障回退
- 记录用量日志并回写额度

## 接口定义
- `/v1/*` OpenAI 兼容代理路径
- `/v1/messages` Anthropic Messages 代理路径
- `/v1beta/*` Gemini 代理路径

## 行为规范
- 基于令牌鉴权
- 按渠道权重随机排序
- 调用令牌按顺序选择，未配置时回退 `channels.api_key`
- done-hub 仅使用 `base_url`，不再按多地址切换
- 支持从非流式 JSON、响应头与流式 SSE（含 `response.usage` 与 `usageMetadata`）解析 usage 字段
- 流式请求自动补 `stream_options.include_usage=true` 以便上游返回 usage
- 对 `/v1/responses` 且上游返回 400/404 时回退为 `/responses` 重试一次
- 可配置失败重试轮询（响应 5xx/429 时触发）
- 记录流式请求标记、首 token 延迟与推理强度到 usage_logs
- 上游类型由 `metadata_json.site_type` 决定（`openai/anthropic/gemini`，其他类型视为 openai 兼容）
- 允许 `metadata_json.model_mapping` 将下游模型映射为上游模型
- 允许 `metadata_json.endpoint_overrides` 覆盖 chat/embedding/image 上游地址（可用 `{model}` 占位）
- 允许 `metadata_json.header_override` 与 `metadata_json.query_override` 注入额外上游请求头/查询参数
- Anthropic 默认注入 `anthropic-version=2023-06-01`，可通过 `header_override` 覆盖
- 路由时优先使用模型能力表（TTL 内测试成功的模型），无能力记录时回退渠道声明模型列表

## 依赖关系
- `channels` / `tokens` / `usage_logs` 表
- `tokenAuth` 中间件
- `channel_model_capabilities` 表
