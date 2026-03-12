import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listVerifiedModelEntries } from "../services/channel-model-capabilities";
import { listActiveChannels } from "../services/channel-repo";
import { getModelCapabilityTtlHours } from "../services/settings";

const models = new Hono<AppEnv>();

/**
 * Returns aggregated models from all channels.
 */
models.get("/", async (c) => {
	const channels = await listActiveChannels(c.env.DB);
	const ttlHours = await getModelCapabilityTtlHours(c.env.DB);
	const ttlSeconds = Math.max(1, Math.floor(ttlHours)) * 60 * 60;
	const entries = await listVerifiedModelEntries(
		c.env.DB,
		channels.map((channel) => ({ id: channel.id, name: channel.name })),
		ttlSeconds,
	);

	const map = new Map<
		string,
		{ id: string; channels: { id: string; name: string }[] }
	>();
	for (const entry of entries) {
		const existing = map.get(entry.id) ?? { id: entry.id, channels: [] };
		existing.channels.push({ id: entry.channelId, name: entry.channelName });
		map.set(entry.id, existing);
	}

	return c.json({
		models: Array.from(map.values()),
	});
});

export default models;
