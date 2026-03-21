import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	getCheckinSchedulerStub,
	shouldResetLastRun,
} from "../services/checkin-scheduler";
import {
	RUNTIME_EVENT_LEVEL_VALUES,
	recordRuntimeEvent,
} from "../services/runtime-events";
import {
	bumpCacheVersions,
	getCacheConfig,
	getCheckinScheduleTime,
	getModelFailureCooldownMinutes,
	getProxyRuntimeSettings,
	getRetentionDays,
	getRuntimeEventLevels,
	getRuntimeEventRetentionDays,
	getRuntimeProxyConfig,
	getSessionTtlHours,
	isAdminPasswordSet,
	setAdminPasswordHash,
	setCacheConfig,
	setCheckinScheduleTime,
	setModelFailureCooldownMinutes,
	setProxyRuntimeSettings,
	setRetentionDays,
	setRuntimeEventLevels,
	setRuntimeEventRetentionDays,
	setSessionTtlHours,
} from "../services/settings";
import {
	getUsageLimiterStub,
	getUsageQueueStatus,
} from "../services/usage-limiter";
import { sha256Hex } from "../utils/crypto";
import { jsonError } from "../utils/http";

const settings = new Hono<AppEnv>();

/**
 * Returns settings values.
 */
settings.get("/", async (c) => {
	const retention = await getRetentionDays(c.env.DB);
	const sessionTtlHours = await getSessionTtlHours(c.env.DB);
	const adminPasswordSet = await isAdminPasswordSet(c.env.DB);
	const checkinScheduleTime = await getCheckinScheduleTime(c.env.DB);
	const modelFailureCooldownMinutes = await getModelFailureCooldownMinutes(
		c.env.DB,
	);
	const runtimeEventRetentionDays = await getRuntimeEventRetentionDays(
		c.env.DB,
	);
	const runtimeEventLevels = await getRuntimeEventLevels(c.env.DB);
	const runtimeSettings = await getProxyRuntimeSettings(c.env.DB);
	const runtimeConfig = getRuntimeProxyConfig(c.env, runtimeSettings);
	const cacheConfig = await getCacheConfig(c.env.DB, c.env.CACHE_VERSION_STORE);
	let usageQueueStatus: {
		count: number | null;
		date: string | null;
		limit: number;
		enabled: boolean;
		bound: boolean;
		active: boolean;
	} | null = null;
	if (c.env.USAGE_LIMITER) {
		try {
			const status = await getUsageQueueStatus(
				getUsageLimiterStub(c.env.USAGE_LIMITER),
			);
			usageQueueStatus = {
				count: status.count,
				date: status.date,
				limit: runtimeSettings.usage_queue_daily_limit,
				enabled: runtimeSettings.usage_queue_enabled,
				bound: runtimeConfig.usage_queue_bound,
				active: runtimeConfig.usage_queue_active,
			};
		} catch (error) {
			await recordRuntimeEvent(c.env.DB, {
				level: "warning",
				code: "settings_usage_queue_status_failed",
				message: "settings_usage_queue_status_failed",
				requestPath: c.req.path,
				method: c.req.method,
				context: {
					error: error instanceof Error ? error.message : String(error),
				},
			}).catch(() => undefined);
		}
	} else {
		usageQueueStatus = {
			count: null,
			date: null,
			limit: runtimeSettings.usage_queue_daily_limit,
			enabled: runtimeSettings.usage_queue_enabled,
			bound: runtimeConfig.usage_queue_bound,
			active: runtimeConfig.usage_queue_active,
		};
	}
	return c.json({
		log_retention_days: retention,
		session_ttl_hours: sessionTtlHours,
		admin_password_set: adminPasswordSet,
		checkin_schedule_time: checkinScheduleTime,
		model_failure_cooldown_minutes: modelFailureCooldownMinutes,
		runtime_event_retention_days: runtimeEventRetentionDays,
		runtime_event_levels: runtimeEventLevels,
		runtime_config: runtimeConfig,
		runtime_settings: runtimeSettings,
		cache_config: cacheConfig,
		usage_queue_status: usageQueueStatus,
	});
});

/**
 * Updates settings values.
 */
settings.put("/", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body) {
		return jsonError(c, 400, "settings_required", "settings_required");
	}

	let touched = false;
	let cacheTouched = false;
	let runtimeTouched = false;
	const cachePatch: {
		enabled?: boolean;
		dashboardTtlSeconds?: number;
		usageTtlSeconds?: number;
		modelsTtlSeconds?: number;
		tokensTtlSeconds?: number;
		channelsTtlSeconds?: number;
		callTokensTtlSeconds?: number;
		settingsTtlSeconds?: number;
	} = {};
	const runtimePatch: {
		upstream_timeout_ms?: number;
		retry_max_retries?: number;
		stream_usage_mode?: string;
		stream_usage_max_bytes?: number;
		stream_usage_max_parsers?: number;
		usage_queue_enabled?: boolean;
		usage_queue_daily_limit?: number;
		usage_queue_direct_write_ratio?: number;
	} = {};
	let scheduleTouched = false;
	let scheduleReset = false;

	if (body.log_retention_days !== undefined) {
		const days = Number(body.log_retention_days);
		if (Number.isNaN(days) || days < 1) {
			return jsonError(
				c,
				400,
				"invalid_log_retention_days",
				"invalid_log_retention_days",
			);
		}
		await setRetentionDays(c.env.DB, days);
		touched = true;
	}

	if (body.session_ttl_hours !== undefined) {
		const hours = Number(body.session_ttl_hours);
		if (Number.isNaN(hours) || hours < 1) {
			return jsonError(
				c,
				400,
				"invalid_session_ttl_hours",
				"invalid_session_ttl_hours",
			);
		}
		await setSessionTtlHours(c.env.DB, hours);
		touched = true;
	}

	if (body.model_failure_cooldown_minutes !== undefined) {
		const minutes = Number(body.model_failure_cooldown_minutes);
		if (Number.isNaN(minutes) || minutes < 1) {
			return jsonError(
				c,
				400,
				"invalid_model_failure_cooldown_minutes",
				"invalid_model_failure_cooldown_minutes",
			);
		}
		await setModelFailureCooldownMinutes(c.env.DB, minutes);
		touched = true;
	}

	if (body.runtime_event_retention_days !== undefined) {
		const days = Number(body.runtime_event_retention_days);
		if (Number.isNaN(days) || days < 1) {
			return jsonError(
				c,
				400,
				"invalid_runtime_event_retention_days",
				"invalid_runtime_event_retention_days",
			);
		}
		await setRuntimeEventRetentionDays(c.env.DB, days);
		touched = true;
	}

	if (body.runtime_event_levels !== undefined) {
		let levelsRaw: string[] | null = null;
		if (Array.isArray(body.runtime_event_levels)) {
			levelsRaw = body.runtime_event_levels.map((item: unknown) =>
				String(item),
			);
		} else if (typeof body.runtime_event_levels === "string") {
			levelsRaw = body.runtime_event_levels.split(",");
		} else if (body.runtime_event_levels === null) {
			levelsRaw = [];
		}
		if (!levelsRaw) {
			return jsonError(
				c,
				400,
				"invalid_runtime_event_levels",
				"invalid_runtime_event_levels",
			);
		}
		const allowedLevels = new Set<string>(RUNTIME_EVENT_LEVEL_VALUES);
		const normalizedLevels = levelsRaw
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean);
		if (normalizedLevels.some((level) => !allowedLevels.has(level))) {
			return jsonError(
				c,
				400,
				"invalid_runtime_event_levels",
				"invalid_runtime_event_levels",
			);
		}
		await setRuntimeEventLevels(c.env.DB, normalizedLevels);
		touched = true;
	}

	if (body.cache_enabled !== undefined) {
		const raw = body.cache_enabled;
		let enabled: boolean | null = null;
		if (typeof raw === "boolean") {
			enabled = raw;
		} else if (typeof raw === "number") {
			enabled = raw !== 0;
		} else if (typeof raw === "string") {
			const normalized = raw.trim().toLowerCase();
			if (["1", "true", "yes", "on"].includes(normalized)) {
				enabled = true;
			} else if (["0", "false", "no", "off"].includes(normalized)) {
				enabled = false;
			}
		}
		if (enabled === null) {
			return jsonError(
				c,
				400,
				"invalid_cache_enabled",
				"invalid_cache_enabled",
			);
		}
		cachePatch.enabled = enabled;
		cacheTouched = true;
	}

	if (body.cache_ttl_dashboard_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_dashboard_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_dashboard_seconds",
				"invalid_cache_ttl_dashboard_seconds",
			);
		}
		cachePatch.dashboardTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.cache_ttl_usage_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_usage_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_usage_seconds",
				"invalid_cache_ttl_usage_seconds",
			);
		}
		cachePatch.usageTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.cache_ttl_models_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_models_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_models_seconds",
				"invalid_cache_ttl_models_seconds",
			);
		}
		cachePatch.modelsTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.cache_ttl_tokens_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_tokens_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_tokens_seconds",
				"invalid_cache_ttl_tokens_seconds",
			);
		}
		cachePatch.tokensTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.cache_ttl_channels_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_channels_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_channels_seconds",
				"invalid_cache_ttl_channels_seconds",
			);
		}
		cachePatch.channelsTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.cache_ttl_call_tokens_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_call_tokens_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_call_tokens_seconds",
				"invalid_cache_ttl_call_tokens_seconds",
			);
		}
		cachePatch.callTokensTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.cache_ttl_settings_seconds !== undefined) {
		const ttl = Number(body.cache_ttl_settings_seconds);
		if (Number.isNaN(ttl) || ttl < 0) {
			return jsonError(
				c,
				400,
				"invalid_cache_ttl_settings_seconds",
				"invalid_cache_ttl_settings_seconds",
			);
		}
		cachePatch.settingsTtlSeconds = Math.floor(ttl);
		cacheTouched = true;
	}

	if (body.proxy_upstream_timeout_ms !== undefined) {
		const timeoutMs = Number(body.proxy_upstream_timeout_ms);
		if (Number.isNaN(timeoutMs) || timeoutMs < 0) {
			return jsonError(
				c,
				400,
				"invalid_proxy_upstream_timeout_ms",
				"invalid_proxy_upstream_timeout_ms",
			);
		}
		runtimePatch.upstream_timeout_ms = Math.floor(timeoutMs);
		runtimeTouched = true;
	}

	if (body.proxy_retry_max_retries !== undefined) {
		const retryMaxRetries = Number(body.proxy_retry_max_retries);
		if (
			Number.isNaN(retryMaxRetries) ||
			retryMaxRetries < 0 ||
			!Number.isInteger(retryMaxRetries)
		) {
			return jsonError(
				c,
				400,
				"invalid_proxy_retry_max_retries",
				"invalid_proxy_retry_max_retries",
			);
		}
		runtimePatch.retry_max_retries = retryMaxRetries;
		runtimeTouched = true;
	}

	if (body.proxy_stream_usage_mode !== undefined) {
		const mode = String(body.proxy_stream_usage_mode).trim().toLowerCase();
		if (!["full", "lite", "off"].includes(mode)) {
			return jsonError(
				c,
				400,
				"invalid_proxy_stream_usage_mode",
				"invalid_proxy_stream_usage_mode",
			);
		}
		runtimePatch.stream_usage_mode = mode;
		runtimeTouched = true;
	}

	if (body.proxy_stream_usage_max_bytes !== undefined) {
		const maxBytes = Number(body.proxy_stream_usage_max_bytes);
		if (Number.isNaN(maxBytes) || maxBytes < 0) {
			return jsonError(
				c,
				400,
				"invalid_proxy_stream_usage_max_bytes",
				"invalid_proxy_stream_usage_max_bytes",
			);
		}
		runtimePatch.stream_usage_max_bytes = Math.floor(maxBytes);
		runtimeTouched = true;
	}

	if (body.proxy_stream_usage_max_parsers !== undefined) {
		const maxParsers = Number(body.proxy_stream_usage_max_parsers);
		if (Number.isNaN(maxParsers) || maxParsers < 0) {
			return jsonError(
				c,
				400,
				"invalid_proxy_stream_usage_max_parsers",
				"invalid_proxy_stream_usage_max_parsers",
			);
		}
		runtimePatch.stream_usage_max_parsers = Math.floor(maxParsers);
		runtimeTouched = true;
	}

	if (body.proxy_usage_queue_enabled !== undefined) {
		const raw = body.proxy_usage_queue_enabled;
		let enabled: boolean | null = null;
		if (typeof raw === "boolean") {
			enabled = raw;
		} else if (typeof raw === "number") {
			enabled = raw !== 0;
		} else if (typeof raw === "string") {
			const normalized = raw.trim().toLowerCase();
			if (["1", "true", "yes", "on"].includes(normalized)) {
				enabled = true;
			} else if (["0", "false", "no", "off"].includes(normalized)) {
				enabled = false;
			}
		}
		if (enabled === null) {
			return jsonError(
				c,
				400,
				"invalid_proxy_usage_queue_enabled",
				"invalid_proxy_usage_queue_enabled",
			);
		}
		runtimePatch.usage_queue_enabled = enabled;
		runtimeTouched = true;
	}

	if (body.usage_queue_daily_limit !== undefined) {
		const limit = Number(body.usage_queue_daily_limit);
		if (Number.isNaN(limit) || limit < 0) {
			return jsonError(
				c,
				400,
				"invalid_usage_queue_daily_limit",
				"invalid_usage_queue_daily_limit",
			);
		}
		runtimePatch.usage_queue_daily_limit = Math.floor(limit);
		runtimeTouched = true;
	}

	if (body.usage_queue_direct_write_ratio !== undefined) {
		const ratio = Number(body.usage_queue_direct_write_ratio);
		if (Number.isNaN(ratio) || ratio < 0 || ratio > 1) {
			return jsonError(
				c,
				400,
				"invalid_usage_queue_direct_write_ratio",
				"invalid_usage_queue_direct_write_ratio",
			);
		}
		runtimePatch.usage_queue_direct_write_ratio = ratio;
		runtimeTouched = true;
	}

	if (typeof body.admin_password === "string" && body.admin_password.trim()) {
		const hash = await sha256Hex(body.admin_password.trim());
		await setAdminPasswordHash(c.env.DB, hash);
		touched = true;
	}

	if (body.checkin_schedule_time !== undefined) {
		const currentTime = await getCheckinScheduleTime(c.env.DB);
		const timeValue = String(body.checkin_schedule_time).trim();
		if (!/^\d{2}:\d{2}$/.test(timeValue)) {
			return jsonError(
				c,
				400,
				"invalid_checkin_schedule_time",
				"invalid_checkin_schedule_time",
			);
		}
		const [hour, minute] = timeValue.split(":").map((value) => Number(value));
		if (
			Number.isNaN(hour) ||
			Number.isNaN(minute) ||
			hour < 0 ||
			hour > 23 ||
			minute < 0 ||
			minute > 59
		) {
			return jsonError(
				c,
				400,
				"invalid_checkin_schedule_time",
				"invalid_checkin_schedule_time",
			);
		}
		await setCheckinScheduleTime(c.env.DB, timeValue);
		touched = true;
		scheduleTouched = true;
		scheduleReset = shouldResetLastRun(currentTime, timeValue);
	}

	if (cacheTouched) {
		await setCacheConfig(c.env.DB, cachePatch, c.env.CACHE_VERSION_STORE);
		touched = true;
	}

	if (runtimeTouched) {
		await setProxyRuntimeSettings(
			c.env.DB,
			runtimePatch,
			c.env.CACHE_VERSION_STORE,
		);
		touched = true;
	}

	if (!touched) {
		return jsonError(c, 400, "settings_empty", "settings_empty");
	}

	if (scheduleTouched) {
		const scheduler = getCheckinSchedulerStub(c.env.CHECKIN_SCHEDULER);
		await scheduler.fetch("https://checkin-scheduler/reschedule", {
			method: "POST",
			...(scheduleReset ? { body: JSON.stringify({ reset: true }) } : {}),
		});
	}

	return c.json({ ok: true });
});

settings.post("/cache/refresh", async (c) => {
	await bumpCacheVersions(
		c.env.DB,
		[
			"dashboard",
			"usage",
			"models",
			"tokens",
			"channels",
			"call_tokens",
			"settings",
		],
		c.env.CACHE_VERSION_STORE,
	);
	return c.json({ ok: true });
});

export default settings;
