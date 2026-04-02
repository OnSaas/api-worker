import type { D1Database } from "@cloudflare/workers-types";
import type { Bindings } from "../env";
import { nowIso, parseScheduleTime } from "../utils/time";

const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_SESSION_TTL_HOURS = 12;
const DEFAULT_CHECKIN_SCHEDULE_TIME = "00:10";
const DEFAULT_CHANNEL_RECOVERY_PROBE_ENABLED = false;
const DEFAULT_CHANNEL_RECOVERY_PROBE_SCHEDULE_TIME = "03:10";
const DEFAULT_MODEL_FAILURE_COOLDOWN_MINUTES = 720;
const DEFAULT_MODEL_FAILURE_COOLDOWN_THRESHOLD = 3;
const DEFAULT_CHANNEL_DISABLE_ERROR_CODES = [
	"upstream_http_401",
	"upstream_http_403",
	"do_request_failed",
	"proxy_upstream_fetch_exception",
];
const DEFAULT_CHANNEL_DISABLE_ERROR_THRESHOLD = 3;
const DEFAULT_CHANNEL_DISABLE_ERROR_CODE_MINUTES = 1440;
const DEFAULT_PROXY_STREAM_USAGE_MODE = "full";
const DEFAULT_PROXY_STREAM_USAGE_MAX_PARSERS = 0;
const DEFAULT_PROXY_STREAM_USAGE_PARSE_TIMEOUT_MS = 0;
const DEFAULT_PROXY_RESPONSES_AFFINITY_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_PROXY_STREAM_OPTIONS_CAPABILITY_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PROXY_UPSTREAM_TIMEOUT_MS = 180000;
const DEFAULT_PROXY_RETRY_MAX_RETRIES = 5;
const DEFAULT_PROXY_RETRY_SLEEP_MS = 500;
const DEFAULT_PROXY_RETRY_SLEEP_ERROR_CODES = [
	"system_cpu_overloaded",
	"system_disk_overloaded",
];
const DEFAULT_PROXY_ZERO_COMPLETION_AS_ERROR_ENABLED = true;
const DEFAULT_PROXY_ATTEMPT_WORKER_FALLBACK_ENABLED = true;
const DEFAULT_PROXY_ATTEMPT_WORKER_FALLBACK_THRESHOLD = 3;
const DEFAULT_PROXY_LARGE_REQUEST_OFFLOAD_THRESHOLD_BYTES = 32768;
const DEFAULT_ATTEMPT_LOG_ENABLED = true;
const DEFAULT_ATTEMPT_LOG_RETENTION_DAYS = 30;
const DEFAULT_BACKUP_ENABLED = false;
const DEFAULT_BACKUP_SCHEDULE_TIME = "04:20";
const DEFAULT_BACKUP_SYNC_MODE = "push";
const DEFAULT_BACKUP_CONFLICT_POLICY = "local_wins";
const DEFAULT_BACKUP_IMPORT_MODE = "merge";
const DEFAULT_BACKUP_WEBDAV_URL = "";
const DEFAULT_BACKUP_WEBDAV_USERNAME = "";
const DEFAULT_BACKUP_WEBDAV_PASSWORD = "";
const DEFAULT_BACKUP_WEBDAV_PATH = "api-worker-backup";
const DEFAULT_BACKUP_KEEP_VERSIONS = 30;
const SETTING_SNAPSHOT_TTL_MS = 1000;
const RUNTIME_SETTING_SNAPSHOT_TTL_MS = 5000;
const BACKUP_SETTING_SNAPSHOT_TTL_MS = 5000;

const RETENTION_KEY = "log_retention_days";
const SESSION_TTL_KEY = "session_ttl_hours";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";
const CHECKIN_SCHEDULE_TIME_KEY = "checkin_schedule_time";
const CHANNEL_RECOVERY_PROBE_ENABLED_KEY = "channel_recovery_probe_enabled";
const CHANNEL_RECOVERY_PROBE_SCHEDULE_TIME_KEY =
	"channel_recovery_probe_schedule_time";
const MODEL_FAILURE_COOLDOWN_KEY = "model_failure_cooldown_minutes";
const MODEL_FAILURE_COOLDOWN_THRESHOLD_KEY = "model_failure_cooldown_threshold";
const PROXY_UPSTREAM_TIMEOUT_KEY = "proxy_upstream_timeout_ms";
const PROXY_RETRY_MAX_RETRIES_KEY = "proxy_retry_max_retries";
const PROXY_RETRY_SLEEP_MS_KEY = "proxy_retry_sleep_ms";
const PROXY_RETRY_SLEEP_ERROR_CODES_KEY = "proxy_retry_sleep_error_codes";
const CHANNEL_DISABLE_ERROR_CODES_KEY = "channel_disable_error_codes";
const CHANNEL_DISABLE_ERROR_THRESHOLD_KEY = "channel_disable_error_threshold";
const CHANNEL_DISABLE_ERROR_CODE_MINUTES_KEY =
	"channel_disable_error_code_minutes";
const PROXY_ZERO_COMPLETION_AS_ERROR_KEY =
	"proxy_zero_completion_as_error_enabled";
const PROXY_STREAM_USAGE_MODE_KEY = "proxy_stream_usage_mode";
const PROXY_STREAM_USAGE_MAX_PARSERS_KEY = "proxy_stream_usage_max_parsers";
const PROXY_STREAM_USAGE_PARSE_TIMEOUT_KEY =
	"proxy_stream_usage_parse_timeout_ms";
const PROXY_RESPONSES_AFFINITY_TTL_KEY = "proxy_responses_affinity_ttl_seconds";
const PROXY_STREAM_OPTIONS_CAPABILITY_TTL_KEY =
	"proxy_stream_options_capability_ttl_seconds";
const PROXY_ATTEMPT_WORKER_FALLBACK_ENABLED_KEY =
	"proxy_attempt_worker_fallback_enabled";
const PROXY_ATTEMPT_WORKER_FALLBACK_THRESHOLD_KEY =
	"proxy_attempt_worker_fallback_threshold";
const PROXY_LARGE_REQUEST_OFFLOAD_THRESHOLD_BYTES_KEY =
	"proxy_large_request_offload_threshold_bytes";
const ATTEMPT_LOG_ENABLED_KEY = "attempt_log_enabled";
const ATTEMPT_LOG_RETENTION_DAYS_KEY = "attempt_log_retention_days";
const BACKUP_ENABLED_KEY = "backup_enabled";
const BACKUP_SCHEDULE_TIME_KEY = "backup_schedule_time";
const BACKUP_SYNC_MODE_KEY = "backup_sync_mode";
const BACKUP_CONFLICT_POLICY_KEY = "backup_conflict_policy";
const BACKUP_IMPORT_MODE_KEY = "backup_import_mode";
const BACKUP_WEBDAV_URL_KEY = "backup_webdav_url";
const BACKUP_WEBDAV_USERNAME_KEY = "backup_webdav_username";
const BACKUP_WEBDAV_PASSWORD_KEY = "backup_webdav_password";
const BACKUP_WEBDAV_PATH_KEY = "backup_webdav_path";
const BACKUP_KEEP_VERSIONS_KEY = "backup_keep_versions";
const BACKUP_INSTANCE_ID_KEY = "backup_instance_id";
const BACKUP_LAST_SYNC_AT_KEY = "backup_last_sync_at";
const BACKUP_LAST_SYNC_STATUS_KEY = "backup_last_sync_status";
const BACKUP_LAST_SYNC_MESSAGE_KEY = "backup_last_sync_message";

const RUNTIME_SETTING_KEYS = [
	PROXY_UPSTREAM_TIMEOUT_KEY,
	PROXY_RETRY_MAX_RETRIES_KEY,
	PROXY_RETRY_SLEEP_MS_KEY,
	PROXY_RETRY_SLEEP_ERROR_CODES_KEY,
	CHANNEL_DISABLE_ERROR_CODES_KEY,
	CHANNEL_DISABLE_ERROR_THRESHOLD_KEY,
	CHANNEL_DISABLE_ERROR_CODE_MINUTES_KEY,
	PROXY_ZERO_COMPLETION_AS_ERROR_KEY,
	MODEL_FAILURE_COOLDOWN_KEY,
	MODEL_FAILURE_COOLDOWN_THRESHOLD_KEY,
	PROXY_STREAM_USAGE_MODE_KEY,
	PROXY_STREAM_USAGE_MAX_PARSERS_KEY,
	PROXY_STREAM_USAGE_PARSE_TIMEOUT_KEY,
	PROXY_RESPONSES_AFFINITY_TTL_KEY,
	PROXY_STREAM_OPTIONS_CAPABILITY_TTL_KEY,
	PROXY_ATTEMPT_WORKER_FALLBACK_ENABLED_KEY,
	PROXY_ATTEMPT_WORKER_FALLBACK_THRESHOLD_KEY,
	PROXY_LARGE_REQUEST_OFFLOAD_THRESHOLD_BYTES_KEY,
	ATTEMPT_LOG_ENABLED_KEY,
	ATTEMPT_LOG_RETENTION_DAYS_KEY,
] as const;

const BACKUP_SETTING_KEYS = [
	BACKUP_ENABLED_KEY,
	BACKUP_SCHEDULE_TIME_KEY,
	BACKUP_SYNC_MODE_KEY,
	BACKUP_CONFLICT_POLICY_KEY,
	BACKUP_IMPORT_MODE_KEY,
	BACKUP_WEBDAV_URL_KEY,
	BACKUP_WEBDAV_USERNAME_KEY,
	BACKUP_WEBDAV_PASSWORD_KEY,
	BACKUP_WEBDAV_PATH_KEY,
	BACKUP_KEEP_VERSIONS_KEY,
	BACKUP_INSTANCE_ID_KEY,
	BACKUP_LAST_SYNC_AT_KEY,
	BACKUP_LAST_SYNC_STATUS_KEY,
	BACKUP_LAST_SYNC_MESSAGE_KEY,
] as const;

export type RuntimeProxyConfig = {
	upstream_timeout_ms: number;
	retry_max_retries: number;
	retry_sleep_ms: number;
	retry_sleep_error_codes: string[];
	channel_disable_error_codes: string[];
	channel_disable_error_threshold: number;
	channel_disable_error_code_minutes: number;
	zero_completion_as_error_enabled: boolean;
	model_failure_cooldown_minutes: number;
	model_failure_cooldown_threshold: number;
	stream_usage_mode: string;
	stream_usage_max_parsers: number;
	attempt_worker_fallback_enabled: boolean;
	attempt_worker_fallback_threshold: number;
	large_request_offload_threshold_bytes: number;
	attempt_log_enabled: boolean;
	attempt_log_retention_days: number;
	attempt_worker_bound: boolean;
	attempt_worker_fallback_active: boolean;
};

export type ProxyRuntimeSettings = {
	upstream_timeout_ms: number;
	retry_max_retries: number;
	retry_sleep_ms: number;
	retry_sleep_error_codes: string[];
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
	attempt_log_enabled: boolean;
	attempt_log_retention_days: number;
};

export type BackupSyncMode = "push" | "pull" | "two_way";

export type BackupConflictPolicy = "local_wins" | "remote_wins";

export type BackupImportMode = "merge" | "replace";

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
};

type SettingSnapshot<T> = {
	value: T;
	expiresAt: number;
};

let retentionSnapshot: SettingSnapshot<number> | null = null;
let sessionTtlSnapshot: SettingSnapshot<number> | null = null;
let adminPasswordSnapshot: SettingSnapshot<string | null> | null = null;
let checkinScheduleSnapshot: SettingSnapshot<string> | null = null;
let channelRecoveryProbeEnabledSnapshot: SettingSnapshot<boolean> | null = null;
let channelRecoveryProbeScheduleSnapshot: SettingSnapshot<string> | null = null;
let modelCooldownSnapshot: SettingSnapshot<number> | null = null;
let runtimeSettingsSnapshot: SettingSnapshot<ProxyRuntimeSettings> | null =
	null;
let backupSettingsSnapshot: SettingSnapshot<BackupSettings> | null = null;

async function readSetting(
	db: D1Database,
	key: string,
): Promise<string | null> {
	const setting = await db
		.prepare("SELECT value FROM settings WHERE key = ?")
		.bind(key)
		.first<{ value?: string }>();
	return setting?.value ? String(setting.value) : null;
}

async function readSettingsByKeys(
	db: D1Database,
	keys: readonly string[],
): Promise<Record<string, string>> {
	if (keys.length === 0) {
		return {};
	}
	const placeholders = keys.map(() => "?").join(", ");
	const result = await db
		.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
		.bind(...keys)
		.all<{ key: string; value: string }>();
	const map: Record<string, string> = {};
	for (const row of result.results ?? []) {
		map[String(row.key)] = String(row.value);
	}
	return map;
}

async function upsertSetting(
	db: D1Database,
	key: string,
	value: string,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		)
		.bind(key, value, nowIso())
		.run();
}

function parsePositiveNumber(value: string | null, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && parsed > 0) {
		return parsed;
	}
	return fallback;
}

function parseNonNegativeSetting(
	value: string | null,
	fallback: number,
): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && parsed >= 0) {
		return Math.floor(parsed);
	}
	return fallback;
}

function parsePositiveSetting(value: string | null, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && parsed > 0) {
		return Math.floor(parsed);
	}
	return fallback;
}

function parseBooleanSetting(value: string | null, fallback: boolean): boolean {
	if (value === null || value === undefined) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return fallback;
}

async function getCachedSetting<T>(
	snapshot: SettingSnapshot<T> | null,
	loader: () => Promise<T>,
	onUpdate: (next: SettingSnapshot<T> | null) => void,
): Promise<T> {
	if (snapshot && snapshot.expiresAt > Date.now()) {
		return snapshot.value;
	}
	const value = await loader();
	onUpdate({
		value,
		expiresAt: Date.now() + SETTING_SNAPSHOT_TTL_MS,
	});
	return value;
}

function clearRuntimeSnapshots(): void {
	runtimeSettingsSnapshot = null;
	modelCooldownSnapshot = null;
}

function clearBackupSnapshots(): void {
	backupSettingsSnapshot = null;
}

function normalizeStreamUsageMode(value: string | undefined): string {
	const normalized = (value ?? "").toLowerCase();
	if (normalized === "off" || normalized === "full" || normalized === "lite") {
		return normalized;
	}
	return DEFAULT_PROXY_STREAM_USAGE_MODE;
}

function normalizeBackupSyncMode(value: string | undefined): BackupSyncMode {
	const normalized = (value ?? "").trim().toLowerCase();
	if (
		normalized === "push" ||
		normalized === "pull" ||
		normalized === "two_way"
	) {
		return normalized;
	}
	return DEFAULT_BACKUP_SYNC_MODE;
}

function normalizeBackupConflictPolicy(
	value: string | undefined,
): BackupConflictPolicy {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "local_wins" || normalized === "remote_wins") {
		return normalized;
	}
	return DEFAULT_BACKUP_CONFLICT_POLICY;
}

function normalizeBackupImportMode(
	value: string | undefined,
): BackupImportMode {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "merge" || normalized === "replace") {
		return normalized;
	}
	return DEFAULT_BACKUP_IMPORT_MODE;
}

export function normalizeErrorCodeList(input: unknown): string[] | null {
	let values: string[] = [];
	if (typeof input === "string") {
		values = input.split(/[,\n]/g);
	} else if (Array.isArray(input)) {
		values = input.filter((item) => typeof item === "string") as string[];
	} else {
		return null;
	}
	const normalized = values
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item.length > 0);
	return Array.from(new Set(normalized));
}

function stringifyErrorCodeList(codes: string[]): string {
	return Array.from(
		new Set(
			codes
				.map((code) => code.trim().toLowerCase())
				.filter((code) => code.length > 0),
		),
	).join(",");
}

function parseErrorCodeListSetting(
	value: string | null,
	fallback: string[],
): string[] {
	const normalized = normalizeErrorCodeList(value);
	return normalized ?? [...fallback];
}

export async function getProxyRuntimeSettings(
	db: D1Database,
): Promise<ProxyRuntimeSettings> {
	const snapshot = runtimeSettingsSnapshot;
	if (snapshot && snapshot.expiresAt > Date.now()) {
		return snapshot.value;
	}

	const settings = await readSettingsByKeys(db, RUNTIME_SETTING_KEYS);
	const value: ProxyRuntimeSettings = {
		upstream_timeout_ms: parseNonNegativeSetting(
			settings[PROXY_UPSTREAM_TIMEOUT_KEY] ?? null,
			DEFAULT_PROXY_UPSTREAM_TIMEOUT_MS,
		),
		retry_max_retries: parseNonNegativeSetting(
			settings[PROXY_RETRY_MAX_RETRIES_KEY] ?? null,
			DEFAULT_PROXY_RETRY_MAX_RETRIES,
		),
		retry_sleep_ms: parseNonNegativeSetting(
			settings[PROXY_RETRY_SLEEP_MS_KEY] ?? null,
			DEFAULT_PROXY_RETRY_SLEEP_MS,
		),
		retry_sleep_error_codes: parseErrorCodeListSetting(
			settings[PROXY_RETRY_SLEEP_ERROR_CODES_KEY] ?? null,
			DEFAULT_PROXY_RETRY_SLEEP_ERROR_CODES,
		),
		channel_disable_error_codes: parseErrorCodeListSetting(
			settings[CHANNEL_DISABLE_ERROR_CODES_KEY] ?? null,
			DEFAULT_CHANNEL_DISABLE_ERROR_CODES,
		),
		channel_disable_error_threshold: parsePositiveSetting(
			settings[CHANNEL_DISABLE_ERROR_THRESHOLD_KEY] ?? null,
			DEFAULT_CHANNEL_DISABLE_ERROR_THRESHOLD,
		),
		channel_disable_error_code_minutes: parseNonNegativeSetting(
			settings[CHANNEL_DISABLE_ERROR_CODE_MINUTES_KEY] ?? null,
			DEFAULT_CHANNEL_DISABLE_ERROR_CODE_MINUTES,
		),
		zero_completion_as_error_enabled: parseBooleanSetting(
			settings[PROXY_ZERO_COMPLETION_AS_ERROR_KEY] ?? null,
			DEFAULT_PROXY_ZERO_COMPLETION_AS_ERROR_ENABLED,
		),
		model_failure_cooldown_minutes: parseNonNegativeSetting(
			settings[MODEL_FAILURE_COOLDOWN_KEY] ?? null,
			DEFAULT_MODEL_FAILURE_COOLDOWN_MINUTES,
		),
		model_failure_cooldown_threshold: parsePositiveSetting(
			settings[MODEL_FAILURE_COOLDOWN_THRESHOLD_KEY] ?? null,
			DEFAULT_MODEL_FAILURE_COOLDOWN_THRESHOLD,
		),
		stream_usage_mode: normalizeStreamUsageMode(
			settings[PROXY_STREAM_USAGE_MODE_KEY],
		),
		stream_usage_max_parsers: parseNonNegativeSetting(
			settings[PROXY_STREAM_USAGE_MAX_PARSERS_KEY] ?? null,
			DEFAULT_PROXY_STREAM_USAGE_MAX_PARSERS,
		),
		stream_usage_parse_timeout_ms: parseNonNegativeSetting(
			settings[PROXY_STREAM_USAGE_PARSE_TIMEOUT_KEY] ?? null,
			DEFAULT_PROXY_STREAM_USAGE_PARSE_TIMEOUT_MS,
		),
		responses_affinity_ttl_seconds: parsePositiveSetting(
			settings[PROXY_RESPONSES_AFFINITY_TTL_KEY] ?? null,
			DEFAULT_PROXY_RESPONSES_AFFINITY_TTL_SECONDS,
		),
		stream_options_capability_ttl_seconds: parsePositiveSetting(
			settings[PROXY_STREAM_OPTIONS_CAPABILITY_TTL_KEY] ?? null,
			DEFAULT_PROXY_STREAM_OPTIONS_CAPABILITY_TTL_SECONDS,
		),
		attempt_worker_fallback_enabled: parseBooleanSetting(
			settings[PROXY_ATTEMPT_WORKER_FALLBACK_ENABLED_KEY] ?? null,
			DEFAULT_PROXY_ATTEMPT_WORKER_FALLBACK_ENABLED,
		),
		attempt_worker_fallback_threshold: parsePositiveSetting(
			settings[PROXY_ATTEMPT_WORKER_FALLBACK_THRESHOLD_KEY] ?? null,
			DEFAULT_PROXY_ATTEMPT_WORKER_FALLBACK_THRESHOLD,
		),
		large_request_offload_threshold_bytes: parseNonNegativeSetting(
			settings[PROXY_LARGE_REQUEST_OFFLOAD_THRESHOLD_BYTES_KEY] ?? null,
			DEFAULT_PROXY_LARGE_REQUEST_OFFLOAD_THRESHOLD_BYTES,
		),
		attempt_log_enabled: parseBooleanSetting(
			settings[ATTEMPT_LOG_ENABLED_KEY] ?? null,
			DEFAULT_ATTEMPT_LOG_ENABLED,
		),
		attempt_log_retention_days: parsePositiveSetting(
			settings[ATTEMPT_LOG_RETENTION_DAYS_KEY] ?? null,
			DEFAULT_ATTEMPT_LOG_RETENTION_DAYS,
		),
	};
	runtimeSettingsSnapshot = {
		value,
		expiresAt: Date.now() + RUNTIME_SETTING_SNAPSHOT_TTL_MS,
	};
	return value;
}

/**
 * Returns runtime proxy configuration derived from settings and environment.
 *
 * @param env - Worker bindings.
 * @param settings - Runtime settings snapshot.
 * @returns Runtime proxy configuration for display.
 */
export function getRuntimeProxyConfig(
	env: Bindings,
	settings: ProxyRuntimeSettings,
): RuntimeProxyConfig {
	const attemptWorkerBound = Boolean(env.ATTEMPT_WORKER);
	return {
		...settings,
		attempt_worker_bound: attemptWorkerBound,
		attempt_worker_fallback_active:
			attemptWorkerBound && settings.attempt_worker_fallback_enabled,
	};
}

export async function setProxyRuntimeSettings(
	db: D1Database,
	update: Partial<ProxyRuntimeSettings>,
): Promise<void> {
	const tasks: Promise<void>[] = [];
	if (update.upstream_timeout_ms !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_UPSTREAM_TIMEOUT_KEY,
				String(Math.max(0, Math.floor(update.upstream_timeout_ms))),
			),
		);
	}
	if (update.retry_max_retries !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_RETRY_MAX_RETRIES_KEY,
				String(Math.max(0, Math.floor(update.retry_max_retries))),
			),
		);
	}
	if (update.retry_sleep_ms !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_RETRY_SLEEP_MS_KEY,
				String(Math.max(0, Math.floor(update.retry_sleep_ms))),
			),
		);
	}
	if (update.retry_sleep_error_codes !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_RETRY_SLEEP_ERROR_CODES_KEY,
				stringifyErrorCodeList(update.retry_sleep_error_codes),
			),
		);
	}
	if (update.channel_disable_error_codes !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CHANNEL_DISABLE_ERROR_CODES_KEY,
				stringifyErrorCodeList(update.channel_disable_error_codes),
			),
		);
	}
	if (update.channel_disable_error_threshold !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CHANNEL_DISABLE_ERROR_THRESHOLD_KEY,
				String(Math.max(1, Math.floor(update.channel_disable_error_threshold))),
			),
		);
	}
	if (update.channel_disable_error_code_minutes !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CHANNEL_DISABLE_ERROR_CODE_MINUTES_KEY,
				String(
					Math.max(0, Math.floor(update.channel_disable_error_code_minutes)),
				),
			),
		);
	}
	if (update.zero_completion_as_error_enabled !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_ZERO_COMPLETION_AS_ERROR_KEY,
				update.zero_completion_as_error_enabled ? "1" : "0",
			),
		);
	}
	if (update.model_failure_cooldown_minutes !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				MODEL_FAILURE_COOLDOWN_KEY,
				String(Math.max(0, Math.floor(update.model_failure_cooldown_minutes))),
			),
		);
	}
	if (update.model_failure_cooldown_threshold !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				MODEL_FAILURE_COOLDOWN_THRESHOLD_KEY,
				String(
					Math.max(1, Math.floor(update.model_failure_cooldown_threshold)),
				),
			),
		);
	}
	if (update.stream_usage_mode !== undefined) {
		tasks.push(
			upsertSetting(db, PROXY_STREAM_USAGE_MODE_KEY, update.stream_usage_mode),
		);
	}
	if (update.stream_usage_max_parsers !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_STREAM_USAGE_MAX_PARSERS_KEY,
				String(Math.max(0, Math.floor(update.stream_usage_max_parsers))),
			),
		);
	}
	if (update.stream_usage_parse_timeout_ms !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_STREAM_USAGE_PARSE_TIMEOUT_KEY,
				String(Math.max(0, Math.floor(update.stream_usage_parse_timeout_ms))),
			),
		);
	}
	if (update.responses_affinity_ttl_seconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_RESPONSES_AFFINITY_TTL_KEY,
				String(Math.max(1, Math.floor(update.responses_affinity_ttl_seconds))),
			),
		);
	}
	if (update.stream_options_capability_ttl_seconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_STREAM_OPTIONS_CAPABILITY_TTL_KEY,
				String(
					Math.max(1, Math.floor(update.stream_options_capability_ttl_seconds)),
				),
			),
		);
	}
	if (update.attempt_worker_fallback_enabled !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_ATTEMPT_WORKER_FALLBACK_ENABLED_KEY,
				update.attempt_worker_fallback_enabled ? "1" : "0",
			),
		);
	}
	if (update.attempt_worker_fallback_threshold !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_ATTEMPT_WORKER_FALLBACK_THRESHOLD_KEY,
				String(
					Math.max(1, Math.floor(update.attempt_worker_fallback_threshold)),
				),
			),
		);
	}
	if (update.large_request_offload_threshold_bytes !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_LARGE_REQUEST_OFFLOAD_THRESHOLD_BYTES_KEY,
				String(
					Math.max(0, Math.floor(update.large_request_offload_threshold_bytes)),
				),
			),
		);
	}
	if (update.attempt_log_enabled !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				ATTEMPT_LOG_ENABLED_KEY,
				update.attempt_log_enabled ? "1" : "0",
			),
		);
	}
	if (update.attempt_log_retention_days !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				ATTEMPT_LOG_RETENTION_DAYS_KEY,
				String(Math.max(1, Math.floor(update.attempt_log_retention_days))),
			),
		);
	}
	if (tasks.length === 0) {
		return;
	}
	await Promise.all(tasks);
	clearRuntimeSnapshots();
}

/**
 * Returns the log retention days from settings or default fallback.
 */
export async function getRetentionDays(db: D1Database): Promise<number> {
	return getCachedSetting(
		retentionSnapshot,
		async () => {
			const value = await readSetting(db, RETENTION_KEY);
			return parsePositiveNumber(value, DEFAULT_LOG_RETENTION_DAYS);
		},
		(next) => {
			retentionSnapshot = next;
		},
	);
}

/**
 * Updates the log retention days setting.
 */
export async function setRetentionDays(
	db: D1Database,
	days: number,
): Promise<void> {
	const value = Math.max(1, Math.floor(days)).toString();
	await upsertSetting(db, RETENTION_KEY, value);
	retentionSnapshot = null;
}

/**
 * Returns the session TTL hours from settings or default fallback.
 */
export async function getSessionTtlHours(db: D1Database): Promise<number> {
	return getCachedSetting(
		sessionTtlSnapshot,
		async () => {
			const value = await readSetting(db, SESSION_TTL_KEY);
			return parsePositiveNumber(value, DEFAULT_SESSION_TTL_HOURS);
		},
		(next) => {
			sessionTtlSnapshot = next;
		},
	);
}

/**
 * Updates the session TTL hours setting.
 */
export async function setSessionTtlHours(
	db: D1Database,
	hours: number,
): Promise<void> {
	const value = Math.max(1, Math.floor(hours)).toString();
	await upsertSetting(db, SESSION_TTL_KEY, value);
	sessionTtlSnapshot = null;
}

/**
 * Returns the admin password hash.
 */
export async function getAdminPasswordHash(
	db: D1Database,
): Promise<string | null> {
	return getCachedSetting(
		adminPasswordSnapshot,
		() => readSetting(db, ADMIN_PASSWORD_HASH_KEY),
		(next) => {
			adminPasswordSnapshot = next;
		},
	);
}

/**
 * Updates the admin password hash.
 */
export async function setAdminPasswordHash(
	db: D1Database,
	hash: string,
): Promise<void> {
	if (!hash) {
		return;
	}
	await upsertSetting(db, ADMIN_PASSWORD_HASH_KEY, hash);
	adminPasswordSnapshot = null;
}

/**
 * Returns whether the admin password is set.
 */
export async function isAdminPasswordSet(db: D1Database): Promise<boolean> {
	const hash = await getAdminPasswordHash(db);
	return Boolean(hash);
}

export async function getCheckinScheduleTime(db: D1Database): Promise<string> {
	return getCachedSetting(
		checkinScheduleSnapshot,
		async () => {
			const timeRaw = await readSetting(db, CHECKIN_SCHEDULE_TIME_KEY);
			return timeRaw && timeRaw.length > 0
				? timeRaw
				: DEFAULT_CHECKIN_SCHEDULE_TIME;
		},
		(next) => {
			checkinScheduleSnapshot = next;
		},
	);
}

export async function setCheckinScheduleTime(
	db: D1Database,
	time: string,
): Promise<void> {
	await upsertSetting(db, CHECKIN_SCHEDULE_TIME_KEY, time);
	checkinScheduleSnapshot = null;
}

export async function getChannelRecoveryProbeEnabled(
	db: D1Database,
): Promise<boolean> {
	return getCachedSetting(
		channelRecoveryProbeEnabledSnapshot,
		async () => {
			const raw = await readSetting(db, CHANNEL_RECOVERY_PROBE_ENABLED_KEY);
			return parseBooleanSetting(raw, DEFAULT_CHANNEL_RECOVERY_PROBE_ENABLED);
		},
		(next) => {
			channelRecoveryProbeEnabledSnapshot = next;
		},
	);
}

export async function setChannelRecoveryProbeEnabled(
	db: D1Database,
	enabled: boolean,
): Promise<void> {
	await upsertSetting(
		db,
		CHANNEL_RECOVERY_PROBE_ENABLED_KEY,
		enabled ? "1" : "0",
	);
	channelRecoveryProbeEnabledSnapshot = null;
}

export async function getChannelRecoveryProbeScheduleTime(
	db: D1Database,
): Promise<string> {
	return getCachedSetting(
		channelRecoveryProbeScheduleSnapshot,
		async () => {
			const raw = await readSetting(
				db,
				CHANNEL_RECOVERY_PROBE_SCHEDULE_TIME_KEY,
			);
			if (raw && parseScheduleTime(raw)) {
				return raw;
			}
			return DEFAULT_CHANNEL_RECOVERY_PROBE_SCHEDULE_TIME;
		},
		(next) => {
			channelRecoveryProbeScheduleSnapshot = next;
		},
	);
}

export async function setChannelRecoveryProbeScheduleTime(
	db: D1Database,
	time: string,
): Promise<void> {
	await upsertSetting(db, CHANNEL_RECOVERY_PROBE_SCHEDULE_TIME_KEY, time);
	channelRecoveryProbeScheduleSnapshot = null;
}

export async function getModelFailureCooldownMinutes(
	db: D1Database,
): Promise<number> {
	return getCachedSetting(
		modelCooldownSnapshot,
		async () => {
			const value = await readSetting(db, MODEL_FAILURE_COOLDOWN_KEY);
			return parseNonNegativeSetting(
				value,
				DEFAULT_MODEL_FAILURE_COOLDOWN_MINUTES,
			);
		},
		(next) => {
			modelCooldownSnapshot = next;
		},
	);
}

export async function getAttemptLogRetentionDays(
	db: D1Database,
): Promise<number> {
	const value = await readSetting(db, ATTEMPT_LOG_RETENTION_DAYS_KEY);
	return parsePositiveNumber(value, DEFAULT_ATTEMPT_LOG_RETENTION_DAYS);
}

export async function setModelFailureCooldownMinutes(
	db: D1Database,
	minutes: number,
): Promise<void> {
	const value = Math.max(0, Math.floor(minutes)).toString();
	await upsertSetting(db, MODEL_FAILURE_COOLDOWN_KEY, value);
	modelCooldownSnapshot = null;
	clearRuntimeSnapshots();
}

export async function getBackupSettings(
	db: D1Database,
): Promise<BackupSettings> {
	const snapshot = backupSettingsSnapshot;
	if (snapshot && snapshot.expiresAt > Date.now()) {
		return snapshot.value;
	}
	const settings = await readSettingsByKeys(db, BACKUP_SETTING_KEYS);
	let instanceId = (settings[BACKUP_INSTANCE_ID_KEY] ?? "").trim();
	if (!instanceId) {
		instanceId = crypto.randomUUID();
		await upsertSetting(db, BACKUP_INSTANCE_ID_KEY, instanceId);
	}
	const scheduleTimeRaw =
		(settings[BACKUP_SCHEDULE_TIME_KEY] ?? "").trim() ||
		DEFAULT_BACKUP_SCHEDULE_TIME;
	const scheduleTime = parseScheduleTime(scheduleTimeRaw)
		? scheduleTimeRaw
		: DEFAULT_BACKUP_SCHEDULE_TIME;
	const normalizedPath =
		(settings[BACKUP_WEBDAV_PATH_KEY] ?? "").trim() ||
		DEFAULT_BACKUP_WEBDAV_PATH;
	const value: BackupSettings = {
		enabled: parseBooleanSetting(
			settings[BACKUP_ENABLED_KEY] ?? null,
			DEFAULT_BACKUP_ENABLED,
		),
		schedule_time: scheduleTime,
		sync_mode: normalizeBackupSyncMode(settings[BACKUP_SYNC_MODE_KEY]),
		conflict_policy: normalizeBackupConflictPolicy(
			settings[BACKUP_CONFLICT_POLICY_KEY],
		),
		import_mode: normalizeBackupImportMode(settings[BACKUP_IMPORT_MODE_KEY]),
		webdav_url:
			(settings[BACKUP_WEBDAV_URL_KEY] ?? "").trim() ||
			DEFAULT_BACKUP_WEBDAV_URL,
		webdav_username:
			(settings[BACKUP_WEBDAV_USERNAME_KEY] ?? "").trim() ||
			DEFAULT_BACKUP_WEBDAV_USERNAME,
		webdav_password:
			(settings[BACKUP_WEBDAV_PASSWORD_KEY] ?? "").trim() ||
			DEFAULT_BACKUP_WEBDAV_PASSWORD,
		webdav_path: normalizedPath,
		keep_versions: parsePositiveSetting(
			settings[BACKUP_KEEP_VERSIONS_KEY] ?? null,
			DEFAULT_BACKUP_KEEP_VERSIONS,
		),
		instance_id: instanceId,
		last_sync_at: (settings[BACKUP_LAST_SYNC_AT_KEY] ?? "").trim() || null,
		last_sync_status:
			(settings[BACKUP_LAST_SYNC_STATUS_KEY] ?? "").trim() === "success" ||
			(settings[BACKUP_LAST_SYNC_STATUS_KEY] ?? "").trim() === "failed"
				? ((settings[BACKUP_LAST_SYNC_STATUS_KEY] ?? "").trim() as
						| "success"
						| "failed")
				: "idle",
		last_sync_message:
			(settings[BACKUP_LAST_SYNC_MESSAGE_KEY] ?? "").trim() || null,
	};
	backupSettingsSnapshot = {
		value,
		expiresAt: Date.now() + BACKUP_SETTING_SNAPSHOT_TTL_MS,
	};
	return value;
}

export async function getBackupScheduleEnabled(
	db: D1Database,
): Promise<boolean> {
	const settings = await getBackupSettings(db);
	return settings.enabled;
}

export async function getBackupScheduleTime(db: D1Database): Promise<string> {
	const settings = await getBackupSettings(db);
	return settings.schedule_time;
}

export async function setBackupSettings(
	db: D1Database,
	update: Partial<BackupSettings>,
): Promise<void> {
	const tasks: Promise<void>[] = [];
	if (update.enabled !== undefined) {
		tasks.push(
			upsertSetting(db, BACKUP_ENABLED_KEY, update.enabled ? "1" : "0"),
		);
	}
	if (update.schedule_time !== undefined) {
		const scheduleTime = parseScheduleTime(update.schedule_time)
			? update.schedule_time
			: DEFAULT_BACKUP_SCHEDULE_TIME;
		tasks.push(upsertSetting(db, BACKUP_SCHEDULE_TIME_KEY, scheduleTime));
	}
	if (update.sync_mode !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_SYNC_MODE_KEY,
				normalizeBackupSyncMode(update.sync_mode),
			),
		);
	}
	if (update.conflict_policy !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_CONFLICT_POLICY_KEY,
				normalizeBackupConflictPolicy(update.conflict_policy),
			),
		);
	}
	if (update.import_mode !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_IMPORT_MODE_KEY,
				normalizeBackupImportMode(update.import_mode),
			),
		);
	}
	if (update.webdav_url !== undefined) {
		tasks.push(
			upsertSetting(db, BACKUP_WEBDAV_URL_KEY, update.webdav_url.trim()),
		);
	}
	if (update.webdav_username !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_WEBDAV_USERNAME_KEY,
				update.webdav_username.trim(),
			),
		);
	}
	if (update.webdav_password !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_WEBDAV_PASSWORD_KEY,
				update.webdav_password.trim(),
			),
		);
	}
	if (update.webdav_path !== undefined) {
		const normalized = update.webdav_path.trim() || DEFAULT_BACKUP_WEBDAV_PATH;
		tasks.push(upsertSetting(db, BACKUP_WEBDAV_PATH_KEY, normalized));
	}
	if (update.keep_versions !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_KEEP_VERSIONS_KEY,
				String(Math.max(1, Math.floor(update.keep_versions))),
			),
		);
	}
	if (update.instance_id !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_INSTANCE_ID_KEY,
				update.instance_id.trim() || crypto.randomUUID(),
			),
		);
	}
	if (update.last_sync_at !== undefined) {
		tasks.push(
			upsertSetting(db, BACKUP_LAST_SYNC_AT_KEY, update.last_sync_at ?? ""),
		);
	}
	if (update.last_sync_status !== undefined) {
		const status =
			update.last_sync_status === "success" ||
			update.last_sync_status === "failed" ||
			update.last_sync_status === "idle"
				? update.last_sync_status
				: "idle";
		tasks.push(upsertSetting(db, BACKUP_LAST_SYNC_STATUS_KEY, status));
	}
	if (update.last_sync_message !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				BACKUP_LAST_SYNC_MESSAGE_KEY,
				update.last_sync_message ?? "",
			),
		);
	}
	if (tasks.length === 0) {
		return;
	}
	await Promise.all(tasks);
	clearBackupSnapshots();
}

/**
 * Resets in-memory setting snapshots (testing utility).
 */
export function resetSettingsSnapshots(): void {
	retentionSnapshot = null;
	sessionTtlSnapshot = null;
	adminPasswordSnapshot = null;
	checkinScheduleSnapshot = null;
	channelRecoveryProbeEnabledSnapshot = null;
	channelRecoveryProbeScheduleSnapshot = null;
	modelCooldownSnapshot = null;
	runtimeSettingsSnapshot = null;
	backupSettingsSnapshot = null;
}
