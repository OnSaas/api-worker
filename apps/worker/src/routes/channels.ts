import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listCallTokens } from "../services/channel-call-token-repo";
import { modelsToJson } from "../services/channel-models";
import {
	channelExists,
	deleteChannel,
	getChannelById,
	insertChannel,
	listChannels,
	updateChannel,
} from "../services/channel-repo";
import {
	testChannelTokens,
	updateChannelTestResult,
} from "../services/channel-testing";
import { generateToken } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { safeJsonParse } from "../utils/json";
import { nowIso } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";

const channels = new Hono<AppEnv>();

type ChannelPayload = {
	id?: string | number;
	channel_id?: string | number;
	channelId?: string | number;
	name?: string;
	base_url?: string;
	api_key?: string;
	weight?: number;
	status?: string;
	rate_limit?: number;
	models?: unknown[];
	system_token?: string;
	system_userid?: string;
	checkin_enabled?: boolean;
	checkin_url?: string;
};

/**
 * Resolves a channel id from request payload.
 *
 * Args:
 *   body: Request payload.
 *
 * Returns:
 *   Channel id if provided.
 */
function resolveChannelId(body: ChannelPayload | null): string | null {
	const candidate = body?.id ?? body?.channel_id ?? body?.channelId;
	if (!candidate) {
		return null;
	}
	const normalized = String(candidate).trim();
	return normalized.length > 0 ? normalized : null;
}

/**
 * Lists all channels.
 */
channels.get("/", async (c) => {
	const rows = await listChannels(c.env.DB, {
		orderBy: "created_at",
		order: "DESC",
	});
	return c.json({ channels: rows });
});

/**
 * Creates a new channel.
 */
channels.post("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as ChannelPayload | null;
	if (!body?.name || !body?.base_url || !body?.api_key) {
		return jsonError(c, 400, "missing_fields", "missing_fields");
	}

	const requestedId = resolveChannelId(body);
	if (requestedId) {
		const exists = await channelExists(c.env.DB, requestedId);
		if (exists) {
			return jsonError(c, 409, "channel_id_exists", "channel_id_exists");
		}
	}

	const id = requestedId ?? generateToken("ch_");
	const now = nowIso();

	await insertChannel(c.env.DB, {
		id,
		name: body.name,
		base_url: normalizeBaseUrl(String(body.base_url)),
		api_key: body.api_key,
		weight: Number(body.weight ?? 1),
		status: body.status ?? "active",
		rate_limit: body.rate_limit ?? 0,
		models_json: JSON.stringify(body.models ?? []),
		type: 1,
		group_name: null,
		priority: 0,
		metadata_json: null,
		created_at: now,
		updated_at: now,
	});

	return c.json({ id });
});

/**
 * Updates a channel.
 */
channels.patch("/:id", async (c) => {
	const body = (await c.req.json().catch(() => null)) as ChannelPayload | null;
	const id = c.req.param("id");
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}

	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "channel_not_found", "channel_not_found");
	}

	const models = body.models ?? safeJsonParse(current.models_json, []);

	await updateChannel(c.env.DB, id, {
		name: body.name ?? current.name,
		base_url: normalizeBaseUrl(String(body.base_url ?? current.base_url)),
		api_key: body.api_key ?? current.api_key,
		weight: Number(body.weight ?? current.weight ?? 1),
		status: body.status ?? current.status,
		rate_limit: body.rate_limit ?? current.rate_limit ?? 0,
		models_json: JSON.stringify(models),
		type: current.type ?? 1,
		group_name: current.group_name ?? null,
		priority: current.priority ?? 0,
		metadata_json: current.metadata_json ?? null,
		system_token: body.system_token ?? current.system_token ?? null,
		system_userid: body.system_userid ?? current.system_userid ?? null,
		checkin_enabled: body.checkin_enabled ?? current.checkin_enabled ?? 0,
		checkin_url: body.checkin_url ?? current.checkin_url ?? null,
		last_checkin_date: current.last_checkin_date ?? null,
		last_checkin_status: current.last_checkin_status ?? null,
		last_checkin_message: current.last_checkin_message ?? null,
		last_checkin_at: current.last_checkin_at ?? null,
		updated_at: nowIso(),
	});

	return c.json({ ok: true });
});

/**
 * Deletes a channel.
 */
channels.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await deleteChannel(c.env.DB, id);
	return c.json({ ok: true });
});

/**
 * Tests channel connectivity and updates model list.
 */
channels.post("/:id/test", async (c) => {
	const id = c.req.param("id");
	const channel = await getChannelById(c.env.DB, id);
	if (!channel) {
		return jsonError(c, 404, "channel_not_found", "channel_not_found");
	}

	const callTokenRows = await listCallTokens(c.env.DB, {
		channelIds: [id],
	});
	const tokens =
		callTokenRows.length > 0
			? callTokenRows.map((row) => ({
					id: row.id,
					name: row.name,
					api_key: row.api_key,
				}))
			: [
					{
						id: "primary",
						name: "主调用令牌",
						api_key: String(channel.api_key),
					},
				];

	const summary = await testChannelTokens(String(channel.base_url), tokens);
	if (!summary.ok) {
		await updateChannelTestResult(c.env.DB, id, {
			ok: false,
			elapsed: summary.elapsed,
		});
		return jsonError(c, 502, "channel_unreachable", "channel_unreachable");
	}

	const models = summary.models.map((id) => ({ id }));
	await updateChannelTestResult(c.env.DB, id, {
		ok: true,
		elapsed: summary.elapsed,
		models: summary.models,
		modelsJson: modelsToJson(summary.models),
	});

	return c.json({
		ok: true,
		models,
		token_summary: {
			total: summary.total,
			success: summary.success,
			failed: summary.failed,
		},
	});
});

export default channels;
