# usage 模块

## 职责
- 记录代理调用日志
- 提供日志查询与筛选
- 执行日志保留策略

## 接口定义
- `GET /api/usage` 使用日志查询

## 行为规范
- 代理调用统一写入 `usage_logs`
- 保留天数可配置，查询时触发清理
- 查询结果附带渠道与令牌名称
- usage_logs 记录输入/输出 tokens、首 token 延迟、流式标记与推理强度
- 推理强度来自请求体 `reasoning` / `reasoning_effort` 字段
- usage_logs 记录上游失败详情（status/code/message），用于日志状态展示

## 依赖关系
- `usage_logs` 表
- `settings` 模块
