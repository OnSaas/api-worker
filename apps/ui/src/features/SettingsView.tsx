import { useEffect, useMemo, useState } from "hono/jsx/dom";
import {
	Button,
	Card,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	Input,
	MultiSelect,
	Switch,
} from "../components/ui";
import type {
	BackupImportMode,
	BackupSettings,
	RuntimeProxyConfig,
	SettingsForm,
} from "../core/types";

type SettingsViewProps = {
	settingsForm: SettingsForm;
	adminPasswordSet: boolean;
	isSaving: boolean;
	hasPendingSettingsChanges: boolean;
	runtimeConfig?: RuntimeProxyConfig | null;
	retryErrorCodeOptions: string[];
	backupSettings: BackupSettings;
	backupImportMode: BackupImportMode;
	backupImportFileName: string;
	isBackupExporting: boolean;
	isBackupImporting: boolean;
	isBackupPushing: boolean;
	isBackupPulling: boolean;
	onSubmit: (event: Event) => void;
	onFormChange: (patch: Partial<SettingsForm>) => void;
	onBackupSettingsChange: (patch: Partial<BackupSettings>) => void;
	onBackupExport: () => void;
	onBackupImportModeChange: (mode: BackupImportMode) => void;
	onBackupImportFileChange: (file: File | null) => void;
	onBackupImport: () => void;
	onBackupPushNow: () => void;
	onBackupPullNow: () => void;
	onApplyRecommendedConfig: () => void;
};

const streamUsageModes = [
	{
		value: "full",
		label: "FULL",
		hint: "成功流式必解析，失败流式也尽量补解析",
		cpu: "高开销",
		rules: [
			"成功流式会优先补做 SSE usage 解析。",
			"失败流式也会尝试补 usage，用于更完整归因。",
			"即使没解析出 usage，也只会记为告警，不会把 200 直接打成错误。",
		],
	},
	{
		value: "lite",
		label: "LITE",
		hint: "仅成功流式补解析，失败流式不深挖",
		cpu: "中开销",
		rules: [
			"仅在成功且流式响应时启用 SSE 解析。",
			"非流式优先使用 header/json 即时字段。",
			"失败流式不做深度解析，适合作为稳态默认值。",
		],
	},
	{
		value: "off",
		label: "OFF",
		hint: "只认头信息 / JSON，不跑 SSE 解析",
		cpu: "低开销",
		rules: [
			"不启动 SSE usage 解析任务。",
			"仅使用 header/json 即时字段。",
			"流式缺少 usage 时会落为黄色告警，适合优先控制 CPU 峰值。",
		],
	},
] as const;

const backupSyncModeOptions: {
	value: BackupSettings["sync_mode"];
	label: string;
}[] = [
	{ value: "push", label: "单向推送（本地 → WebDAV）" },
	{ value: "pull", label: "单向拉取（WebDAV → 本地）" },
	{ value: "two_way", label: "双向同步" },
];

const backupImportModeOptions: {
	value: BackupSettings["import_mode"];
	label: string;
}[] = [
	{ value: "merge", label: "merge（合并）" },
	{ value: "replace", label: "replace（覆盖）" },
];

const backupConflictPolicyOptions: {
	value: BackupSettings["conflict_policy"];
	label: string;
}[] = [
	{ value: "local_wins", label: "本地优先" },
	{ value: "remote_wins", label: "远端优先" },
];

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
	hasPendingSettingsChanges,
	runtimeConfig,
	retryErrorCodeOptions,
	backupSettings,
	backupImportMode,
	backupImportFileName,
	isBackupExporting,
	isBackupImporting,
	isBackupPushing,
	isBackupPulling,
	onSubmit,
	onFormChange,
	onBackupSettingsChange,
	onBackupExport,
	onBackupImportModeChange,
	onBackupImportFileChange,
	onBackupImport,
	onBackupPushNow,
	onBackupPullNow,
	onApplyRecommendedConfig,
}: SettingsViewProps) => {
	const [openBackupSelectKey, setOpenBackupSelectKey] = useState<string | null>(
		null,
	);
	const selectedStreamUsageMode =
		streamUsageModes.find(
			(mode) => mode.value === settingsForm.proxy_stream_usage_mode,
		) ?? streamUsageModes[1];
	const shouldShowDeepParseSettings = selectedStreamUsageMode.value !== "off";
	const attemptWorkerBoundValue =
		runtimeConfig === null || runtimeConfig === undefined
			? "-"
			: runtimeConfig.attempt_worker_transport === "local_http"
				? "本地 HTTP"
				: runtimeConfig.attempt_worker_transport === "binding"
					? "Service Binding"
					: "未启用";
	const attemptWorkerActiveValue =
		runtimeConfig === null || runtimeConfig === undefined
			? "-"
			: runtimeConfig.attempt_worker_fallback_active
				? "是"
				: "否";
	const siteTaskWorkerBoundValue =
		runtimeConfig === null || runtimeConfig === undefined
			? "-"
			: runtimeConfig.site_task_worker_transport === "local_http"
				? "本地 HTTP"
				: runtimeConfig.site_task_worker_transport === "binding"
					? "Service Binding"
					: "未启用";
	const siteTaskWorkerActiveValue =
		runtimeConfig === null || runtimeConfig === undefined
			? "-"
			: runtimeConfig.site_task_worker_fallback_active
				? "是"
				: "否";
	const mergedRetryErrorCodeOptions = useMemo(() => {
		const all = new Set<string>();
		for (const code of retryErrorCodeOptions) {
			const normalized = String(code ?? "").trim();
			if (normalized) {
				all.add(normalized);
			}
		}
		for (const code of settingsForm.proxy_retry_sleep_error_codes) {
			const normalized = String(code ?? "").trim();
			if (normalized) {
				all.add(normalized);
			}
		}
		for (const code of settingsForm.proxy_retry_return_error_codes) {
			const normalized = String(code ?? "").trim();
			if (normalized) {
				all.add(normalized);
			}
		}
		for (const code of settingsForm.channel_disable_error_codes) {
			const normalized = String(code ?? "").trim();
			if (normalized) {
				all.add(normalized);
			}
		}
		return Array.from(all)
			.sort((left, right) => left.localeCompare(right))
			.map((code) => ({ value: code, label: code }));
	}, [
		retryErrorCodeOptions,
		settingsForm.channel_disable_error_codes,
		settingsForm.proxy_retry_return_error_codes,
		settingsForm.proxy_retry_sleep_error_codes,
	]);
	const backupStatusLabel =
		backupSettings.last_sync_status === "success"
			? "最近同步成功"
			: backupSettings.last_sync_status === "failed"
				? "最近同步失败"
				: "尚未同步";
	const backupStatusClass =
		backupSettings.last_sync_status === "success"
			? "app-settings-backup-pill app-settings-backup-pill--success"
			: backupSettings.last_sync_status === "failed"
				? "app-settings-backup-pill app-settings-backup-pill--failed"
				: "app-settings-backup-pill";
	const backupSyncModeLabel =
		backupSyncModeOptions.find(
			(option) => option.value === backupSettings.sync_mode,
		)?.label ?? backupSyncModeOptions[0].label;
	const backupImportModeLabel =
		backupImportModeOptions.find(
			(option) => option.value === backupSettings.import_mode,
		)?.label ?? backupImportModeOptions[0].label;
	const backupConflictPolicyLabel =
		backupConflictPolicyOptions.find(
			(option) => option.value === backupSettings.conflict_policy,
		)?.label ?? backupConflictPolicyOptions[0].label;
	const manualImportModeLabel =
		backupImportModeOptions.find((option) => option.value === backupImportMode)
			?.label ?? backupImportModeOptions[0].label;
	const backupPendingLabel = backupSettings.pending_changes
		? "有待备份变更"
		: "本地与远端已同步";
	const backupPendingClass = backupSettings.pending_changes
		? "app-settings-backup-pill app-settings-backup-pill--warning"
		: "app-settings-backup-pill app-settings-backup-pill--success";
	const backupConfigLabel = backupSettings.config_ready
		? "WebDAV 已就绪"
		: "WebDAV 未配置完整";

	useEffect(() => {
		const handleDocumentClick = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (target?.closest(".app-settings-custom-select")) {
				return;
			}
			setOpenBackupSelectKey(null);
		};
		document.addEventListener("click", handleDocumentClick);
		return () => {
			document.removeEventListener("click", handleDocumentClick);
		};
	}, []);

	return (
		<div class="animate-fade-up space-y-4">
			<div class="flex items-center justify-between">
				<div>
					<h3 class="app-title text-lg">系统设置</h3>
					<p class="app-subtitle">管理全部运行参数</p>
				</div>
				<Button
					size="sm"
					type="button"
					variant="ghost"
					onClick={onApplyRecommendedConfig}
				>
					一键推荐配置
				</Button>
			</div>

			<form
				class="app-settings-panel app-settings-panel--sticky-footer"
				onSubmit={onSubmit}
			>
				<Card class="app-settings-group">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">基础运行</h4>
						<p class="app-settings-group__caption">会话与调度策略</p>
					</div>
					<div class="app-settings-list">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="retention">
									日志保留天数
								</label>
								<p class="app-settings-row__hint">按天自动清理历史记录</p>
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
								<label class="app-settings-row__label" for="session-ttl">
									会话时长（小时）
								</label>
								<p class="app-settings-row__hint">管理员登录有效时长</p>
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
								<p class="app-settings-row__hint">每天自动签到任务执行时间</p>
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
								<span class="app-settings-row__label">
									启用每日更新启用渠道
								</span>
								<p class="app-settings-row__hint">
									每天按设定时间更新启用渠道模型列表，并刷新渠道状态报告
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.channel_refresh_enabled}
									onToggle={(next) => {
										onFormChange({ channel_refresh_enabled: next });
									}}
								/>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="channel-refresh-schedule-time"
								>
									更新时间（中国时间）
								</label>
								<p class="app-settings-row__hint">
									每天自动执行“更新启用渠道”的时间
								</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="channel-refresh-schedule-time"
								name="channel_refresh_schedule_time"
								type="time"
								disabled={!settingsForm.channel_refresh_enabled}
								value={settingsForm.channel_refresh_schedule_time}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										channel_refresh_schedule_time: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">
									启用停用渠道自动恢复检查
								</span>
								<p class="app-settings-row__hint">
									每天按设定时间对已禁用站点执行统一验证，只有通过真实服务验证才自动恢复
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.channel_recovery_probe_enabled}
									onToggle={(next) => {
										onFormChange({ channel_recovery_probe_enabled: next });
									}}
								/>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="channel-recovery-probe-schedule-time"
								>
									自动检查时间（中国时间）
								</label>
								<p class="app-settings-row__hint">
									每天执行停用渠道自动恢复检查的时间
								</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="channel-recovery-probe-schedule-time"
								name="channel_recovery_probe_schedule_time"
								type="time"
								disabled={!settingsForm.channel_recovery_probe_enabled}
								value={settingsForm.channel_recovery_probe_schedule_time}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										channel_recovery_probe_schedule_time: target?.value ?? "",
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
										? "已设置，留空则不修改"
										: "未设置，保存后即为登录密码"}
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

				<Card class="app-settings-group app-settings-group--allow-overflow">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">代理请求</h4>
						<p class="app-settings-group__caption">上游调用与重试策略</p>
					</div>
					<div class="app-settings-list app-settings-list--allow-overflow">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-upstream-timeout"
								>
									上游超时（秒）
								</label>
								<p class="app-settings-row__hint">设置为 0 表示不限制超时</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-upstream-timeout"
								name="proxy_upstream_timeout_ms"
								type="number"
								min="0"
								value={
									settingsForm.proxy_upstream_timeout_ms
										? String(Number(settingsForm.proxy_upstream_timeout_ms) / 1000)
										: "0"
								}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									const secs = Number(target?.value ?? 0);
									onFormChange({
										proxy_upstream_timeout_ms: String(secs * 1000),
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
									0 表示不重发，默认 3 次（跨渠道重发）
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
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-retry-sleep-ms"
								>
									等待时间（秒）
								</label>
								<p class="app-settings-row__hint">错误后二次请求等待时间</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-retry-sleep-ms"
								name="proxy_retry_sleep_ms"
								type="number"
								min="0"
								step="0.1"
								value={
									settingsForm.proxy_retry_sleep_ms
										? String(Number(settingsForm.proxy_retry_sleep_ms) / 1000)
										: "0"
								}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									const secs = Number(target?.value ?? 0);
									onFormChange({
										proxy_retry_sleep_ms: String(Math.floor(secs * 1000)),
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">
									需要等待后重试的错误码
								</span>
								<p class="app-settings-row__hint">错误后重试需等待的列表</p>
							</div>
							<MultiSelect
								class="app-settings-row__control app-settings-row__control--full"
								options={mergedRetryErrorCodeOptions}
								value={settingsForm.proxy_retry_sleep_error_codes}
								placeholder="选择需要等待的错误码"
								searchPlaceholder="搜索错误码"
								emptyLabel="暂无可选错误码"
								onChange={(next) => {
									onFormChange({
										proxy_retry_sleep_error_codes: next,
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">
									不重试直接返回的错误码
								</span>
								<p class="app-settings-row__hint">
									命中后立即返回错误，不再继续本地重试
								</p>
							</div>
							<MultiSelect
								class="app-settings-row__control app-settings-row__control--full"
								options={mergedRetryErrorCodeOptions}
								value={settingsForm.proxy_retry_return_error_codes}
								placeholder="选择直接返回的错误码"
								searchPlaceholder="搜索错误码"
								emptyLabel="暂无可选错误码"
								onChange={(next) => {
									onFormChange({
										proxy_retry_return_error_codes: next,
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">触发禁用的错误码</span>
								<p class="app-settings-row__hint">
									命中这些错误码会累计渠道禁用次数；中间先进入渠道临时禁用，达到阈值后禁用渠道
								</p>
							</div>
							<MultiSelect
								class="app-settings-row__control app-settings-row__control--full"
								options={mergedRetryErrorCodeOptions}
								value={settingsForm.channel_disable_error_codes}
								placeholder="选择禁用的错误码"
								searchPlaceholder="搜索错误码"
								emptyLabel="暂无可选错误码"
								onChange={(next) => {
									onFormChange({
										channel_disable_error_codes: next,
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">无输出 视为失败</span>
								<p class="app-settings-row__hint">
									输出 Tokens 为 0 的结果会触发重试
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.proxy_zero_completion_as_error_enabled}
									onToggle={(next) => {
										onFormChange({
											proxy_zero_completion_as_error_enabled: next,
										});
									}}
								/>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-model-failure-cooldown"
								>
									模型冷却时长（分钟）
								</label>
								<p class="app-settings-row__hint">
									触发失败的模型；进入冷却后，该模型会在这段时间内被跳过
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-model-failure-cooldown"
								name="proxy_model_failure_cooldown_minutes"
								type="number"
								min="0"
								value={settingsForm.proxy_model_failure_cooldown_minutes}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_model_failure_cooldown_minutes: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-model-failure-threshold"
								>
									模型冷却阈值（连续失败次数）
								</label>
								<p class="app-settings-row__hint">
									同一渠道模型连续失败达到该次数后，渠道模型会被临时禁用
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-model-failure-threshold"
								name="proxy_model_failure_cooldown_threshold"
								type="number"
								min="1"
								step="1"
								value={settingsForm.proxy_model_failure_cooldown_threshold}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_model_failure_cooldown_threshold: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="channel-disable-error-threshold"
								>
									渠道禁用阈值（累计次数）
								</label>
								<p class="app-settings-row__hint">
									命中渠道禁用码会累计到这里；未达到阈值前先进入渠道临时禁用，达到阈值后禁用渠道
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="channel-disable-error-threshold"
								name="channel_disable_error_threshold"
								type="number"
								min="1"
								step="1"
								value={settingsForm.channel_disable_error_threshold}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										channel_disable_error_threshold: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="channel-disable-error-code-minutes"
								>
									渠道临时封禁时长（分钟）
								</label>
								<p class="app-settings-row__hint">
									每次命中渠道禁用码且未达到禁用阈值时，渠道会按这里的时长进入临时禁用
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="channel-disable-error-code-minutes"
								name="channel_disable_error_code_minutes"
								type="number"
								min="0"
								step="1"
								value={settingsForm.channel_disable_error_code_minutes}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										channel_disable_error_code_minutes: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-responses-affinity-ttl"
								>
									会话粘滞缓存时长（秒）
								</label>
								<p class="app-settings-row__hint">
									用于连续会话请求锁定同一渠道，最小 60 秒
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-responses-affinity-ttl"
								name="proxy_responses_affinity_ttl_seconds"
								type="number"
								min="60"
								step="1"
								value={settingsForm.proxy_responses_affinity_ttl_seconds}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_responses_affinity_ttl_seconds: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-stream-options-capability-ttl"
								>
									参数兼容缓存时长（秒）
								</label>
								<p class="app-settings-row__hint">
									用于缓存渠道对 stream_options 参数的兼容性，最小 60 秒
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-stream-options-capability-ttl"
								name="proxy_stream_options_capability_ttl_seconds"
								type="number"
								min="60"
								step="1"
								value={settingsForm.proxy_stream_options_capability_ttl_seconds}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_stream_options_capability_ttl_seconds:
											target?.value ?? "",
									});
								}}
							/>
						</div>
					</div>
				</Card>

				<Card class="app-settings-group app-settings-group--allow-overflow">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">调用执行器</h4>
						<p class="app-settings-group__caption">单次调用执行与异常回退</p>
					</div>
					<div class="app-settings-list app-settings-list--allow-overflow">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">
									启用调用执行器异常回退
								</span>
								<p class="app-settings-row__hint">
									当调用执行器出现异常时，按阈值切换为本地直连，提升请求稳定性
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.proxy_attempt_worker_fallback_enabled}
									onToggle={(next) => {
										onFormChange({
											proxy_attempt_worker_fallback_enabled: next,
										});
									}}
								/>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-attempt-worker-fallback-threshold"
								>
									异常阈值（次/请求）
								</label>
								<p class="app-settings-row__hint">
									单个请求内达到该异常次数后，后续执行会自动切为本地直连，最小 1
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-attempt-worker-fallback-threshold"
								name="proxy_attempt_worker_fallback_threshold"
								type="number"
								min="1"
								step="1"
								disabled={!settingsForm.proxy_attempt_worker_fallback_enabled}
								value={settingsForm.proxy_attempt_worker_fallback_threshold}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_attempt_worker_fallback_threshold:
											target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="proxy-large-request-offload-threshold"
								>
									大请求下沉阈值（字节）
								</label>
								<p class="app-settings-row__hint">
									达到该体积后才触发下沉；0 表示所有请求都下沉
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="proxy-large-request-offload-threshold"
								name="proxy_large_request_offload_threshold_bytes"
								type="number"
								min="0"
								step="1"
								value={settingsForm.proxy_large_request_offload_threshold_bytes}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({
										proxy_large_request_offload_threshold_bytes:
											target?.value ?? "",
									});
								}}
							/>
						</div>
					</div>
					<div class="app-settings-stats">
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">调用执行器绑定</div>
							<div class="app-settings-stat__value">
								{attemptWorkerBoundValue}
							</div>
						</div>
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">回退策略生效</div>
							<div class="app-settings-stat__value">
								{attemptWorkerActiveValue}
							</div>
						</div>
					</div>
				</Card>

				<Card class="app-settings-group app-settings-group--allow-overflow">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">站点任务</h4>
						<p class="app-settings-group__caption">
							配置站点验证、签到与恢复评估任务
						</p>
					</div>
					<div class="app-settings-list app-settings-list--allow-overflow">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="site-task-concurrency"
								>
									站点任务并发上限
								</label>
								<p class="app-settings-row__hint">
									控制批量签到、批量验证与恢复评估时的并发执行数量
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="site-task-concurrency"
								name="site_task_concurrency"
								type="number"
								min="1"
								step="1"
								value={settingsForm.site_task_concurrency}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onFormChange({ site_task_concurrency: target?.value ?? "" });
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="site-task-timeout">
									站点任务超时（秒）
								</label>
								<p class="app-settings-row__hint">
									单个站点任务允许执行的最长时间
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="site-task-timeout"
								name="site_task_timeout_ms"
								type="number"
								min="1"
								step="1"
								value={
									settingsForm.site_task_timeout_ms
										? String(Number(settingsForm.site_task_timeout_ms) / 1000)
										: "12"
								}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									const secs = Number(target?.value ?? 0);
									onFormChange({
										site_task_timeout_ms: String(Math.floor(secs * 1000)),
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">
									站点任务失败自动回退
								</span>
								<p class="app-settings-row__hint">
									任务执行异常时，自动切换到兼容处理流程
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={settingsForm.site_task_fallback_enabled}
									onToggle={(next) => {
										onFormChange({ site_task_fallback_enabled: next });
									}}
								/>
							</div>
						</div>
					</div>
					<div class="app-settings-stats">
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">站点任务绑定</div>
							<div class="app-settings-stat__value">
								{siteTaskWorkerBoundValue}
							</div>
						</div>
						<div class="app-settings-stat">
							<div class="app-settings-stat__label">站点回退策略生效</div>
							<div class="app-settings-stat__value">
								{siteTaskWorkerActiveValue}
							</div>
						</div>
					</div>
				</Card>

				<Card class="app-settings-group">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">流式 usage 解析策略</h4>
						<p class="app-settings-group__caption">
							先选策略，再配置该策略相关参数
						</p>
					</div>
					<div class="app-settings-list">
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">解析策略</span>
								<p class="app-settings-row__hint">
									FULL 风险最高但信息最全，OFF 开销最低
								</p>
							</div>
							<div
								class="app-segment app-settings-row__control app-settings-row__control--full"
								role="radiogroup"
								aria-label="流式 usage 解析策略"
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
											<small>CPU：{mode.cpu}</small>
										</button>
									);
								})}
							</div>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">当前策略生效规则</span>
								<p class="app-settings-row__hint">
									{selectedStreamUsageMode.label}：
									{selectedStreamUsageMode.hint}
								</p>
							</div>
							<div class="app-settings-row__control app-settings-row__control--full rounded-xl border border-[color:var(--app-border)]/70 bg-white/70 px-4 py-3 text-xs text-[color:var(--app-ink-muted)]">
								{selectedStreamUsageMode.rules.map((rule) => (
									<p key={rule}>{rule}</p>
								))}
							</div>
						</div>
						{shouldShowDeepParseSettings ? (
							<>
								<div class="app-settings-row">
									<div class="app-settings-row__main">
										<label
											class="app-settings-row__label"
											for="proxy-stream-usage-max-parsers"
										>
											流式解析并发上限
										</label>
										<p class="app-settings-row__hint">0 表示不限制</p>
									</div>
									<Input
										class="app-settings-row__control app-settings-row__control--compact"
										id="proxy-stream-usage-max-parsers"
										name="proxy_stream_usage_max_parsers"
										type="number"
										min="0"
										value={settingsForm.proxy_stream_usage_max_parsers}
										onInput={(event) => {
											const target =
												event.currentTarget as HTMLInputElement | null;
											onFormChange({
												proxy_stream_usage_max_parsers: target?.value ?? "",
											});
										}}
									/>
								</div>
								<div class="app-settings-row">
									<div class="app-settings-row__main">
										<label
											class="app-settings-row__label"
											for="proxy-stream-usage-parse-timeout"
										>
											流式解析超时（秒）
										</label>
										<p class="app-settings-row__hint">
											SSE usage 解析任务的超时时间，0 表示不限制
										</p>
									</div>
									<Input
										class="app-settings-row__control app-settings-row__control--compact"
										id="proxy-stream-usage-parse-timeout"
										name="proxy_stream_usage_parse_timeout_ms"
										type="number"
										min="0"
										step="1"
										value={
											settingsForm.proxy_stream_usage_parse_timeout_ms
												? String(
														Number(
															settingsForm.proxy_stream_usage_parse_timeout_ms,
														) / 1000,
													)
												: "0"
										}
										onInput={(event) => {
											const target =
												event.currentTarget as HTMLInputElement | null;
											const secs = Number(target?.value ?? 0);
											onFormChange({
												proxy_stream_usage_parse_timeout_ms: String(
													Math.floor(secs * 1000),
												),
											});
										}}
									/>
								</div>
							</>
						) : (
							<div class="app-settings-row app-settings-row--stack">
								<div class="app-settings-row__main">
									<span class="app-settings-row__label">当前策略参数</span>
									<p class="app-settings-row__hint">
										OFF 策略不使用流式深度解析参数，仅按头信息/JSON 获取 usage。
									</p>
								</div>
							</div>
						)}
					</div>
				</Card>

				<Card class="app-settings-group app-settings-group--allow-overflow">
					<div class="app-settings-group__header">
						<h4 class="app-settings-group__title">数据备份与同步</h4>
						<p class="app-settings-group__caption">
							全量导出（含敏感字段）与 WebDAV 上传/下载
						</p>
					</div>
					<p class="app-settings-row__hint">
						以下同步策略与 WebDAV
						配置仅保留在当前实例，不会随备份导出、导入或云端同步一起覆盖其他地方。
					</p>
					<div class="app-settings-backup-status-line">
						<span class={backupStatusClass}>{backupStatusLabel}</span>
						<span class={backupPendingClass}>{backupPendingLabel}</span>
						<span class="app-settings-backup-status-text">
							{backupSettings.last_sync_at
								? new Date(backupSettings.last_sync_at).toLocaleString(
										"zh-CN",
										{
											hour12: false,
										},
									)
								: "暂无同步时间"}
						</span>
					</div>
					<div class="app-settings-backup-quick-actions">
						<Button
							variant="default"
							size="lg"
							type="button"
							disabled={isBackupExporting}
							onClick={onBackupExport}
						>
							{isBackupExporting ? "导出中..." : "导出全量备份"}
						</Button>
						<Button
							variant="primary"
							size="lg"
							type="button"
							disabled={
								!backupSettings.config_ready ||
								isBackupPushing ||
								isBackupPulling
							}
							onClick={onBackupPushNow}
						>
							{isBackupPushing ? "上传中..." : "立即上传"}
						</Button>
						<Button
							variant="default"
							size="lg"
							type="button"
							disabled={
								!backupSettings.config_ready ||
								isBackupPushing ||
								isBackupPulling
							}
							onClick={onBackupPullNow}
						>
							{isBackupPulling ? "下载中..." : "立即下载"}
						</Button>
					</div>
					<div class="app-settings-list app-settings-list--allow-overflow">
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">启用定时备份</span>
								<p class="app-settings-row__hint">
									启用后每天按时间执行计划同步；本地配置变更会尝试自动上传
								</p>
							</div>
							<div class="app-settings-row__switch">
								<Switch
									checked={backupSettings.enabled}
									onToggle={(next) => {
										onBackupSettingsChange({ enabled: next });
									}}
								/>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="backup-schedule-time"
								>
									定时备份时间（中国时间）
								</label>
								<p class="app-settings-row__hint">格式 HH:mm</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="backup-schedule-time"
								name="backup_schedule_time"
								type="time"
								disabled={!backupSettings.enabled}
								value={backupSettings.schedule_time}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onBackupSettingsChange({
										schedule_time: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="backup-sync-mode">
									同步模式
								</label>
								<p class="app-settings-row__hint">可选单向/双向同步</p>
							</div>
							<div class="app-settings-row__control">
								<div class="app-settings-custom-select">
									<button
										aria-expanded={openBackupSelectKey === "sync_mode"}
										class="app-input app-focus app-settings-custom-select__trigger"
										id="backup-sync-mode"
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											setOpenBackupSelectKey((current) =>
												current === "sync_mode" ? null : "sync_mode",
											);
										}}
									>
										<span class="app-settings-custom-select__value">
											{backupSyncModeLabel}
										</span>
									</button>
									<DropdownMenu open={openBackupSelectKey === "sync_mode"}>
										<DropdownMenuContent class="app-settings-custom-select__menu">
											{backupSyncModeOptions.map((option) => (
												<DropdownMenuItem
													class={`app-settings-custom-select__option ${
														option.value === backupSettings.sync_mode
															? "app-dropdown-item--active"
															: ""
													}`}
													key={option.value}
													onClick={() => {
														onBackupSettingsChange({ sync_mode: option.value });
														setOpenBackupSelectKey(null);
													}}
												>
													<span>{option.label}</span>
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="backup-import-mode">
									导入模式
								</label>
								<p class="app-settings-row__hint">pull/导入时应用策略</p>
							</div>
							<div class="app-settings-row__control">
								<div class="app-settings-custom-select">
									<button
										aria-expanded={openBackupSelectKey === "import_mode"}
										class="app-input app-focus app-settings-custom-select__trigger"
										id="backup-import-mode"
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											setOpenBackupSelectKey((current) =>
												current === "import_mode" ? null : "import_mode",
											);
										}}
									>
										<span class="app-settings-custom-select__value">
											{backupImportModeLabel}
										</span>
									</button>
									<DropdownMenu open={openBackupSelectKey === "import_mode"}>
										<DropdownMenuContent class="app-settings-custom-select__menu">
											{backupImportModeOptions.map((option) => (
												<DropdownMenuItem
													class={`app-settings-custom-select__option ${
														option.value === backupSettings.import_mode
															? "app-dropdown-item--active"
															: ""
													}`}
													key={option.value}
													onClick={() => {
														onBackupSettingsChange({
															import_mode: option.value,
														});
														setOpenBackupSelectKey(null);
													}}
												>
													<span>{option.label}</span>
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="backup-conflict-policy"
								>
									双向冲突策略
								</label>
								<p class="app-settings-row__hint">仅 two_way 模式生效</p>
							</div>
							<div class="app-settings-row__control">
								<div class="app-settings-custom-select">
									<button
										aria-expanded={openBackupSelectKey === "conflict_policy"}
										class="app-input app-focus app-settings-custom-select__trigger"
										id="backup-conflict-policy"
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											setOpenBackupSelectKey((current) =>
												current === "conflict_policy"
													? null
													: "conflict_policy",
											);
										}}
									>
										<span class="app-settings-custom-select__value">
											{backupConflictPolicyLabel}
										</span>
									</button>
									<DropdownMenu
										open={openBackupSelectKey === "conflict_policy"}
									>
										<DropdownMenuContent class="app-settings-custom-select__menu">
											{backupConflictPolicyOptions.map((option) => (
												<DropdownMenuItem
													class={`app-settings-custom-select__option ${
														option.value === backupSettings.conflict_policy
															? "app-dropdown-item--active"
															: ""
													}`}
													key={option.value}
													onClick={() => {
														onBackupSettingsChange({
															conflict_policy: option.value,
														});
														setOpenBackupSelectKey(null);
													}}
												>
													<span>{option.label}</span>
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="backup-webdav-url">
									WebDAV 地址
								</label>
								<p class="app-settings-row__hint">
									例如 https://dav.example.com/dav/
								</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--full"
								id="backup-webdav-url"
								name="backup_webdav_url"
								type="url"
								value={backupSettings.webdav_url}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onBackupSettingsChange({ webdav_url: target?.value ?? "" });
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="backup-webdav-username"
								>
									WebDAV 用户名
								</label>
								<p class="app-settings-row__hint">Basic Auth 用户名</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="backup-webdav-username"
								name="backup_webdav_username"
								type="text"
								value={backupSettings.webdav_username}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onBackupSettingsChange({
										webdav_username: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="backup-webdav-password"
								>
									WebDAV 密码
								</label>
								<p class="app-settings-row__hint">将保存到服务端配置</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="backup-webdav-password"
								name="backup_webdav_password"
								type="text"
								value={backupSettings.webdav_password}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onBackupSettingsChange({
										webdav_password: target?.value ?? "",
									});
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label class="app-settings-row__label" for="backup-webdav-path">
									WebDAV 目录
								</label>
								<p class="app-settings-row__hint">
									会写入 latest.json 与 history/
								</p>
							</div>
							<Input
								class="app-settings-row__control"
								id="backup-webdav-path"
								name="backup_webdav_path"
								type="text"
								value={backupSettings.webdav_path}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onBackupSettingsChange({ webdav_path: target?.value ?? "" });
								}}
							/>
						</div>
						<div class="app-settings-row">
							<div class="app-settings-row__main">
								<label
									class="app-settings-row__label"
									for="backup-keep-versions"
								>
									历史保留数量
								</label>
								<p class="app-settings-row__hint">最多保留最近 N 份</p>
							</div>
							<Input
								class="app-settings-row__control app-settings-row__control--compact"
								id="backup-keep-versions"
								name="backup_keep_versions"
								type="number"
								min="1"
								step="1"
								value={String(backupSettings.keep_versions)}
								onInput={(event) => {
									const target = event.currentTarget as HTMLInputElement | null;
									onBackupSettingsChange({
										keep_versions: Number(target?.value ?? "30"),
									});
								}}
							/>
						</div>
						<div class="app-settings-row app-settings-row--stack app-settings-row--overlay">
							<div class="app-settings-import">
								<div class="app-settings-import__header">
									<span class="app-settings-row__label">导入备份文件</span>
									<p class="app-settings-row__hint">
										导入全量数据（包含敏感字段），点击下方“导入备份”执行
									</p>
								</div>
								<Input
									class="app-settings-import__file"
									name="backup_import_file"
									type="file"
									accept="application/json,.json"
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onBackupImportFileChange(target?.files?.[0] ?? null);
									}}
								/>
								<div class="app-settings-import__footer">
									<div class="app-settings-backup-file">
										当前文件：{backupImportFileName || "未选择"}
									</div>
									<div class="app-settings-import__controls">
										<div class="app-settings-import__mode">
											<div class="app-settings-custom-select">
												<button
													aria-expanded={
														openBackupSelectKey === "manual_import_mode"
													}
													class="app-input app-focus app-settings-custom-select__trigger"
													type="button"
													onClick={(event) => {
														event.stopPropagation();
														setOpenBackupSelectKey((current) =>
															current === "manual_import_mode"
																? null
																: "manual_import_mode",
														);
													}}
												>
													<span class="app-settings-custom-select__value">
														{manualImportModeLabel}
													</span>
												</button>
												<DropdownMenu
													open={openBackupSelectKey === "manual_import_mode"}
												>
													<DropdownMenuContent class="app-settings-custom-select__menu">
														{backupImportModeOptions.map((option) => (
															<DropdownMenuItem
																class={`app-settings-custom-select__option ${
																	option.value === backupImportMode
																		? "app-dropdown-item--active"
																		: ""
																}`}
																key={option.value}
																onClick={() => {
																	onBackupImportModeChange(
																		option.value as BackupImportMode,
																	);
																	setOpenBackupSelectKey(null);
																}}
															>
																<span>{option.label}</span>
															</DropdownMenuItem>
														))}
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										</div>
										<Button
											variant="default"
											size="lg"
											type="button"
											disabled={isBackupImporting}
											onClick={onBackupImport}
										>
											{isBackupImporting ? "导入中..." : "导入备份"}
										</Button>
									</div>
								</div>
							</div>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">备份配置状态</span>
								<p class="app-settings-row__hint">
									{backupConfigLabel}
									{backupSettings.pending_at
										? ` · 待备份时间 ${new Date(
												backupSettings.pending_at,
											).toLocaleString("zh-CN", { hour12: false })}`
										: ""}
								</p>
								{!backupSettings.config_ready ? (
									<p class="app-settings-row__hint">
										需填写 WebDAV
										地址、用户名和密码后，才能自动备份或手动上传/下载。
									</p>
								) : null}
							</div>
						</div>
						<div class="app-settings-row app-settings-row--stack">
							<div class="app-settings-row__main">
								<span class="app-settings-row__label">最近同步结果</span>
								<p class="app-settings-row__hint">
									状态：{backupSettings.last_sync_status} · 时间：
									{backupSettings.last_sync_at
										? new Date(backupSettings.last_sync_at).toLocaleString(
												"zh-CN",
												{ hour12: false },
											)
										: "-"}
								</p>
								<p class="app-settings-row__hint app-settings-row__hint--preline">
									信息：{backupSettings.last_sync_message ?? "-"}
								</p>
							</div>
						</div>
					</div>
				</Card>

				{hasPendingSettingsChanges ? (
					<div class="app-settings-footer">
						<Button
							variant="primary"
							size="lg"
							type="submit"
							disabled={isSaving}
						>
							{isSaving ? "保存中..." : "保存设置"}
						</Button>
					</div>
				) : null}
			</form>
		</div>
	);
};
