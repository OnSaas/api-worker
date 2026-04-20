export type SiteType =
	| "new-api"
	| "done-hub"
	| "subapi"
	| "openai"
	| "anthropic"
	| "gemini";

export type SiteCallToken = {
	id: string;
	name: string;
	api_key: string;
	priority?: number;
};

export type SiteCoolingModel = {
	model: string;
	last_err_at: number;
	last_err_code: string | null;
	last_err_count: number;
	cooldown_count: number;
	remaining_seconds: number;
};

export type Site = {
	id: string;
	name: string;
	base_url: string;
	weight: number;
	status: string;
	site_type: SiteType;
	api_key?: string;
	system_token?: string | null;
	system_userid?: string | null;
	checkin_enabled?: boolean;
	checkin_id?: string | null;
	checkin_url?: string | null;
	call_tokens: SiteCallToken[];
	last_checkin_date?: string | null;
	last_checkin_status?: string | null;
	last_checkin_message?: string | null;
	last_checkin_at?: string | null;
	verification?: SiteVerificationSummary | null;
	cooling_models?: SiteCoolingModel[];
	cooling_model_count?: number;
	cooling_max_remaining_seconds?: number;
	created_at?: string | null;
	updated_at?: string | null;
};

export type VerificationStageStatus = "pass" | "warn" | "fail" | "skip";

export type VerificationVerdict =
	| "serving"
	| "degraded"
	| "failed"
	| "recoverable"
	| "not_recoverable";

export type VerificationSuggestedAction =
	| "none"
	| "retry"
	| "fix_credentials"
	| "fix_endpoint"
	| "fix_model_config"
	| "manual_review";

export type VerificationStageResult = {
	status: VerificationStageStatus;
	code: string;
	message: string;
};

export type SiteVerificationSummary = {
	verdict: VerificationVerdict;
	message: string;
	checked_at: string;
	suggested_action: VerificationSuggestedAction;
	selected_model?: string | null;
	stage_codes?: Record<string, string>;
};

export type SiteVerificationResult = {
	site_id: string;
	site_name: string;
	mode: "service" | "recovery";
	verdict: VerificationVerdict;
	message: string;
	suggested_action: VerificationSuggestedAction;
	stages: {
		connectivity: VerificationStageResult;
		capability: VerificationStageResult;
		service: VerificationStageResult;
		recovery: VerificationStageResult;
	};
	selected_model: string | null;
	selected_token: {
		id?: string;
		name?: string;
	} | null;
	discovered_models: string[];
	token_summary: {
		total: number;
		success: number;
		failed: number;
	} | null;
	trace: {
		latency_ms?: number;
		upstream_status?: number;
		detail_code?: string;
		detail_message?: string;
	};
	checked_at: string;
};

export type SiteVerificationBatchSummary = {
	total: number;
	serving: number;
	degraded: number;
	failed: number;
	recoverable: number;
	not_recoverable: number;
	skipped: number;
};

export type SiteVerificationBatchReport = {
	summary: SiteVerificationBatchSummary;
	items: SiteVerificationResult[];
	runs_at: string;
};

export type SiteChannelRefreshItem = {
	site_id: string;
	site_name: string;
	status: "success" | "failed";
	message: string;
	models: string[];
};

export type SiteChannelRefreshBatchSummary = {
	total: number;
	success: number;
	failed: number;
};

export type SiteChannelRefreshBatchReport = {
	summary: SiteChannelRefreshBatchSummary;
	items: SiteChannelRefreshItem[];
	runs_at: string;
};

export type Token = {
	id: string;
	name: string;
	key_prefix: string;
	quota_total: number | null;
	quota_used: number;
	status: string;
	allowed_channels?: string[] | null;
	expires_at?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
};

export type UsageLog = {
	id: string;
	model: string | null;
	channel_id: string | null;
	channel_name?: string | null;
	token_id: string | null;
	token_name?: string | null;
	call_token_id?: string | null;
	call_token_name?: string | null;
	total_tokens: number | null;
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	latency_ms: number | null;
	first_token_latency_ms?: number | null;
	stream?: boolean | number | null;
	reasoning_effort?: string | number | null;
	status: string;
	upstream_status?: number | null;
	error_code?: string | null;
	error_message?: string | null;
	failure_stage?: string | null;
	failure_reason?: string | null;
	usage_source?: string | null;
	error_meta_json?: string | null;
	created_at: string;
};

export type UsageQuery = {
	channel_ids: string[];
	token_ids: string[];
	models: string[];
	statuses: string[];
	from: string;
	to: string;
};

export type UsageResponse = {
	logs: UsageLog[];
	total: number;
	limit: number;
	offset: number;
};

export type DashboardData = {
	summary: {
		total_requests: number;
		total_tokens: number;
		avg_latency: number;
		total_errors: number;
	};
	interval: "day" | "week" | "month";
	trend: Array<{ bucket: string; requests: number; tokens: number }>;
	byModel: Array<{ model: string; requests: number; tokens: number }>;
	byChannel: Array<{ channel_name: string; requests: number; tokens: number }>;
	byToken: Array<{ token_name: string; requests: number; tokens: number }>;
};

export type DashboardRangePreset =
	| "all"
	| "7d"
	| "30d"
	| "90d"
	| "1y"
	| "custom";

export type DashboardQuery = {
	preset: DashboardRangePreset;
	interval: "day" | "week" | "month";
	from: string;
	to: string;
	channel_ids: string[];
	token_ids: string[];
	model: string;
};

export type Settings = {
	log_retention_days: number;
	session_ttl_hours: number;
	admin_password_set?: boolean;
	checkin_schedule_time?: string;
	channel_refresh_enabled?: boolean;
	channel_refresh_schedule_time?: string;
	channel_recovery_probe_enabled?: boolean;
	channel_recovery_probe_schedule_time?: string;
	proxy_model_failure_cooldown_minutes?: number;
	proxy_model_failure_cooldown_threshold?: number;
	proxy_retry_return_error_codes?: string[];
	channel_disable_error_codes?: string[];
	channel_disable_error_threshold?: number;
	channel_disable_error_code_minutes?: number;
	runtime_settings?: RuntimeProxySettings;
	runtime_config?: RuntimeProxyConfig;
};

export type BackupSyncMode = "push" | "pull" | "two_way";

export type BackupConflictPolicy = "local_wins" | "remote_wins";

export type BackupImportMode = "merge" | "replace";

export type BackupManualAction = "push" | "pull";

export type BackupSettings = {
	enabled: boolean;
	schedule_time: string;
	sync_mode: BackupSyncMode;
	conflict_policy: BackupConflictPolicy;
	import_mode: BackupImportMode;
	webdav_url: string;
	webdav_username: string;
	webdav_password: string;
	webdav_path: string;
	keep_versions: number;
	instance_id: string;
	last_sync_at: string | null;
	last_sync_status: "success" | "failed" | "idle";
	last_sync_message: string | null;
	pending_changes: boolean;
	pending_at: string | null;
	config_ready: boolean;
};

export type BackupSyncResult = {
	ok: boolean;
	mode: BackupSyncMode;
	action: "push" | "pull" | "noop";
	synced_at: string;
	local_revision: number;
	remote_revision: number | null;
	message: string;
};

export type BackupImportResult = {
	summary: {
		settings: {
			created: number;
			updated: number;
			deleted: number;
		};
		sites: {
			created: number;
			updated: number;
			deleted: number;
			call_tokens_replaced: number;
		};
		tokens: {
			created: number;
			updated: number;
			deleted: number;
		};
	};
	mode: BackupImportMode;
	dry_run: boolean;
	warning?: string | null;
};

export type RuntimeProxySettings = {
	upstream_timeout_ms: number;
	retry_max_retries: number;
	retry_sleep_ms: number;
	retry_sleep_error_codes: string[];
	retry_return_error_codes: string[];
	channel_disable_error_codes: string[];
	channel_disable_error_threshold: number;
	channel_disable_error_code_minutes: number;
	zero_completion_as_error_enabled: boolean;
	model_failure_cooldown_minutes: number;
	model_failure_cooldown_threshold: number;
	stream_usage_mode: string;
	stream_usage_max_parsers: number;
	stream_usage_parse_timeout_ms: number;
	responses_affinity_ttl_seconds: number;
	stream_options_capability_ttl_seconds: number;
	attempt_worker_fallback_enabled: boolean;
	attempt_worker_fallback_threshold: number;
	large_request_offload_threshold_bytes: number;
	site_task_concurrency: number;
	site_task_timeout_ms: number;
	site_task_fallback_enabled: boolean;
};

export type RuntimeProxyConfig = RuntimeProxySettings & {
	attempt_worker_bound: boolean;
	attempt_worker_fallback_active: boolean;
	attempt_worker_transport: "none" | "local_http" | "binding";
	site_task_worker_bound: boolean;
	site_task_worker_fallback_active: boolean;
	site_task_worker_transport: "none" | "local_http" | "binding";
};

export type ModelChannel = {
	id: string;
	name: string;
};

export type ModelItem = {
	id: string;
	channels: ModelChannel[];
};

export type AdminData = {
	sites: Site[];
	tokens: Token[];
	models: ModelItem[];
	usage: UsageLog[];
	dashboard: DashboardData | null;
	settings: Settings | null;
};

export type TabId =
	| "dashboard"
	| "channels"
	| "models"
	| "tokens"
	| "usage"
	| "settings";

export type TabItem = {
	id: TabId;
	label: string;
};

export type SiteForm = {
	name: string;
	base_url: string;
	weight: number;
	status: string;
	site_type: SiteType;
	checkin_url: string;
	system_token: string;
	system_userid: string;
	checkin_enabled: boolean;
	call_tokens: SiteCallTokenForm[];
};

export type SiteCallTokenForm = {
	id?: string;
	name: string;
	api_key: string;
	priority?: number;
};

export type SettingsForm = {
	log_retention_days: string;
	session_ttl_hours: string;
	admin_password: string;
	checkin_schedule_time: string;
	channel_refresh_enabled: boolean;
	channel_refresh_schedule_time: string;
	channel_recovery_probe_enabled: boolean;
	channel_recovery_probe_schedule_time: string;
	proxy_model_failure_cooldown_minutes: string;
	proxy_model_failure_cooldown_threshold: string;
	channel_disable_error_threshold: string;
	channel_disable_error_code_minutes: string;
	proxy_upstream_timeout_ms: string;
	proxy_retry_max_retries: string;
	proxy_retry_sleep_ms: string;
	proxy_retry_sleep_error_codes: string[];
	proxy_retry_return_error_codes: string[];
	proxy_zero_completion_as_error_enabled: boolean;
	channel_disable_error_codes: string[];
	proxy_stream_usage_mode: string;
	proxy_stream_usage_max_parsers: string;
	proxy_stream_usage_parse_timeout_ms: string;
	proxy_responses_affinity_ttl_seconds: string;
	proxy_stream_options_capability_ttl_seconds: string;
	proxy_attempt_worker_fallback_enabled: boolean;
	proxy_attempt_worker_fallback_threshold: string;
	proxy_large_request_offload_threshold_bytes: string;
	site_task_concurrency: string;
	site_task_timeout_ms: string;
	site_task_fallback_enabled: boolean;
};

export type TokenForm = {
	name: string;
	quota_total: string;
	status: string;
	expires_at: string;
	allowed_channels: string[];
};

export type CheckinResultItem = {
	id: string;
	name: string;
	status: "success" | "failed" | "skipped";
	message: string;
	checkin_date?: string | null;
};

export type CheckinSummary = {
	total: number;
	success: number;
	failed: number;
	skipped: number;
};

export type SiteTaskKind =
	| "checkin"
	| "verify-active"
	| "verify-disabled"
	| "refresh-active";

export type SiteTaskResultState =
	| {
			kind: "checkin";
			runs_at: string;
			summary: CheckinSummary;
			items: CheckinResultItem[];
	  }
	| {
			kind: "verify-active" | "verify-disabled";
			runs_at: string;
			report: SiteVerificationBatchReport;
	  }
	| {
			kind: "refresh-active";
			runs_at: string;
			report: SiteChannelRefreshBatchReport;
	  };

export type SiteTaskReportMap = Partial<
	Record<SiteTaskKind, SiteTaskResultState>
>;

export type NoticeTone = "success" | "warning" | "error" | "info";

export type NoticeMessage = {
	tone: NoticeTone;
	message: string;
	id: number;
	durationMs?: number;
};
