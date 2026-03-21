import { Button, Card, Input, Switch } from "../components/ui";
import type {
	CacheConfig,
	RuntimeProxyConfig,
	SettingsForm,
	UsageQueueStatus,
} from "../core/types";

type SettingsViewProps = {
	settingsForm: SettingsForm;
	adminPasswordSet: boolean;
	isSaving: boolean;
	cacheConfig?: CacheConfig | null;
	isRefreshingCache?: boolean;
	runtimeConfig?: RuntimeProxyConfig | null;
	usageQueueStatus?: UsageQueueStatus | null;
	onSubmit: (event: Event) => void;
	onFormChange: (patch: Partial<SettingsForm>) => void;
	onRefreshCache: () => void;
};

const streamUsageModes = [
	{ value: "full", label: "完整", hint: "全量解析" },
	{ value: "lite", label: "轻量", hint: "降低开销" },
	{ value: "off", label: "关闭", hint: "仅记录基础" },
] as const;

const runtimeEventLevelOptions = [
	{ value: "info", label: "Info" },
	{ value: "warning", label: "Warning" },
	{ value: "error", label: "Error" },
] as const;

/**
 * Renders the settings view.
 *
 * Args:
 *   props: Settings view props.
 *
 * Returns:
 *   Settings JSX element.
 */
export const SettingsView = ({
	settingsForm,
	adminPasswordSet,
	isSaving,
	cacheConfig,
	isRefreshingCache,
	runtimeConfig,
	usageQueueStatus,
	onSubmit,
	onFormChange,
	onRefreshCache,
}: SettingsViewProps) => {
	const queueBoundValue =
		runtimeConfig === null || runtimeConfig === undefined
			? "-"
			: runtimeConfig.usage_queue_bound
				? "已绑定"
				: "未绑定";
	const queueActiveValue =
		runtimeConfig === null || runtimeConfig === undefined
			? "-"
			: runtimeConfig.usage_queue_active
				? "是"
				: "否";
	const queueUsageValue = usageQueueStatus
		? usageQueueStatus.count === null
			? "未绑定"
			: usageQueueStatus.limit > 0
				? `${usageQueueStatus.count} / ${usageQueueStatus.limit}`
				: String(usageQueueStatus.count)
		: "-";

	const cacheItems = [
		{
			key: "cache_ttl_dashboard_seconds",
			id: "cache-dashboard-ttl",
			title: "面板缓存",
			hint: "0 表示关闭该接口缓存。",
			version: cacheConfig?.version_dashboard ?? "-",
		},
		{
			key: "cache_ttl_usage_seconds",
			id: "cache-usage-ttl",
			title: "日志缓存",
			hint: "日志查询建议设置较短 TTL。",
			version: cacheConfig?.version_usage ?? "-",
		},
		{
			key: "cache_ttl_models_seconds",
			id: "cache-models-ttl",
			title: "模型缓存",
			hint: "",
			version: cacheConfig?.version_models ?? "-",
		},
		{
			key: "cache_ttl_tokens_seconds",
			id: "cache-tokens-ttl",
			title: "Token 鉴权缓存",
			hint: "禁用令牌会自动失效，不影响即时生效。",
			version: cacheConfig?.version_tokens ?? "-",
		},
		{
			key: "cache_ttl_channels_seconds",
			id: "cache-channels-ttl",
			title: "渠道缓存",
			hint: "",
			version: cacheConfig?.version_channels ?? "-",
		},
		{
			key: "cache_ttl_call_tokens_seconds",
			id: "cache-call-tokens-ttl",
			title: "调用令牌缓存",
			hint: "",
			version: cacheConfig?.version_call_tokens ?? "-",
		},
		{
			key: "cache_ttl_settings_seconds",
			id: "cache-settings-ttl",
			title: "设置缓存",
			hint: "",
			version: cacheConfig?.version_settings ?? "-",
		},
	] as const;

	return (
		<div class="animate-fade-up space-y-4">
			<div class="flex items-center justify-between">
				<div>
					<h3 class="app-title text-lg">系统设置</h3>
					<p class="app-subtitle">管理全部运行参数。</p>
				</div>
			</div>

			<form class="app-settings-panel" onSubmit={onSubmit}>
				<Card class="app-settings-group">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">基础设置</h4>
						<p class="app-settings-group__caption">账号与基础策略</p>
					</div>
					<div class="app-settings-list">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="retention">
									日志保留天数
								</label>
								<p class="app-settings-row__hint">按天自动清理历史记录。</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="retention"
								name="log_retention_days"
								type="number"
								min="1"
								value={settingsForm.log_retention_days}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({ log_retention_days: target?.value ?? "" });
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="runtime-event-retention"
								>
									系统日志保留天数
								</label>
								<p class="app-settings-row__hint">
									用于系统日志模块，按天自动清理。
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="runtime-event-retention"
								name="runtime_event_retention_days"
								type="number"
								min="1"
								value={settingsForm.runtime_event_retention_days}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										runtime_event_retention_days: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">系统日志写入等级</span>
								<p class="app-settings-row__hint">
									可不选；不选表示完全关闭系统日志写入。
								</p>
							</div>
							<div class="app-segment app-settings-row__control app-settings-row__control--full">
								{runtimeEventLevelOptions.map((option) => {
									const active = settingsForm.runtime_event_levels.includes(
										option.value,
									);
									return (
										<button
											aria-pressed={active}
											class={`app-segment__button ${
												active ? "app-segment__button--active" : ""
											}`}
											key={option.value}
											type="button"
											onClick={() => {
												const next = active
													? settingsForm.runtime_event_levels.filter(
															(level) => level !== option.value,
														)
													: [
															...settingsForm.runtime_event_levels,
															option.value,
														];
												onFormChange({ runtime_event_levels: next });
											}}
										>
											<span>{option.label}</span>
										</button>
									);
								})}
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="session-ttl">
									会话时长（小时）
								</label>
								<p class="app-settings-row__hint">管理员登录有效时长。</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="session-ttl"
								name="session_ttl_hours"
								type="number"
								min="1"
								value={settingsForm.session_ttl_hours}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({ session_ttl_hours: target?.value ?? "" });
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="checkin-schedule-time"
								>
									签到时间（中国时间）
								</label>
								<p class="app-settings-row__hint">每天自动签到任务执行时间。</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="checkin-schedule-time"
								name="checkin_schedule_time"
								type="time"
								value={settingsForm.checkin_schedule_time}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({ checkin_schedule_time: target?.value ?? "" });
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="failure-cooldown">
									失败冷却（分钟）
								</label>
								<p class="app-settings-row__hint">
									同一模型失败后在该时间内跳过对应渠道。
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="failure-cooldown"
								name="model_failure_cooldown_minutes"
								type="number"
								min="1"
								value={settingsForm.model_failure_cooldown_minutes}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										model_failure_cooldown_minutes: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="admin-password">
									管理员密码
								</label>
								<p class="app-settings-row__hint">
									{adminPasswordSet
										? "已设置，留空则不修改。"
										: "未设置，保存后即为登录密码。"}
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--full"
								id="admin-password"
								name="admin_password"
								type="password"
								placeholder={
									adminPasswordSet ? "输入新密码以覆盖" : "输入管理员密码"
								}
								value={settingsForm.admin_password}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({ admin_password: target?.value ?? "" });
								}}
							/>
						</div>
					</div>
				</Card>

				<Card class="app-settings-group">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">解析与请求</h4>
						<p class="app-settings-group__caption">代理调用链路与流式策略</p>
					</div>
					<div class="app-settings-list">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-upstream-timeout"
								>
									上游超时（毫秒）
								</label>
								<p class="app-settings-row__hint">设置为 0 表示不限制超时。</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-upstream-timeout"
								name="proxy_upstream_timeout_ms"
								type="number"
								min="0"
								value={settingsForm.proxy_upstream_timeout_ms}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_upstream_timeout_ms: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="proxy-retry-max">
									重发次数
								</label>
								<p class="app-settings-row__hint">
									0 表示不重发，默认 3 次（跨渠道重发）。
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-retry-max"
								name="proxy_retry_max_retries"
								type="number"
								min="0"
								step="1"
								value={settingsForm.proxy_retry_max_retries}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_retry_max_retries: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">流式 usage 解析模式</span>
								<p class="app-settings-row__hint">
									选择完整解析、轻量解析或关闭解析。
								</p>
							</div>
							<div
								class="app-segment app-settings-row__control app-settings-row__control--full"
								role="radiogroup"
								aria-label="流式 usage 解析模式"
							>
								{streamUsageModes.map((mode) => {
									const active =
										settingsForm.proxy_stream_usage_mode === mode.value;
									return (
										<button
											aria-pressed={active}
											class={`app-segment__button ${
												active ? "app-segment__button--active" : ""
											}`}
											key={mode.value}
											type="button"
											onClick={() =>
												onFormChange({
													proxy_stream_usage_mode: mode.value,
												})
											}
										>
											<span>{mode.label}</span>
											<small>{mode.hint}</small>
										</button>
									);
								})}
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-stream-usage-max-bytes"
								>
									流式解析最大字节
								</label>
								<p class="app-settings-row__hint">0 表示不限制。</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-stream-usage-max-bytes"
								name="proxy_stream_usage_max_bytes"
								type="number"
								min="0"
								value={settingsForm.proxy_stream_usage_max_bytes}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_stream_usage_max_bytes: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-stream-usage-max-parsers"
								>
									流式解析并发上限
								</label>
								<p class="app-settings-row__hint">0 表示不限制。</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-stream-usage-max-parsers"
								name="proxy_stream_usage_max_parsers"
								type="number"
								min="0"
								value={settingsForm.proxy_stream_usage_max_parsers}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_stream_usage_max_parsers: target?.value ?? "",
									});
								}}
							/>
						</div>
					</div>
				</Card>

				<Card class="app-settings-group">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">队列设置</h4>
						<p class="app-settings-group__caption">日志写入队列策略与状态</p>
					</div>
					<div class="app-settings-list">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">启用用量队列</span>
								<p class="app-settings-row__hint">
									启用后将按比例把 usage 写入队列。
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.proxy_usage_queue_enabled}
									onToggle={(next) => {
										onFormChange({ proxy_usage_queue_enabled: next });
									}}
								/>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="usage-queue-daily-limit"
								>
									队列日限额
								</label>
								<p class="app-settings-row__hint">
									达到上限后自动切回 Worker 直写。
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="usage-queue-daily-limit"
								name="usage_queue_daily_limit"
								type="number"
								min="0"
								value={settingsForm.usage_queue_daily_limit}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										usage_queue_daily_limit: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="usage-queue-direct-ratio"
								>
									直写比例（0-1）
								</label>
								<p class="app-settings-row__hint">示例：0.5 表示 50% 直写。</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="usage-queue-direct-ratio"
								name="usage_queue_direct_write_ratio"
								type="number"
								min="0"
								max="1"
								step="0.01"
								value={settingsForm.usage_queue_direct_write_ratio}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										usage_queue_direct_write_ratio: target?.value ?? "",
									});
								}}
							/>
						</div>
					</div>
					<div class="app-settings-stats">
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">队列绑定</div>
							<div class="app-settings-stat__value">{queueBoundValue}</div>
						</div>
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">队列实际生效</div>
							<div class="app-settings-stat__value">{queueActiveValue}</div>
						</div>
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">队列使用数量</div>
							<div class="app-settings-stat__value">{queueUsageValue}</div>
							<div class="app-settings-stat__hint">
								{usageQueueStatus?.date
									? `统计日期：${usageQueueStatus.date}`
									: "统计日期：-"}
							</div>
						</div>
					</div>
				</Card>

				<Card class="app-settings-group">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">缓存设置</h4>
						<p class="app-settings-group__caption">控制各接口缓存策略与版本</p>
					</div>
					<div class="app-settings-list">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">启用缓存（总开关）</span>
								<p class="app-settings-row__hint">
									影响面板、日志、模型、鉴权、渠道、调用令牌与设置缓存。
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.cache_enabled}
									onToggle={(next) => {
										onFormChange({ cache_enabled: next });
									}}
								/>
							</div>
						</div>
					</div>
					<div class="app-settings-cache-grid">
						{cacheItems.map((item) => (
							<div class="app-settings-cache-card" key={item.id}>
								<div class="app-settings-cache-card__title">{item.title}</div>
								<label class="app-settings-cache-card__label" for={item.id}>
									TTL（秒）
								</label>
								<Input
									id={item.id}
									name={item.key}
									type="number"
									min="0"
									value={settingsForm[item.key]}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											[item.key]: target?.value ?? "",
										} as Partial<SettingsForm>);
									}}
								/>
								{item.hint ? (
									<p class="app-settings-cache-card__hint">{item.hint}</p>
								) : (
									<div class="h-[18px]" />
								)}
								<div class="app-settings-cache-card__version">
									版本：{item.version}
								</div>
							</div>
						))}
					</div>
				</Card>

				<div class="app-settings-footer">
					<Button
						variant="ghost"
						size="sm"
						type="button"
						disabled={isRefreshingCache}
						onClick={onRefreshCache}
					>
						{isRefreshingCache ? "刷新中..." : "刷新缓存"}
					</Button>
					<Button variant="primary" size="lg" type="submit" disabled={isSaving}>
						{isSaving ? "保存中..." : "保存设置"}
					</Button>
				</div>
			</form>
		</div>
	);
};
