import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	listCallTokens,
	replaceCallTokensForChannel,
} from "../services/channel-call-token-repo";
import {
	clearChannelModelCooldown,
	listCoolingDownModelEntriesByChannel,
} from "../services/channel-model-capabilities";
import {
	deleteChannel,
	getChannelById,
	insertChannel,
	listChannels,
	updateChannel,
} from "../services/channel-repo";
import { invalidateSelectionHotCache } from "../services/hot-kv";
import {
	buildSiteMetadata,
	parseSiteMetadata,
	type SiteType,
} from "../services/site-metadata";
import {
	recoverDisabledChannelsViaWorker,
	refreshActiveChannelsViaWorker,
	refreshChannelById,
	runCheckinAllViaWorker,
	runCheckinSingleViaWorker,
	verifyChannelById,
	verifySitesByIds,
} from "../services/site-task-dispatcher";
import { triggerBackupAfterDataChange } from "../services/backup-auto-sync";
import { generateToken } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";
import {
	buildVerificationBatchResult,
	parseSiteVerificationSummary,
} from "../services/site-verification";
import {
	normalizeCallTokens,
	type NormalizedSiteCallToken,
	type SiteCallTokenInput,
} from "../services/site-call-token-order";
import {
	listSiteTaskReports,
	saveSiteTaskReport,
} from "../services/site-task-report-store";
import { getProxyRuntimeSettings } from "../services/settings";

const sites = new Hono<AppEnv>();

type SitePayload = {
	name?: string;
	base_url?: string;
	weight?: number;
	status?: string;
	site_type?: SiteType;
	checkin_url?: string | null;
	system_token?: string;
	system_userid?: string;
	checkin_enabled?: boolean;
	call_tokens?: CallTokenPayload[];
	api_key?: string;
	checkin_token?: string;
	checkin_userid?: string;
	checkin_status?: string;
};

type CallTokenPayload = SiteCallTokenInput & {
	id?: string;
};

const parseSiteType = (value: unknown): SiteType => {
	if (
		value === "done-hub" ||
		value === "new-api" ||
		value === "subapi" ||
		value === "openai" ||
		value === "anthropic" ||
		value === "gemini"
	) {
		return value;
	}
	if (value === "custom") {
		return "subapi";
	}
	return "new-api";
};

const trimValue = (value: unknown): string => {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
};

const DEFAULT_BASE_URL_BY_TYPE: Partial<Record<SiteType, string>> = {
	openai: "https://api.openai.com",
	anthropic: "https://api.anthropic.com",
	gemini: "https://generativelanguage.googleapis.com",
};

const resolveBaseUrl = (siteType: SiteType, raw: unknown): string => {
	const trimmed = trimValue(raw);
	if (trimmed) {
		return normalizeBaseUrl(trimmed);
	}
	const fallback = DEFAULT_BASE_URL_BY_TYPE[siteType];
	if (fallback) {
		return normalizeBaseUrl(fallback);
	}
	return "";
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return value.toLowerCase() === "true";
	}
	return fallback;
};

const toCallTokenRows = (
	channelId: string,
	tokens: NormalizedSiteCallToken[],
	now: string,
) =>
	tokens.map((token) => ({
		id: generateToken("ct_"),
		channel_id: channelId,
		name: token.name,
		api_key: token.api_key,
		priority: token.priority,
		created_at: now,
		updated_at: now,
	}));

const buildSiteRecord = (
	channel: {
		id: string;
		name: string;
		base_url: string;
		api_key: string;
		weight: number;
		status: string;
		system_token?: string | null;
		system_userid?: string | null;
		checkin_enabled?: number | boolean | null;
		checkin_url?: string | null;
		last_checkin_date?: string | null;
		last_checkin_status?: string | null;
		last_checkin_message?: string | null;
		last_checkin_at?: string | null;
		metadata_json?: string | null;
		created_at?: string | null;
		updated_at?: string | null;
	},
	callTokens: Array<{
		id: string;
		name: string;
		api_key: string;
		priority?: number | null;
	}>,
	coolingModels: Array<{
		model: string;
		last_err_at: number;
		last_err_code: string | null;
		last_err_count: number;
		cooldown_count: number;
		remaining_seconds: number;
	}>,
) => {
	const metadata = parseSiteMetadata(channel.metadata_json);
	const rawEnabled = channel.checkin_enabled ?? 0;
	const checkinEnabled =
		typeof rawEnabled === "boolean" ? rawEnabled : Number(rawEnabled) === 1;
	const cooldownMaxRemainingSeconds = coolingModels.reduce(
		(max, item) => Math.max(max, Number(item.remaining_seconds ?? 0)),
		0,
	);
	return {
		id: channel.id,
		name: channel.name,
		base_url: channel.base_url,
		weight: Number(channel.weight ?? 1),
		status: channel.status,
		site_type: metadata.site_type,
		api_key: channel.api_key,
		system_token: channel.system_token ?? null,
		system_userid: channel.system_userid ?? null,
		checkin_enabled: checkinEnabled,
		checkin_id: null,
		checkin_url: channel.checkin_url ?? null,
		call_tokens: callTokens,
		last_checkin_date: channel.last_checkin_date ?? null,
		last_checkin_status: channel.last_checkin_status ?? null,
		last_checkin_message: channel.last_checkin_message ?? null,
		last_checkin_at: channel.last_checkin_at ?? null,
		verification: parseSiteVerificationSummary(channel.metadata_json),
		cooling_models: coolingModels,
		cooling_model_count: coolingModels.length,
		cooling_max_remaining_seconds: cooldownMaxRemainingSeconds,
		created_at: channel.created_at ?? null,
		updated_at: channel.updated_at ?? null,
	};
};

sites.get("/", async (c) => {
	const channels = await listChannels(c.env.DB, {
		orderBy: "created_at",
		order: "DESC",
	});
	const channelIds = channels.map((channel) => channel.id);
	const runtimeSettings = await getProxyRuntimeSettings(c.env.DB);
	const coolingModelMap = await listCoolingDownModelEntriesByChannel(
		c.env.DB,
		channelIds,
		Math.max(0, Math.floor(runtimeSettings.model_failure_cooldown_minutes)) *
			60,
		Math.max(1, Math.floor(runtimeSettings.model_failure_cooldown_threshold)),
	);
	const callTokenRows = await listCallTokens(c.env.DB, {
		channelIds,
	});
	const callTokenMap = new Map<
		string,
		Array<{
			id: string;
			name: string;
			api_key: string;
		}>
	>();
	for (const row of callTokenRows) {
		const entry = {
			id: row.id,
			name: row.name,
			api_key: row.api_key,
			priority: row.priority ?? 0,
		};
		const list = callTokenMap.get(row.channel_id) ?? [];
		list.push(entry);
		callTokenMap.set(row.channel_id, list);
	}
	const sitesList = channels.map((channel) => {
		const tokens = callTokenMap.get(channel.id) ?? [];
		const callTokens =
			tokens.length > 0
				? tokens
				: channel.api_key
					? [
							{
								id: "",
								name: "主调用令牌",
								api_key: channel.api_key,
								priority: 0,
							},
						]
					: [];
		const coolingModels = (coolingModelMap.get(channel.id) ?? []).map(
			(entry) => ({
				model: entry.model,
				last_err_at: entry.last_err_at,
				last_err_code: entry.last_err_code,
				last_err_count: entry.last_err_count,
				cooldown_count: entry.cooldown_count,
				remaining_seconds: entry.remaining_seconds,
			}),
		);
		return buildSiteRecord(channel, callTokens, coolingModels);
	});
	const taskReports = await listSiteTaskReports(c.env.DB);
	return c.json({ sites: sitesList, task_reports: taskReports });
});

sites.post("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as SitePayload | null;
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const name = trimValue(body.name);
	if (!name) {
		return jsonError(c, 400, "missing_name", "missing_name");
	}
	const id = generateToken("ch_");
	const now = nowIso();
	const siteType = parseSiteType(body.site_type);
	const baseUrl = resolveBaseUrl(siteType, body.base_url);
	if (!baseUrl) {
		return jsonError(c, 400, "missing_base_url", "missing_base_url");
	}
	const callTokens = normalizeCallTokens(body.call_tokens, body.api_key);
	if (callTokens.length === 0) {
		return jsonError(c, 400, "missing_call_tokens", "missing_call_tokens");
	}
	const systemToken = trimValue(body.system_token ?? body.checkin_token);
	const systemUser = trimValue(body.system_userid ?? body.checkin_userid);
	const checkinUrl =
		body.checkin_url !== undefined && body.checkin_url !== null
			? trimValue(body.checkin_url)
			: "";
	const checkinEnabled =
		siteType === "new-api"
			? parseBoolean(body.checkin_enabled, body.checkin_status === "active")
			: false;
	if (checkinEnabled && (!systemToken || !systemUser)) {
		return jsonError(
			c,
			400,
			"missing_checkin_credentials",
			"missing_checkin_credentials",
		);
	}
	const metadataJson = buildSiteMetadata(null, {
		site_type: siteType,
	});
	await insertChannel(c.env.DB, {
		id,
		name,
		base_url: baseUrl,
		api_key: callTokens[0].api_key,
		weight: Number(body.weight ?? 1),
		status: body.status ?? "active",
		rate_limit: 0,
		models_json: "[]",
		type: 1,
		group_name: null,
		priority: 0,
		metadata_json: metadataJson,
		system_token: systemToken || null,
		system_userid: systemUser || null,
		checkin_enabled: checkinEnabled ? 1 : 0,
		checkin_url: checkinUrl || null,
		last_checkin_date: null,
		last_checkin_status: null,
		last_checkin_message: null,
		last_checkin_at: null,
		created_at: now,
		updated_at: now,
	});
	await replaceCallTokensForChannel(
		c.env.DB,
		id,
		toCallTokenRows(id, callTokens, now),
	);
	await triggerBackupAfterDataChange(c.env.DB);

	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({ id });
});

sites.patch("/:id", async (c) => {
	const body = (await c.req.json().catch(() => null)) as SitePayload | null;
	const id = c.req.param("id");
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	const currentMetadata = parseSiteMetadata(current.metadata_json);
	const nextSiteType = body.site_type
		? parseSiteType(body.site_type)
		: currentMetadata.site_type;
	const baseUrl =
		body.base_url !== undefined
			? resolveBaseUrl(nextSiteType, body.base_url)
			: normalizeBaseUrl(String(current.base_url));
	if (!baseUrl) {
		return jsonError(c, 400, "missing_base_url", "missing_base_url");
	}
	const shouldUpdateTokens =
		body.call_tokens !== undefined || body.api_key !== undefined;
	const callTokens = shouldUpdateTokens
		? normalizeCallTokens(body.call_tokens, body.api_key ?? current.api_key)
		: [];
	if (shouldUpdateTokens && callTokens.length === 0) {
		return jsonError(c, 400, "missing_call_tokens", "missing_call_tokens");
	}
	const metadataJson =
		body.site_type !== undefined
			? buildSiteMetadata(current.metadata_json, {
					site_type: nextSiteType,
				})
			: (current.metadata_json ?? null);
	const nextSystemToken =
		body.system_token !== undefined || body.checkin_token !== undefined
			? trimValue(body.system_token ?? body.checkin_token)
			: trimValue(current.system_token ?? "");
	const nextSystemUser =
		body.system_userid !== undefined || body.checkin_userid !== undefined
			? trimValue(body.system_userid ?? body.checkin_userid)
			: trimValue(current.system_userid ?? "");
	const nextCheckinUrl =
		body.checkin_url !== undefined
			? body.checkin_url !== null
				? trimValue(body.checkin_url)
				: ""
			: trimValue(current.checkin_url ?? "");
	const currentCheckinEnabled =
		typeof current.checkin_enabled === "boolean"
			? current.checkin_enabled
			: Number(current.checkin_enabled ?? 0) === 1;
	const nextCheckinEnabled =
		nextSiteType === "new-api"
			? body.checkin_enabled !== undefined || body.checkin_status !== undefined
				? parseBoolean(body.checkin_enabled, body.checkin_status === "active")
				: currentCheckinEnabled
			: false;
	if (nextCheckinEnabled && (!nextSystemToken || !nextSystemUser)) {
		return jsonError(
			c,
			400,
			"missing_checkin_credentials",
			"missing_checkin_credentials",
		);
	}

	await updateChannel(c.env.DB, id, {
		name: body.name ?? current.name,
		base_url: baseUrl,
		api_key: shouldUpdateTokens ? callTokens[0].api_key : current.api_key,
		weight: Number(body.weight ?? current.weight ?? 1),
		status: body.status ?? current.status,
		rate_limit: current.rate_limit ?? 0,
		models_json: current.models_json ?? "[]",
		type: current.type ?? 1,
		group_name: current.group_name ?? null,
		priority: current.priority ?? 0,
		metadata_json: metadataJson,
		system_token: nextSystemToken || null,
		system_userid: nextSystemUser || null,
		checkin_enabled: nextCheckinEnabled ? 1 : 0,
		checkin_url: nextCheckinUrl || null,
		last_checkin_date: current.last_checkin_date ?? null,
		last_checkin_status: current.last_checkin_status ?? null,
		last_checkin_message: current.last_checkin_message ?? null,
		last_checkin_at: current.last_checkin_at ?? null,
		updated_at: nowIso(),
	});
	if (shouldUpdateTokens) {
		await replaceCallTokensForChannel(
			c.env.DB,
			id,
			toCallTokenRows(id, callTokens, nowIso()),
		);
	}
	await triggerBackupAfterDataChange(c.env.DB);

	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({ ok: true });
});

sites.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await deleteChannel(c.env.DB, id);
	await triggerBackupAfterDataChange(c.env.DB);
	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({ ok: true });
});

sites.post("/checkin-all", async (c) => {
	const result = await runCheckinAllViaWorker(c.env.DB, c.env, new Date());
	await saveSiteTaskReport(c.env.DB, {
		kind: "checkin",
		runs_at: result.runsAt,
		summary: result.summary,
		items: result.results,
	});
	return c.json({
		results: result.results,
		summary: result.summary,
		runs_at: result.runsAt,
	});
});

sites.post("/:id/verify", async (c) => {
	const id = c.req.param("id");
	const result = await verifyChannelById(c.env.DB, id);
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json(result);
});

sites.post("/:id/cooling-models/reset", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => null)) as {
		model?: string;
	} | null;
	const model = String(body?.model ?? "").trim();
	if (!model) {
		return jsonError(c, 400, "missing_model", "missing_model");
	}
	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	const cleared = await clearChannelModelCooldown(c.env.DB, id, model);
	return c.json({ ok: true, cleared });
});

sites.post("/verify-batch", async (c) => {
	const body = await c.req.json().catch(() => null);
	const ids = Array.isArray(body?.ids)
		? body.ids
				.map((item: unknown) => String(item ?? "").trim())
				.filter((item: string) => item.length > 0)
		: undefined;
	const result = await verifySitesByIds(c.env.DB, ids);
	await saveSiteTaskReport(c.env.DB, {
		kind: "verify-active",
		runs_at: result.runs_at,
		report: result,
	});
	if (result.items.length > 0) {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	return c.json(result);
});

sites.post("/probe-recovery", async (c) => {
	const runsAt = new Date().toISOString();
	const result = await recoverDisabledChannelsViaWorker(c.env.DB, c.env);
	if (result.recovered > 0) {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	return c.json({
		summary: {
			total: result.total,
			attempted: result.attempted,
			recovered: result.recovered,
			failed: result.failed,
		},
		items: result.items,
		runs_at: runsAt,
	});
});

sites.post("/recovery-evaluate", async (c) => {
	const result = await recoverDisabledChannelsViaWorker(c.env.DB, c.env);
	if (result.recovered > 0) {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	const verificationItems = result.items
		.map((item) => item.verification)
		.filter(
			(
				item,
			): item is NonNullable<(typeof result.items)[number]["verification"]> =>
				Boolean(item),
		);
	const report = await buildVerificationBatchResult(verificationItems);
	await saveSiteTaskReport(c.env.DB, {
		kind: "verify-disabled",
		runs_at: report.runs_at,
		report,
	});
	return c.json(report);
});

sites.post("/refresh-active", async (c) => {
	const result = await refreshActiveChannelsViaWorker(c.env.DB, c.env);
	const report = {
		summary: result.summary,
		items: result.items,
		runs_at: result.runsAt,
	};
	await saveSiteTaskReport(c.env.DB, {
		kind: "refresh-active",
		runs_at: report.runs_at,
		report,
	});
	if (result.summary.success > 0) {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	return c.json(report);
});

sites.post("/:id/checkin", async (c) => {
	const id = c.req.param("id");
	const result = await runCheckinSingleViaWorker(
		c.env.DB,
		c.env,
		id,
		new Date(),
	);
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	return c.json({
		result: result.result,
		runs_at: result.runsAt,
	});
});

sites.post("/:id/refresh", async (c) => {
	const id = c.req.param("id");
	const result = await refreshChannelById(c.env.DB, c.env, id);
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	if (result.status === "success") {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	return c.json(result);
});

export default sites;
