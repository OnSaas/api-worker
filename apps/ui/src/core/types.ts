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
	created_at?: string | null;
	updated_at?: string | null;
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

export type RuntimeEvent = {
	id: string;
	level: "info" | "warning" | "error";
	code: string;
	message: string;
	request_id?: string | null;
	session_id?: string | null;
	request_path?: string | null;
	method?: string | null;
	channel_id?: string | null;
	token_id?: string | null;
	model?: string | null;
	context_json?: string | null;
	created_at: string;
};

export type RuntimeEventQuery = {
	levels: string[];
	codes: string[];
	request_id: string;
	session_id: string;
	path: string;
	from: string;
	to: string;
};

export type RuntimeEventResponse = {
	events: RuntimeEvent[];
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
	runtime_event_retention_days?: number;
	runtime_event_levels?: string[];
	session_ttl_hours: number;
	admin_password_set?: boolean;
	checkin_schedule_time?: string;
	model_failure_cooldown_minutes?: number;
	runtime_settings?: RuntimeProxySettings;
	runtime_config?: RuntimeProxyConfig;
	cache_config?: CacheConfig;
	usage_queue_status?: UsageQueueStatus | null;
};

export type RuntimeProxySettings = {
	upstream_timeout_ms: number;
	retry_max_retries: number;
	stream_usage_mode: string;
	stream_usage_max_bytes: number;
	stream_usage_max_parsers: number;
	usage_queue_enabled: boolean;
	usage_queue_daily_limit: number;
	usage_queue_direct_write_ratio: number;
};

export type RuntimeProxyConfig = RuntimeProxySettings & {
	usage_queue_bound: boolean;
	usage_queue_active: boolean;
};

export type CacheConfig = {
	enabled: boolean;
	dashboard_ttl_seconds: number;
	usage_ttl_seconds: number;
	models_ttl_seconds: number;
	tokens_ttl_seconds: number;
	channels_ttl_seconds: number;
	call_tokens_ttl_seconds: number;
	settings_ttl_seconds: number;
	version_dashboard: number;
	version_usage: number;
	version_models: number;
	version_tokens: number;
	version_channels: number;
	version_call_tokens: number;
	version_settings: number;
};

export type UsageQueueStatus = {
	count: number | null;
	date: string | null;
	limit: number;
	enabled: boolean;
	bound: boolean;
	active: boolean;
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
	runtime_events: RuntimeEvent[];
	dashboard: DashboardData | null;
	settings: Settings | null;
};

export type TabId =
	| "dashboard"
	| "channels"
	| "models"
	| "tokens"
	| "usage"
	| "runtime_events"
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
};

export type SettingsForm = {
	log_retention_days: string;
	runtime_event_retention_days: string;
	runtime_event_levels: string[];
	session_ttl_hours: string;
	admin_password: string;
	checkin_schedule_time: string;
	model_failure_cooldown_minutes: string;
	proxy_upstream_timeout_ms: string;
	proxy_retry_max_retries: string;
	proxy_stream_usage_mode: string;
	proxy_stream_usage_max_bytes: string;
	proxy_stream_usage_max_parsers: string;
	proxy_usage_queue_enabled: boolean;
	usage_queue_daily_limit: string;
	usage_queue_direct_write_ratio: string;
	cache_enabled: boolean;
	cache_ttl_dashboard_seconds: string;
	cache_ttl_usage_seconds: string;
	cache_ttl_models_seconds: string;
	cache_ttl_tokens_seconds: string;
	cache_ttl_channels_seconds: string;
	cache_ttl_call_tokens_seconds: string;
	cache_ttl_settings_seconds: string;
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

export type NoticeTone = "success" | "warning" | "error" | "info";

export type NoticeMessage = {
	tone: NoticeTone;
	message: string;
	id: number;
	durationMs?: number;
};
