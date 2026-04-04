import type {
	AdminData,
	BackupSettings,
	DashboardQuery,
	SettingsForm,
	SiteForm,
	TabItem,
	TokenForm,
} from "./types";

export const apiBase = import.meta.env.VITE_API_BASE ?? "";

export const tabs: TabItem[] = [
	{ id: "dashboard", label: "数据面板" },
	{ id: "channels", label: "站点管理" },
	{ id: "models", label: "模型广场" },
	{ id: "tokens", label: "令牌管理" },
	{ id: "usage", label: "使用日志" },
	{ id: "settings", label: "系统设置" },
];

export const initialData: AdminData = {
	sites: [],
	tokens: [],
	models: [],
	usage: [],
	dashboard: null,
	settings: null,
};

export const initialSiteForm: SiteForm = {
	name: "",
	base_url: "",
	weight: 1,
	status: "active",
	site_type: "new-api",
	checkin_url: "",
	system_token: "",
	system_userid: "",
	checkin_enabled: false,
	call_tokens: [
		{
			name: "主调用令牌",
			api_key: "",
		},
	],
};

export const initialSettingsForm: SettingsForm = {
	log_retention_days: "30",
	session_ttl_hours: "12",
	admin_password: "",
	checkin_schedule_time: "00:10",
	channel_recovery_probe_enabled: false,
	channel_recovery_probe_schedule_time: "03:10",
	proxy_model_failure_cooldown_minutes: "720",
	proxy_model_failure_cooldown_threshold: "3",
	channel_disable_error_codes: [
		"do_request_failed",
		"proxy_upstream_fetch_exception",
		"model_not_found",
		"stream_options_unsupported",
	],
	channel_permanent_disable_error_codes: [
		"upstream_http_401",
		"upstream_http_403",
	],
	channel_disable_error_threshold: "3",
	channel_disable_error_code_minutes: "1440",
	proxy_upstream_timeout_ms: "180000",
	proxy_retry_max_retries: "5",
	proxy_retry_sleep_ms: "500",
	proxy_retry_sleep_error_codes: [
		"system_cpu_overloaded",
		"system_disk_overloaded",
	],
	proxy_retry_return_error_codes: [
		"no_available_channels",
		"upstream_cooldown",
		"responses_previous_response_id_required",
		"responses_affinity_missing",
		"responses_affinity_channel_disabled",
		"responses_affinity_channel_not_allowed",
		"responses_affinity_channel_model_unavailable",
		"responses_affinity_channel_cooldown",
		"responses_tool_call_chain_mismatch",
		"invalid_function_parameters",
	],
	proxy_zero_completion_as_error_enabled: true,
	proxy_stream_usage_mode: "lite",
	proxy_stream_usage_max_parsers: "0",
	proxy_stream_usage_parse_timeout_ms: "0",
	proxy_responses_affinity_ttl_seconds: "86400",
	proxy_stream_options_capability_ttl_seconds: "604800",
	proxy_attempt_worker_fallback_enabled: true,
	proxy_attempt_worker_fallback_threshold: "3",
	proxy_large_request_offload_threshold_bytes: "32768",
	site_task_concurrency: "4",
	site_task_timeout_ms: "12000",
	site_task_fallback_enabled: true,
};

export const initialBackupSettings: BackupSettings = {
	enabled: false,
	schedule_time: "04:20",
	sync_mode: "push",
	conflict_policy: "local_wins",
	import_mode: "merge",
	webdav_url: "",
	webdav_username: "",
	webdav_password: "",
	webdav_path: "api-worker-backup",
	keep_versions: 30,
	instance_id: "",
	last_sync_at: null,
	last_sync_status: "idle",
	last_sync_message: null,
	pending_changes: false,
	pending_at: null,
	config_ready: false,
};

export const initialDashboardQuery: DashboardQuery = {
	preset: "all",
	interval: "month",
	from: "",
	to: "",
	channel_ids: [],
	token_ids: [],
	model: "",
};

export const initialTokenForm: TokenForm = {
	name: "",
	quota_total: "",
	status: "active",
	expires_at: "",
	allowed_channels: [],
};
