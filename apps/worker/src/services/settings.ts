import type {
	D1Database,
	DurableObjectNamespace,
} from "@cloudflare/workers-types";
import type { Bindings } from "../env";
import { withJsonCache } from "../utils/cache";
import { nowIso } from "../utils/time";
import {
	ALL_CACHE_VERSION_SCOPES,
	bumpCacheVersionsInStore,
	type CacheVersionScope,
	readCacheVersionsFromStore,
} from "./cache-version-store";
import {
	normalizeRuntimeEventLevels,
	RUNTIME_EVENT_LEVEL_VALUES,
	type RuntimeEventLevel,
	recordRuntimeEvent,
	resetRuntimeEventLevelSnapshot,
} from "./runtime-events";

const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_SESSION_TTL_HOURS = 12;
const DEFAULT_CHECKIN_SCHEDULE_TIME = "00:10";
const DEFAULT_MODEL_FAILURE_COOLDOWN_MINUTES = 10;
const DEFAULT_PROXY_STREAM_USAGE_MODE = "full";
const DEFAULT_PROXY_STREAM_USAGE_MAX_BYTES = 0;
const DEFAULT_PROXY_STREAM_USAGE_MAX_PARSERS = 0;
const DEFAULT_CACHE_ENABLED = true;
const DEFAULT_CACHE_VERSION = 1;
const DEFAULT_CACHE_DASHBOARD_TTL_SECONDS = 30;
const DEFAULT_CACHE_USAGE_TTL_SECONDS = 15;
const DEFAULT_CACHE_MODELS_TTL_SECONDS = 60;
const DEFAULT_CACHE_TOKENS_TTL_SECONDS = 15;
const DEFAULT_CACHE_CHANNELS_TTL_SECONDS = 15;
const DEFAULT_CACHE_CALL_TOKENS_TTL_SECONDS = 15;
const DEFAULT_CACHE_SETTINGS_TTL_SECONDS = 30;
const DEFAULT_RUNTIME_EVENT_RETENTION_DAYS = 30;
const DEFAULT_PROXY_UPSTREAM_TIMEOUT_MS = 30000;
const DEFAULT_PROXY_RETRY_MAX_RETRIES = 3;
const DEFAULT_PROXY_USAGE_QUEUE_ENABLED = true;
const DEFAULT_USAGE_QUEUE_DAILY_LIMIT = 10000;
const DEFAULT_USAGE_QUEUE_DIRECT_WRITE_RATIO = 0.5;
const CACHE_CONFIG_TTL_MS = 0;
const SETTING_SNAPSHOT_TTL_MS = 1000;
const RETENTION_KEY = "log_retention_days";
const SESSION_TTL_KEY = "session_ttl_hours";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";
const CHECKIN_SCHEDULE_TIME_KEY = "checkin_schedule_time";
const MODEL_FAILURE_COOLDOWN_KEY = "model_failure_cooldown_minutes";
const CACHE_ENABLED_KEY = "cache_enabled";
const CACHE_DASHBOARD_TTL_KEY = "cache_ttl_dashboard_seconds";
const CACHE_USAGE_TTL_KEY = "cache_ttl_usage_seconds";
const CACHE_MODELS_TTL_KEY = "cache_ttl_models_seconds";
const CACHE_TOKENS_TTL_KEY = "cache_ttl_tokens_seconds";
const CACHE_CHANNELS_TTL_KEY = "cache_ttl_channels_seconds";
const CACHE_CALL_TOKENS_TTL_KEY = "cache_ttl_call_tokens_seconds";
const CACHE_SETTINGS_TTL_KEY = "cache_ttl_settings_seconds";
const CACHE_VERSION_DASHBOARD_KEY = "cache_v_dashboard";
const CACHE_VERSION_USAGE_KEY = "cache_v_usage";
const CACHE_VERSION_MODELS_KEY = "cache_v_models";
const CACHE_VERSION_TOKENS_KEY = "cache_v_tokens";
const CACHE_VERSION_CHANNELS_KEY = "cache_v_channels";
const CACHE_VERSION_CALL_TOKENS_KEY = "cache_v_call_tokens";
const CACHE_VERSION_SETTINGS_KEY = "cache_v_settings";
const PROXY_UPSTREAM_TIMEOUT_KEY = "proxy_upstream_timeout_ms";
const PROXY_RETRY_MAX_RETRIES_KEY = "proxy_retry_max_retries";
const PROXY_STREAM_USAGE_MODE_KEY = "proxy_stream_usage_mode";
const PROXY_STREAM_USAGE_MAX_BYTES_KEY = "proxy_stream_usage_max_bytes";
const PROXY_STREAM_USAGE_MAX_PARSERS_KEY = "proxy_stream_usage_max_parsers";
const PROXY_USAGE_QUEUE_ENABLED_KEY = "proxy_usage_queue_enabled";
const USAGE_QUEUE_DAILY_LIMIT_KEY = "usage_queue_daily_limit";
const USAGE_QUEUE_DIRECT_WRITE_RATIO_KEY = "usage_queue_direct_write_ratio";
const RUNTIME_EVENT_RETENTION_KEY = "runtime_event_retention_days";
const RUNTIME_EVENT_LEVELS_KEY = "runtime_event_levels";

export type RuntimeProxyConfig = {
	upstream_timeout_ms: number;
	retry_max_retries: number;
	stream_usage_mode: string;
	stream_usage_max_bytes: number;
	stream_usage_max_parsers: number;
	usage_queue_enabled: boolean;
	usage_queue_daily_limit: number;
	usage_queue_direct_write_ratio: number;
	usage_queue_bound: boolean;
	usage_queue_active: boolean;
};

export type ProxyRuntimeSettings = {
	upstream_timeout_ms: number;
	retry_max_retries: number;
	stream_usage_mode: string;
	stream_usage_max_bytes: number;
	stream_usage_max_parsers: number;
	usage_queue_enabled: boolean;
	usage_queue_daily_limit: number;
	usage_queue_direct_write_ratio: number;
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

export type CacheConfigUpdate = {
	enabled?: boolean;
	dashboardTtlSeconds?: number;
	usageTtlSeconds?: number;
	modelsTtlSeconds?: number;
	tokensTtlSeconds?: number;
	channelsTtlSeconds?: number;
	callTokensTtlSeconds?: number;
	settingsTtlSeconds?: number;
};

type CacheConfigSnapshot = {
	value: CacheConfig;
	expiresAt: number;
};

let cacheConfigSnapshot: CacheConfigSnapshot | null = null;
type SettingSnapshot<T> = {
	value: T;
	expiresAt: number;
};
let retentionSnapshot: SettingSnapshot<number> | null = null;
let sessionTtlSnapshot: SettingSnapshot<number> | null = null;
let adminPasswordSnapshot: SettingSnapshot<string | null> | null = null;
let checkinScheduleSnapshot: SettingSnapshot<string> | null = null;
let modelCooldownSnapshot: SettingSnapshot<number> | null = null;
let runtimeEventRetentionSnapshot: SettingSnapshot<number> | null = null;
let runtimeEventLevelsSnapshot: SettingSnapshot<RuntimeEventLevel[]> | null =
	null;
type CacheControlSnapshot<T> = {
	value: T;
	expiresAt: number;
};
type SettingsCacheControl = {
	enabled: boolean;
	ttlSeconds: number;
	version: number;
};
let settingsCacheControlSnapshot: CacheControlSnapshot<SettingsCacheControl> | null =
	null;

const CACHE_VERSION_KEYS: Record<CacheVersionScope, string> = {
	dashboard: CACHE_VERSION_DASHBOARD_KEY,
	usage: CACHE_VERSION_USAGE_KEY,
	models: CACHE_VERSION_MODELS_KEY,
	tokens: CACHE_VERSION_TOKENS_KEY,
	channels: CACHE_VERSION_CHANNELS_KEY,
	call_tokens: CACHE_VERSION_CALL_TOKENS_KEY,
	settings: CACHE_VERSION_SETTINGS_KEY,
};

type CacheVersionRecord = Record<CacheVersionScope, number>;

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

function parseRatioSetting(value: string | null, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
		return Math.min(1, Math.max(0, parsed));
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

function setCacheConfigSnapshot(value: CacheConfig): void {
	cacheConfigSnapshot = {
		value,
		expiresAt: Date.now() + CACHE_CONFIG_TTL_MS,
	};
}

function clearCacheConfigSnapshot(): void {
	cacheConfigSnapshot = null;
}

function setSettingsCacheControlSnapshot(value: SettingsCacheControl): void {
	settingsCacheControlSnapshot = {
		value,
		expiresAt: Date.now() + CACHE_CONFIG_TTL_MS,
	};
}

function clearSettingsCacheControlSnapshot(): void {
	settingsCacheControlSnapshot = null;
}

async function readCacheVersion(
	db: D1Database,
	scope: CacheVersionScope,
): Promise<number> {
	const key = CACHE_VERSION_KEYS[scope];
	const value = await readSetting(db, key);
	return parsePositiveSetting(value, DEFAULT_CACHE_VERSION);
}

async function bumpCacheVersion(
	db: D1Database,
	scope: CacheVersionScope,
): Promise<void> {
	const key = CACHE_VERSION_KEYS[scope];
	await db
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(settings.value AS INTEGER) + 1, updated_at = excluded.updated_at",
		)
		.bind(key, String(DEFAULT_CACHE_VERSION + 1), nowIso())
		.run();
}

export async function bumpCacheVersions(
	db: D1Database,
	scopes: CacheVersionScope[],
	cacheVersionStore?: DurableObjectNamespace,
): Promise<void> {
	const mergedScopes = Array.from(
		new Set<CacheVersionScope>([...scopes, "settings"]),
	);
	if (mergedScopes.length === 0) {
		return;
	}
	await Promise.all(mergedScopes.map((scope) => bumpCacheVersion(db, scope)));
	if (cacheVersionStore) {
		try {
			await bumpCacheVersionsInStore(cacheVersionStore, mergedScopes);
		} catch (error) {
			try {
				await recordRuntimeEvent(db, {
					level: "warning",
					code: "cache_version_store_bump_failed",
					message: "cache_version_store_bump_failed",
					context: {
						error: error instanceof Error ? error.message : String(error),
						scopes: mergedScopes,
					},
				});
			} catch {
				// ignore runtime logging failures
			}
		}
	}
	clearCacheConfigSnapshot();
	clearSettingsCacheControlSnapshot();
}

function normalizeStreamUsageMode(value: string | undefined): string {
	const normalized = (value ?? "").toLowerCase();
	if (normalized === "off" || normalized === "full" || normalized === "lite") {
		return normalized;
	}
	return DEFAULT_PROXY_STREAM_USAGE_MODE;
}

async function getSettingsCacheControl(
	db: D1Database,
): Promise<SettingsCacheControl> {
	const snapshot = settingsCacheControlSnapshot;
	if (snapshot && snapshot.expiresAt > Date.now()) {
		return snapshot.value;
	}
	const enabled = parseBooleanSetting(
		await readSetting(db, CACHE_ENABLED_KEY),
		DEFAULT_CACHE_ENABLED,
	);
	const ttlSeconds = parseNonNegativeSetting(
		await readSetting(db, CACHE_SETTINGS_TTL_KEY),
		DEFAULT_CACHE_SETTINGS_TTL_SECONDS,
	);
	const version = await readCacheVersion(db, "settings");
	const value = { enabled, ttlSeconds, version };
	setSettingsCacheControlSnapshot(value);
	return value;
}

export async function getSettingsSnapshot(
	db: D1Database,
): Promise<Record<string, string>> {
	const control = await getSettingsCacheControl(db);
	return withJsonCache(
		{
			namespace: "settings",
			key: "all",
			version: control.version,
			ttlSeconds: control.ttlSeconds,
			enabled: control.enabled,
		},
		() => listSettings(db),
	);
}

export async function getProxyRuntimeSettings(
	db: D1Database,
): Promise<ProxyRuntimeSettings> {
	const settings = await getSettingsSnapshot(db);
	const upstreamTimeout = parsePositiveSetting(
		settings[PROXY_UPSTREAM_TIMEOUT_KEY] ?? null,
		DEFAULT_PROXY_UPSTREAM_TIMEOUT_MS,
	);
	const retryMaxRetries = parseNonNegativeSetting(
		settings[PROXY_RETRY_MAX_RETRIES_KEY] ?? null,
		DEFAULT_PROXY_RETRY_MAX_RETRIES,
	);
	const streamUsageMode = normalizeStreamUsageMode(
		settings[PROXY_STREAM_USAGE_MODE_KEY],
	);
	const streamUsageMaxBytes = parseNonNegativeSetting(
		settings[PROXY_STREAM_USAGE_MAX_BYTES_KEY] ?? null,
		DEFAULT_PROXY_STREAM_USAGE_MAX_BYTES,
	);
	const streamUsageMaxParsers = parseNonNegativeSetting(
		settings[PROXY_STREAM_USAGE_MAX_PARSERS_KEY] ?? null,
		DEFAULT_PROXY_STREAM_USAGE_MAX_PARSERS,
	);
	const usageQueueEnabled = parseBooleanSetting(
		settings[PROXY_USAGE_QUEUE_ENABLED_KEY] ?? null,
		DEFAULT_PROXY_USAGE_QUEUE_ENABLED,
	);
	const usageQueueDailyLimit = parseNonNegativeSetting(
		settings[USAGE_QUEUE_DAILY_LIMIT_KEY] ?? null,
		DEFAULT_USAGE_QUEUE_DAILY_LIMIT,
	);
	const usageQueueDirectWriteRatio = parseRatioSetting(
		settings[USAGE_QUEUE_DIRECT_WRITE_RATIO_KEY] ?? null,
		DEFAULT_USAGE_QUEUE_DIRECT_WRITE_RATIO,
	);
	return {
		upstream_timeout_ms: upstreamTimeout,
		retry_max_retries: retryMaxRetries,
		stream_usage_mode: streamUsageMode,
		stream_usage_max_bytes: streamUsageMaxBytes,
		stream_usage_max_parsers: streamUsageMaxParsers,
		usage_queue_enabled: usageQueueEnabled,
		usage_queue_daily_limit: usageQueueDailyLimit,
		usage_queue_direct_write_ratio: usageQueueDirectWriteRatio,
	};
}

/**
 * Returns runtime proxy configuration derived from settings and environment.
 *
 * @param env - Worker bindings.
 * @returns Runtime proxy configuration for display.
 */
export function getRuntimeProxyConfig(
	env: Bindings,
	settings: ProxyRuntimeSettings,
): RuntimeProxyConfig {
	const usageQueueBound = Boolean(env.USAGE_QUEUE);
	const usageQueueEnabled = settings.usage_queue_enabled;
	return {
		...settings,
		usage_queue_bound: usageQueueBound,
		usage_queue_active: usageQueueEnabled && usageQueueBound,
	};
}

export async function setProxyRuntimeSettings(
	db: D1Database,
	update: Partial<ProxyRuntimeSettings>,
	cacheVersionStore?: DurableObjectNamespace,
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
	if (update.stream_usage_mode !== undefined) {
		tasks.push(
			upsertSetting(db, PROXY_STREAM_USAGE_MODE_KEY, update.stream_usage_mode),
		);
	}
	if (update.stream_usage_max_bytes !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_STREAM_USAGE_MAX_BYTES_KEY,
				String(Math.max(0, Math.floor(update.stream_usage_max_bytes))),
			),
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
	if (update.usage_queue_enabled !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				PROXY_USAGE_QUEUE_ENABLED_KEY,
				update.usage_queue_enabled ? "1" : "0",
			),
		);
	}
	if (update.usage_queue_daily_limit !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				USAGE_QUEUE_DAILY_LIMIT_KEY,
				String(Math.max(0, Math.floor(update.usage_queue_daily_limit))),
			),
		);
	}
	if (update.usage_queue_direct_write_ratio !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				USAGE_QUEUE_DIRECT_WRITE_RATIO_KEY,
				String(update.usage_queue_direct_write_ratio),
			),
		);
	}
	if (tasks.length === 0) {
		return;
	}
	await Promise.all(tasks);
	await bumpCacheVersions(db, ["settings"], cacheVersionStore);
}

function parseCacheVersionsFromSettings(
	settings: Record<string, string>,
): CacheVersionRecord {
	return {
		dashboard: parsePositiveSetting(
			settings[CACHE_VERSION_DASHBOARD_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
		usage: parsePositiveSetting(
			settings[CACHE_VERSION_USAGE_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
		models: parsePositiveSetting(
			settings[CACHE_VERSION_MODELS_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
		tokens: parsePositiveSetting(
			settings[CACHE_VERSION_TOKENS_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
		channels: parsePositiveSetting(
			settings[CACHE_VERSION_CHANNELS_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
		call_tokens: parsePositiveSetting(
			settings[CACHE_VERSION_CALL_TOKENS_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
		settings: parsePositiveSetting(
			settings[CACHE_VERSION_SETTINGS_KEY] ?? null,
			DEFAULT_CACHE_VERSION,
		),
	};
}

export async function getCacheConfig(
	db: D1Database,
	cacheVersionStore?: DurableObjectNamespace,
): Promise<CacheConfig> {
	const snapshot = cacheConfigSnapshot;
	if (snapshot && snapshot.expiresAt > Date.now()) {
		return snapshot.value;
	}
	const settings = await getSettingsSnapshot(db);
	const enabled = parseBooleanSetting(
		settings[CACHE_ENABLED_KEY] ?? null,
		DEFAULT_CACHE_ENABLED,
	);
	const dashboardTtl = parseNonNegativeSetting(
		settings[CACHE_DASHBOARD_TTL_KEY] ?? null,
		DEFAULT_CACHE_DASHBOARD_TTL_SECONDS,
	);
	const usageTtl = parseNonNegativeSetting(
		settings[CACHE_USAGE_TTL_KEY] ?? null,
		DEFAULT_CACHE_USAGE_TTL_SECONDS,
	);
	const modelsTtl = parseNonNegativeSetting(
		settings[CACHE_MODELS_TTL_KEY] ?? null,
		DEFAULT_CACHE_MODELS_TTL_SECONDS,
	);
	const tokensTtl = parseNonNegativeSetting(
		settings[CACHE_TOKENS_TTL_KEY] ?? null,
		DEFAULT_CACHE_TOKENS_TTL_SECONDS,
	);
	const channelsTtl = parseNonNegativeSetting(
		settings[CACHE_CHANNELS_TTL_KEY] ?? null,
		DEFAULT_CACHE_CHANNELS_TTL_SECONDS,
	);
	const callTokensTtl = parseNonNegativeSetting(
		settings[CACHE_CALL_TOKENS_TTL_KEY] ?? null,
		DEFAULT_CACHE_CALL_TOKENS_TTL_SECONDS,
	);
	const settingsTtl = parseNonNegativeSetting(
		settings[CACHE_SETTINGS_TTL_KEY] ?? null,
		DEFAULT_CACHE_SETTINGS_TTL_SECONDS,
	);
	const fallbackVersions = parseCacheVersionsFromSettings(settings);
	let versions = fallbackVersions;
	if (cacheVersionStore) {
		try {
			versions = await readCacheVersionsFromStore(
				cacheVersionStore,
				[...ALL_CACHE_VERSION_SCOPES],
				fallbackVersions,
			);
		} catch (error) {
			try {
				await recordRuntimeEvent(db, {
					level: "warning",
					code: "cache_version_store_read_failed",
					message: "cache_version_store_read_failed",
					context: {
						error: error instanceof Error ? error.message : String(error),
					},
				});
			} catch {
				// ignore runtime logging failures
			}
		}
	}
	const value = {
		enabled,
		dashboard_ttl_seconds: dashboardTtl,
		usage_ttl_seconds: usageTtl,
		models_ttl_seconds: modelsTtl,
		tokens_ttl_seconds: tokensTtl,
		channels_ttl_seconds: channelsTtl,
		call_tokens_ttl_seconds: callTokensTtl,
		settings_ttl_seconds: settingsTtl,
		version_dashboard: versions.dashboard,
		version_usage: versions.usage,
		version_models: versions.models,
		version_tokens: versions.tokens,
		version_channels: versions.channels,
		version_call_tokens: versions.call_tokens,
		version_settings: versions.settings,
	};
	setCacheConfigSnapshot(value);
	return value;
}

export async function setCacheConfig(
	db: D1Database,
	update: CacheConfigUpdate,
	cacheVersionStore?: DurableObjectNamespace,
): Promise<CacheConfig> {
	const tasks: Promise<void>[] = [];
	if (update.enabled !== undefined) {
		tasks.push(
			upsertSetting(db, CACHE_ENABLED_KEY, update.enabled ? "1" : "0"),
		);
	}
	if (update.dashboardTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_DASHBOARD_TTL_KEY,
				String(Math.max(0, Math.floor(update.dashboardTtlSeconds))),
			),
		);
	}
	if (update.usageTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_USAGE_TTL_KEY,
				String(Math.max(0, Math.floor(update.usageTtlSeconds))),
			),
		);
	}
	if (update.modelsTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_MODELS_TTL_KEY,
				String(Math.max(0, Math.floor(update.modelsTtlSeconds))),
			),
		);
	}
	if (update.tokensTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_TOKENS_TTL_KEY,
				String(Math.max(0, Math.floor(update.tokensTtlSeconds))),
			),
		);
	}
	if (update.channelsTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_CHANNELS_TTL_KEY,
				String(Math.max(0, Math.floor(update.channelsTtlSeconds))),
			),
		);
	}
	if (update.callTokensTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_CALL_TOKENS_TTL_KEY,
				String(Math.max(0, Math.floor(update.callTokensTtlSeconds))),
			),
		);
	}
	if (update.settingsTtlSeconds !== undefined) {
		tasks.push(
			upsertSetting(
				db,
				CACHE_SETTINGS_TTL_KEY,
				String(Math.max(0, Math.floor(update.settingsTtlSeconds))),
			),
		);
	}
	if (tasks.length === 0) {
		return getCacheConfig(db, cacheVersionStore);
	}
	await Promise.all(tasks);
	await bumpCacheVersions(
		db,
		[
			"dashboard",
			"usage",
			"models",
			"tokens",
			"channels",
			"call_tokens",
			"settings",
		],
		cacheVersionStore,
	);
	return getCacheConfig(db, cacheVersionStore);
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

export async function getModelFailureCooldownMinutes(
	db: D1Database,
): Promise<number> {
	return getCachedSetting(
		modelCooldownSnapshot,
		async () => {
			const value = await readSetting(db, MODEL_FAILURE_COOLDOWN_KEY);
			return parsePositiveNumber(value, DEFAULT_MODEL_FAILURE_COOLDOWN_MINUTES);
		},
		(next) => {
			modelCooldownSnapshot = next;
		},
	);
}

export async function getRuntimeEventRetentionDays(
	db: D1Database,
): Promise<number> {
	return getCachedSetting(
		runtimeEventRetentionSnapshot,
		async () => {
			const value = await readSetting(db, RUNTIME_EVENT_RETENTION_KEY);
			return parsePositiveNumber(value, DEFAULT_RUNTIME_EVENT_RETENTION_DAYS);
		},
		(next) => {
			runtimeEventRetentionSnapshot = next;
		},
	);
}

function parseRuntimeEventLevelsSetting(
	value: string | null,
): RuntimeEventLevel[] {
	if (value === null || value === undefined) {
		return [...RUNTIME_EVENT_LEVEL_VALUES];
	}
	const raw = value.trim();
	if (!raw) {
		return [];
	}
	return normalizeRuntimeEventLevels(raw.split(","));
}

export async function getRuntimeEventLevels(
	db: D1Database,
): Promise<RuntimeEventLevel[]> {
	return getCachedSetting(
		runtimeEventLevelsSnapshot,
		async () => {
			const value = await readSetting(db, RUNTIME_EVENT_LEVELS_KEY);
			return parseRuntimeEventLevelsSetting(value);
		},
		(next) => {
			runtimeEventLevelsSnapshot = next;
		},
	);
}

export async function setRuntimeEventRetentionDays(
	db: D1Database,
	days: number,
): Promise<void> {
	const value = Math.max(1, Math.floor(days)).toString();
	await upsertSetting(db, RUNTIME_EVENT_RETENTION_KEY, value);
	runtimeEventRetentionSnapshot = null;
}

export async function setRuntimeEventLevels(
	db: D1Database,
	levels: string[],
): Promise<void> {
	const normalized = normalizeRuntimeEventLevels(levels);
	await upsertSetting(db, RUNTIME_EVENT_LEVELS_KEY, normalized.join(","));
	runtimeEventLevelsSnapshot = null;
	resetRuntimeEventLevelSnapshot();
}

export async function setModelFailureCooldownMinutes(
	db: D1Database,
	minutes: number,
): Promise<void> {
	const value = Math.max(1, Math.floor(minutes)).toString();
	await upsertSetting(db, MODEL_FAILURE_COOLDOWN_KEY, value);
	modelCooldownSnapshot = null;
}

/**
 * Loads generic settings as a key/value map.
 */
export async function listSettings(
	db: D1Database,
): Promise<Record<string, string>> {
	const result = await db.prepare("SELECT key, value FROM settings").all();
	const map: Record<string, string> = {};
	for (const row of result.results ?? []) {
		map[String(row.key)] = String(row.value);
	}
	return map;
}

/**
 * Resets in-memory setting snapshots (testing utility).
 */
export function resetSettingsSnapshots(): void {
	retentionSnapshot = null;
	sessionTtlSnapshot = null;
	adminPasswordSnapshot = null;
	checkinScheduleSnapshot = null;
	modelCooldownSnapshot = null;
	runtimeEventRetentionSnapshot = null;
	runtimeEventLevelsSnapshot = null;
	cacheConfigSnapshot = null;
	settingsCacheControlSnapshot = null;
}
