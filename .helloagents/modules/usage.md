# usage 模块

## 职责
- 记录代理调用日志
- 提供日志查询与筛选
- 执行日志保留策略

## 接口定义
- `GET /api/usage` 使用日志查询

## 行为规范
- 代理调用统一写入 `usage_logs`（含无可用渠道/冷却提前返回）
- 使用日志可通过 `USAGE_QUEUE` 异步写入（可能存在短暂延迟）
- 队列写入受 `usage_queue_daily_limit` 限制，超限后自动回退为 Worker 直写
- 流式 usage 解析被跳过、超时或缺失时会记录 `usage_skipped/usage_missing` 以便排查
- 客户端在最终回包前断开时会记录 `client_disconnected`，用于区分“上游成功”与“客户端真正收到”
- 保留天数可配置，查询时触发清理
- `GET /api/usage` 支持短时缓存（TTL 可配置，版本化失效）
- 查询结果附带渠道与令牌名称
- `GET /api/usage` 支持 `offset/limit` 分页并返回 `total`
- 支持按 `model/channel/token/status` 关键词搜索（保留 `channel_id/token_id` 精确过滤，新增 `channel_ids`/`token_ids`/`models`/`statuses` 多选过滤）
- usage_logs 记录输入/输出 tokens、首 token 延迟、流式标记与推理强度
- 非流式 `200` 若缺失 usage，不再默认等价为真实 `0 token` 成功
- 推理强度来自请求体 `reasoning` / `reasoning_effort` 字段
- usage_logs 记录上游失败详情（status/code/message），日志列表仅展示上游状态码，缺失时显示“未知”，详情弹窗包含元信息与错误摘要

## 依赖关系
- `usage_logs` 表
- `settings` 模块
